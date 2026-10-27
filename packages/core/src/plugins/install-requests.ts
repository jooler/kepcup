import { sanitizeDisplayText, type PluginIndexEntry, type SetupRequirement } from '@kepcup/shared';
import { compareConnectorVersions } from '../apps/directory-merge.js';
import type { Clock } from '../infra/clock.js';
import type { MarketplaceService } from './marketplace-service.js';
import type { MarketplaceSync } from './marketplace-sync.js';
import type { PluginRegistry } from './registry.js';

/**
 * Bot 发起插件安装（D104 P1-3，设计 51 §6.3）。
 *
 * Bot 只能**检索官方市场**并**提议安装 `verified` 级插件**：`plugin_search` 只读，
 * `plugin_request_install` 校验后把 `confirm-plugin-install` 需求交给 orchestrator 写进
 * 本 run 的 setupHit（工具返回 SETUP_REQUIRED → run 中断 → 对话里出确认卡 → 用户确认安装后
 * `runs.retry` 续跑）。
 *
 * 限频先于任何校验（失败也计数），与 `LocalConnectors.#rateLimit` 同一思路：Bot 不能靠反复
 * 试探把确认卡刷屏，也不能用失败请求撬出市场里的条目细节。
 */

/** 同一 run 内最多请求几次（含失败）。 */
const REQUESTS_PER_RUN_MAX = 5;
/** 同一对话每小时最多请求几次（含失败）。 */
const REQUESTS_PER_CONVERSATION_HOURLY_MAX = 20;
const HOUR_MS = 3_600_000;
/** run 计数的裁剪上限（只保留最近的若干 run）。 */
const RUN_COUNT_LIMIT = 200;
/** 对话限频表的键上限（超过时清掉一小时前的旧键）。 */
const CONVERSATION_KEY_LIMIT = 500;
/** 搜索结果的条数上限。 */
const SEARCH_HITS_MAX = 10;
/** 搜索时给模型看的描述长度（超出的截断）。 */
const SEARCH_DESCRIPTION_MAX = 120;
/** 与 `setupRequirementSchema` 的 `confirm-plugin-install` 成员一致（UTF-16 码元）。 */
const REQUIREMENT_NAME_MAX = 100;
const REQUIREMENT_REASON_MAX = 300;

/**
 * `sanitizeDisplayText` 按码点截断，而 zod 的 `.max()` 按 UTF-16 码元计：星面字符（emoji 等）
 * 占两个码元，只按码点截会让需求对象过不了 schema（run 列表 / retry 的 RPC 输出校验失败）。
 * 这里再按码元预算收一刀，不劈开代理对。
 */
function fitUtf16(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out.trimEnd();
}

/** 清洗并限长到 schema 允许的码元数。 */
function displayField(text: string, max: number): string {
  return fitUtf16(sanitizeDisplayText(text, max), max);
}

export interface PluginToolContext {
  botId: string | null;
  conversationId: string | null;
  runId: string | null;
}

export interface PluginSearchHit {
  id: string;
  version: string;
  name: string;
  description: string;
  categories: string[];
}

export interface PluginInstallRequestsDeps {
  marketplace: Pick<MarketplaceService, 'current' | 'isOfficial'>;
  registry: Pick<PluginRegistry, 'list'>;
  clock: Clock;
  appVersion: string;
  platform?: NodeJS.Platform | undefined;
}

export class PluginInstallRequests {
  readonly #deps: PluginInstallRequestsDeps;
  /** runId → 已请求次数（含失败）。 */
  readonly #runCounts = new Map<string, number>();
  /** conversationId → 最近一小时内的请求时刻。 */
  readonly #conversationHits = new Map<string, number[]>();

  constructor(deps: PluginInstallRequestsDeps) {
    this.#deps = deps;
  }

  /**
   * 只读检索：官方市场里 `verified` 级、兼容、未被撤销的条目（每个 id 取最高兼容版本），
   * 按 query 切词后对 id / name / description / categories 做大小写不敏感匹配。
   * 市场未启用时返回空数组（搜索本身不改变任何状态，模型只需知道没有结果）。
   */
  search(query: string): PluginSearchHit[] {
    const sync = this.#officialSync();
    if (sync === null) return [];
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0);
    if (terms.length === 0) return [];
    const hits: PluginSearchHit[] = [];
    for (const entry of this.#verifiedEntries(sync)) {
      if (hits.length >= SEARCH_HITS_MAX) break;
      const haystack = [
        entry.id,
        entry.summary.name,
        entry.summary.description,
        ...entry.categories,
      ]
        .join('\n')
        .toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;
      hits.push({
        id: entry.id,
        version: entry.version,
        name: sanitizeDisplayText(entry.summary.name, 100),
        description: sanitizeDisplayText(entry.summary.description, SEARCH_DESCRIPTION_MAX),
        categories: [...entry.categories],
      });
    }
    return hits;
  }

  /**
   * 校验并限频；通过时返回要放进 run.setup 的需求。失败一律 `{ ok:false, message }`，
   * 文案固定、不回显索引原文。顺序：限频 → 市场可用 → 条目存在 → verified → 撤销 / 不兼容
   * → 已装 → 清洗后的需求。
   */
  request(
    input: { pluginId: string; version?: string | undefined; reason: string },
    context: PluginToolContext,
  ):
    | { ok: true; requirement: Extract<SetupRequirement, { kind: 'confirm-plugin-install' }> }
    | { ok: false; message: string } {
    const limited = this.#rateLimit(context);
    if (limited !== null) return { ok: false, message: limited };

    const sync = this.#officialSync();
    if (sync === null) {
      return { ok: false, message: '插件市场未启用，或当前不是官方市场。' };
    }
    const appVersion = this.#deps.appVersion;
    const platform = this.#deps.platform ?? process.platform;
    // 无 version 时优先从与 search 相同的 verified 候选集里取，避免 search 展示旧版本、
    // request 却按「最高版本」解析到更新的 community / 撤销版本；候选集为空时再回落到
    // 普通 find，让下面按固定文案报出 community / 撤销 / 不兼容，而不是笼统的「没有」。
    const preferred =
      input.version === undefined
        ? this.#verifiedEntries(sync).find((item) => item.id === input.pluginId)
        : undefined;
    const entry =
      preferred ??
      sync.find(input.pluginId, {
        ...(input.version !== undefined ? { version: input.version } : {}),
        appVersion,
        platform,
      });
    if (entry === null) {
      return { ok: false, message: '官方市场里没有这个插件。' };
    }
    if (entry.tier !== 'verified') {
      return { ok: false, message: '只有官方认证的插件可以由 Bot 提议安装。' };
    }
    if (sync.revocationOf(entry.id, entry.version) !== null) {
      return { ok: false, message: '该插件版本已被撤销，不能安装。' };
    }
    if (sync.incompatibleReason(entry, appVersion, platform) !== null) {
      return { ok: false, message: '该插件与当前 KepCup 版本或操作系统不兼容。' };
    }
    const installed = this.#deps.registry.list().find((plugin) => plugin.id === entry.id);
    if (installed !== undefined) {
      return {
        ok: false,
        message: `已经安装了该插件（v${installed.version}），无需再次请求。`,
      };
    }
    const reason = displayField(input.reason, REQUIREMENT_REASON_MAX);
    if (reason.length === 0) {
      return { ok: false, message: '请说明为什么需要这个插件（给用户看的一句话）。' };
    }
    // 索引里的名称清洗后可能为空（全是不可见字符）；schema 要求 name 非空，退回到 id。
    const name = displayField(entry.summary.name, REQUIREMENT_NAME_MAX);
    return {
      ok: true,
      requirement: {
        kind: 'confirm-plugin-install',
        pluginId: entry.id,
        version: entry.version,
        name: name.length > 0 ? name : fitUtf16(entry.id, REQUIREMENT_NAME_MAX),
        reason,
      },
    };
  }

  /** 当前生效的市场同步器；非官方市场或未启用时为 null。 */
  #officialSync(): MarketplaceSync | null {
    if (!this.#deps.marketplace.isOfficial()) return null;
    return this.#deps.marketplace.current();
  }

  /** 官方索引里 verified / 兼容 / 未被撤销的条目（每个 id 取最高兼容版本）。 */
  #verifiedEntries(sync: MarketplaceSync): PluginIndexEntry[] {
    const appVersion = this.#deps.appVersion;
    const platform = this.#deps.platform ?? process.platform;
    const byId = new Map<string, PluginIndexEntry>();
    for (const entry of sync.entries()) {
      if (entry.tier !== 'verified') continue;
      if (sync.revocationOf(entry.id, entry.version) !== null) continue;
      if (sync.incompatibleReason(entry, appVersion, platform) !== null) continue;
      const current = byId.get(entry.id);
      if (
        current === undefined ||
        (compareConnectorVersions(entry.version, current.version) ?? 0) > 0
      ) {
        byId.set(entry.id, entry);
      }
    }
    return [...byId.values()];
  }

  /** 限频：先于任何校验（失败也计数）。超限返回固定文案，未超限返回 null。 */
  #rateLimit(context: PluginToolContext): string | null {
    const now = this.#deps.clock.now();
    if (context.runId !== null) {
      const used = this.#runCounts.get(context.runId) ?? 0;
      if (used >= REQUESTS_PER_RUN_MAX) {
        return '本次执行已经请求过插件安装，不要再重复请求。';
      }
      // 先删后插：在用的 run 永远排到队尾，不会被「最近 200 个 run」的裁剪误删。
      this.#runCounts.delete(context.runId);
      this.#runCounts.set(context.runId, used + 1);
      while (this.#runCounts.size > RUN_COUNT_LIMIT) {
        const oldest = this.#runCounts.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.#runCounts.delete(oldest);
      }
    }
    if (context.conversationId !== null) {
      if (this.#conversationHits.size > CONVERSATION_KEY_LIMIT) {
        for (const [id, times] of this.#conversationHits) {
          const last = times[times.length - 1] ?? 0;
          if (now - last >= HOUR_MS) this.#conversationHits.delete(id);
        }
      }
      const hits = (this.#conversationHits.get(context.conversationId) ?? []).filter(
        (at) => now - at < HOUR_MS,
      );
      if (hits.length >= REQUESTS_PER_CONVERSATION_HOURLY_MAX) {
        return '这个对话里插件安装请求太频繁了（每小时有上限），请稍后再试。';
      }
      hits.push(now);
      this.#conversationHits.set(context.conversationId, hits);
    }
    return null;
  }
}
