import {
  AppError,
  connectorInstallableSkills,
  connectorMetaOf,
  isSafeSkillSourceUrl,
  type AppSkillOfferBot,
  type AppSkillOfferItem,
  type AppsSkillsInstallOutput,
  type AppsSkillsOffers,
  type Bot,
  type ConnectorCatalogEntry,
  type ConnectorSkill,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { EventBus } from '../infra/events.js';
import type { CoreLogger } from '../infra/logger.js';
import type { ApprovalsService } from '../permissions/approvals.js';
import type { SkillImporter } from '../skills/library.js';
import type { SkillsService } from '../skills/registry.js';
import type { CoreEventsMap } from '../start-types.js';
import type { ConnectorCatalog } from './catalog.js';
import type { AppConnectionStore } from './connection-store.js';

/**
 * 随附技能提示（D73 P3 §7.6）：目录条目 `_meta["app.kepcup/connector"].skills` 声明的技能，
 * 在连接完成（`apps.connect_flow` 的 `done`）后提示安装到被授权的 Bot。
 *
 * - **提示**（{@link AppSkillsOffers.offersFor} / `apps.skills_offer` 事件）只在三个条件同时成立时才有：
 *   条目声明了带来源的技能、该连接已有被授权的 Bot、那个 Bot 还没有同名技能（含公共技能）。
 * - **安装**（{@link AppSkillsOffers.install}）从不自动发生：每个技能走既有的
 *   `SkillImporter.import`，提交一张 `skill_import` 审批卡（来源、commit、扫描结果都在卡上；
 *   无人值守沿用该审批类型既有的规则，D41）。只能安装该条目**自己声明**的技能，来源取自目录而不是
 *   调用方传入。批准后的落位、拒绝后的清理都是既有流程。
 */

export interface SkillsOfferDeps {
  catalog: Pick<ConnectorCatalog, 'get'>;
  store: Pick<AppConnectionStore, 'get'>;
  skills: Pick<SkillsService, 'listForBot'>;
  importer: Pick<SkillImporter, 'import'>;
  approvals: Pick<ApprovalsService, 'list'>;
  bots: {
    get(id: string): Bot | null;
    listAppConnectionHolders(connectionId: string): Bot[];
  };
  conversations: { openDirect(botId: string): { conversation: { id: string } } };
  events: Pick<EventBus<CoreEventsMap>, 'emit' | 'on'>;
  logger: Pick<CoreLogger, 'warn'>;
  clock: Clock;
  /**
   * 测试钩子（仅 NODE_ENV=test 的 test-hooks 构建）：把目录声明的 https 来源换成本机夹具仓库。
   * 目录 schema 不允许本机路径，所以测试只能经这里。
   */
  resolveSource?: ((source: string) => string) | undefined;
}

/** 目录条目声明的、有来源的技能（旧的字符串形态没有来源，不会被提示）。 */
export function declaredSkills(entry: ConnectorCatalogEntry): ConnectorSkill[] {
  return connectorInstallableSkills(connectorMetaOf(entry));
}

/**
 * 纯逻辑：给定条目、被授权的 Bot 与各 Bot 已有的技能名，返回每个 Bot 还缺的技能
 * （没有缺的 Bot 不出现）。
 */
export function missingSkillsByBot(
  entry: ConnectorCatalogEntry,
  holders: ReadonlyArray<{
    botId: string;
    botName: string;
    installed: ReadonlySet<string>;
    /** 不再提示的技能名（目录声明有误）。 */
    skipped?: ReadonlySet<string> | undefined;
  }>,
): AppSkillOfferBot[] {
  const declared = declaredSkills(entry);
  if (declared.length === 0) return [];
  const out: AppSkillOfferBot[] = [];
  for (const holder of holders) {
    const missing = declared.filter(
      (skill) => !holder.installed.has(skill.name) && holder.skipped?.has(skill.name) !== true,
    );
    if (missing.length > 0) {
      out.push({
        botId: holder.botId,
        botName: holder.botName,
        skills: missing.map(toOfferItem),
      });
    }
  }
  return out;
}

function toOfferItem(skill: ConnectorSkill): AppSkillOfferItem {
  return { name: skill.name, description: skill.description, source: skill.source };
}

/** 同一条目、同一来源的「名字不符」只记一次：条目有误，再提示也只会再失败（进程内记忆）。 */
function mismatchKey(connectorId: string, skill: ConnectorSkill): string {
  return [connectorId, skill.name, skill.source, skill.ref ?? '', skill.subdirectory ?? ''].join(
    '\u0000',
  );
}

export class AppSkillsOffers {
  readonly #deps: SkillsOfferDeps;
  readonly #mismatched = new Set<string>();
  #unsubscribe: (() => void) | null = null;

  constructor(deps: SkillsOfferDeps) {
    this.#deps = deps;
  }

  /** 订阅连接流程：`done` 后提示（幂等；重复调用无副作用）。 */
  start(): void {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#deps.events.on('apps.connect_flow', (payload) => {
      if (payload.phase !== 'done' || payload.connectionId === undefined) return;
      try {
        this.offerAfterConnect(payload.connectionId);
      } catch (error) {
        this.#deps.logger.warn(
          { connectionId: payload.connectionId, err: String(error) },
          'skills offer after connect failed',
        );
      }
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  /** 某连接下各被授权 Bot 还缺的随附技能；没有目录条目 / 没有声明 / 没有缺的 → `bots` 为空。 */
  offersFor(connectionId: string): AppsSkillsOffers {
    const row = this.#deps.store.get(connectionId);
    if (row === null) {
      throw new AppError('NOT_FOUND', `连接 ${connectionId} 不存在`);
    }
    const entry = this.#deps.catalog.get(row.connectorId);
    const base = {
      connectionId,
      connectorId: row.connectorId,
      title: entry?.title ?? row.connectorId,
    };
    if (entry === null) return { ...base, bots: [] };
    // 名字与目录声明不符的技能（条目有误）不再提示；已装的同名技能按「已装」处理。
    const holders = this.#deps.bots.listAppConnectionHolders(connectionId).map((bot) => ({
      botId: bot.id,
      botName: bot.name,
      installed: this.#installedNames(bot.id),
      skipped: new Set(
        declaredSkills(entry)
          .filter((skill) => this.#mismatched.has(mismatchKey(row.connectorId, skill)))
          .map((skill) => skill.name),
      ),
    }));
    return { ...base, bots: missingSkillsByBot(entry, holders) };
  }

  /** 连接完成后：有缺技能的 Bot 才推送一次 `apps.skills_offer`。 */
  offerAfterConnect(connectionId: string): boolean {
    const offers = this.offersFor(connectionId);
    if (offers.bots.length === 0) return false;
    const union = new Map<string, AppSkillOfferItem>();
    for (const bot of offers.bots) for (const skill of bot.skills) union.set(skill.name, skill);
    this.#deps.events.emit('apps.skills_offer', {
      connectionId,
      connectorId: offers.connectorId,
      title: offers.title,
      botIds: offers.bots.map((bot) => bot.botId),
      skills: [...union.values()],
    });
    return true;
  }

  /**
   * 为一个 Bot 发起安装：每个技能提交一张 `skill_import` 审批卡（卡片发到该 Bot 的单聊）。
   * 批准前什么都不会安装；拒绝则什么都没有。
   */
  async install(input: {
    connectionId: string;
    botId: string;
    names?: readonly string[] | undefined;
  }): Promise<AppsSkillsInstallOutput> {
    const { catalog, store, bots, approvals } = this.#deps;
    const row = store.get(input.connectionId);
    if (row === null) throw new AppError('NOT_FOUND', `连接 ${input.connectionId} 不存在`);
    const entry = catalog.get(row.connectorId);
    if (entry === null) {
      throw new AppError('NOT_FOUND', '该应用已不在目录中，无法安装随附技能');
    }
    const bot = bots.get(input.botId);
    if (bot === null) throw new AppError('NOT_FOUND', `Bot ${input.botId} 不存在`);
    if (!bots.listAppConnectionHolders(input.connectionId).some((holder) => holder.id === bot.id)) {
      throw new AppError(
        'INVALID_INPUT',
        '该 Bot 没有被授权使用这个应用连接，不能为它安装随附技能',
      );
    }
    const declared = declaredSkills(entry);
    const declaredByName = new Map(declared.map((skill) => [skill.name, skill]));
    const installed = this.#installedNames(bot.id);
    let wanted: ConnectorSkill[];
    if (input.names === undefined) {
      wanted = declared.filter((skill) => !installed.has(skill.name));
    } else {
      wanted = [];
      for (const name of new Set(input.names)) {
        const skill = declaredByName.get(name);
        if (skill === undefined) {
          throw new AppError('INVALID_INPUT', `该应用没有声明随附技能 ${name}`, { name });
        }
        wanted.push(skill);
      }
    }

    const conversationId = this.#deps.conversations.openDirect(bot.id).conversation.id;
    const results: AppsSkillsInstallOutput['results'] = [];
    for (const skill of wanted) {
      if (installed.has(skill.name)) {
        results.push({ name: skill.name, status: 'installed' });
        continue;
      }
      if (this.#mismatched.has(mismatchKey(row.connectorId, skill))) {
        results.push({
          name: skill.name,
          status: 'mismatch',
          error: '该应用目录里声明的技能名与来源仓库里的不一致，已不再安装',
        });
        continue;
      }
      // 目录 schema 已拒绝这类来源；这里再查一次（远端目录 / 旧缓存也要过这道门）。
      if (!isSafeSkillSourceUrl(skill.source)) {
        results.push({ name: skill.name, status: 'failed', error: '技能来源地址不合规，已拒绝' });
        continue;
      }
      const sourceUrl = this.#deps.resolveSource?.(skill.source) ?? skill.source;
      // 同来源的卡已在等用户：不重复提交。
      const pending = approvals
        .list(conversationId)
        .find(
          (approval) =>
            approval.kind === 'skill_import' &&
            approval.status === 'pending' &&
            approval.botId === bot.id &&
            approval.payload['sourceUrl'] === sourceUrl &&
            (skill.subdirectory === undefined ||
              approval.payload['subdirectory'] === skill.subdirectory),
        );
      if (pending !== undefined) {
        results.push({ name: skill.name, status: 'pending', approvalId: pending.id });
        continue;
      }
      try {
        // 注意：`SkillImporter` 在审批**之前**就克隆来源仓库（es-git / libgit2，不经 SafeDispatcher，
        // 没有体积 / 时间上限），然后才提交审批卡；这是既有导入流程的特性（D63）。这里能做的是
        // 上面的来源白名单（仅公网 https、无凭据 / IP / 端口）与用户点「安装」才触发。已知缺口：
        // 克隆无体积 / 时间上限，见交付说明。
        const outcome = await this.#deps.importer.import({
          botId: bot.id,
          conversationId,
          sourceUrl,
          expectedName: skill.name,
          ...(skill.ref !== undefined ? { ref: skill.ref } : {}),
          ...(skill.subdirectory !== undefined ? { subdirectory: skill.subdirectory } : {}),
        });
        if (outcome.status === 'submitted') {
          results.push({ name: skill.name, status: 'submitted', approvalId: outcome.approvalId });
        } else {
          results.push({
            name: skill.name,
            status: 'failed',
            error: '来源仓库含多个技能，目录条目需要声明 subdirectory',
          });
        }
      } catch (error) {
        const details =
          error instanceof AppError
            ? (error.details as { nameMismatch?: unknown } | undefined)
            : undefined;
        if (details?.nameMismatch === true) {
          this.#mismatched.add(mismatchKey(row.connectorId, skill));
          results.push({
            name: skill.name,
            status: 'mismatch',
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        results.push({
          name: skill.name,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { results };
  }

  #installedNames(botId: string): Set<string> {
    return new Set(this.#deps.skills.listForBot(botId).map((skill) => skill.name));
  }
}
