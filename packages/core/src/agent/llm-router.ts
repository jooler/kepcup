import {
  AGENT_BACKGROUND_EVERY_N_RUNS,
  AGENT_TRIAGE_MIN_INTERVAL_MS,
  agentEngineKey,
  agentModelRef,
  BUILTIN_ENGINE,
  type AgentCatalogEntry,
  type AgentView,
  type Bot,
  type Settings,
} from '@kepcup/shared';
import { agentRunGate } from './external/catalog.js';
import {
  agentConcurrency,
  backgroundToolFree,
  parallelSessionsFor,
  PROVIDERS,
  providerFor,
} from './external/providers/index.js';
import type { ProviderRegistry } from './external/types.js';
import type { AgentEngine, RunSpec } from './types.js';

/**
 * 后台 LLM 调用的路由（D72 P6，design 28 §8「后台 loop」）：有内置模型 → 内置
 * 引擎（行为与 P6 之前完全一致）；没有 → 外部 Agent：`settings.backgroundAgentId`
 * 明确指定的那个，或（缺省「自动」）**只用该 Bot 自己的 Agent**——永不换用
 * 别家（审查 S2：数据只流向用户为该 Bot 选用或明确指定的厂商）；无所属 Bot 的
 * 任务（画像整理是跨 Bot 的全局画像、群聊摘要）只在明确指定时运行。都没有、
 * 被关闭或不合格 → null（调用方照旧优雅跳过 = P4 兜底）。
 *
 * 合格（`agentBackgroundBlocker`，审查 S1 / C1）：Provider 能为后台会话完全关闭
 * 原生工具；未开启「加载我的个人配置」（OpenCode / Cursor 等按进程加载个人
 * 配置）；能同进程并行会话（`features.parallelSessions`，否则并发恒为 1）；
 * 并发上限至少 2（调度器给后台任务至多 并发-1 个名额）。
 *
 * 只有外部 Agent 时的降配：续接 L2 仲裁保持关闭；技能生成默认关
 * （`backgroundTasks.agentSkillAuthoring`）；群聊判断默认不跑
 * （`backgroundTasks.groupMentionOnly` 默认开），用户关掉后也受每日后台预算
 * 与节流约束（`admit`）；反思 / 摘要每 `AGENT_BACKGROUND_EVERY_N_RUNS` 次一跑。
 */

export type LlmPurpose =
  | 'triage'
  | 'continuation'
  | 'summary'
  | 'reflection'
  | 'consolidation'
  | 'profile_curation'
  | 'wiki_maintenance'
  | 'skill_authoring'
  | 'subagent_compaction';

export interface LlmRoute {
  engine: AgentEngine;
  /** 内置 `provider/model`，或外部 Agent 的伪 ref `agent:{id}/{model|default}`。 */
  modelRef: string;
  /** usage_ledger / 调度器并发键：内置厂商 id，或 `agent:{id}`。 */
  provider: string;
  /** 外部 Agent 的目录 id；null = 内置引擎。 */
  agentId: string | null;
}

/** 内置模型的取法（与 P6 之前各调用点一致）。 */
type BuiltinRule = 'light_for_bot' | 'main_for_bot' | 'app_light' | 'app_main';

const BUILTIN_RULES: Readonly<Record<LlmPurpose, BuiltinRule>> = {
  // 群聊判断 / 续接仲裁 / SubAgent 压缩：Bot 轻量 → 全局轻量 → Bot 主 → 全局主。
  triage: 'light_for_bot',
  continuation: 'light_for_bot',
  subagent_compaction: 'light_for_bot',
  // Wiki 维护 / 技能生成：Bot 主模型 → 全局主模型。
  wiki_maintenance: 'main_for_bot',
  skill_authoring: 'main_for_bot',
  // 摘要 / 反思 / 整理：全局轻量 → 全局主；画像整理：全局主模型。
  summary: 'app_light',
  reflection: 'app_light',
  consolidation: 'app_light',
  profile_curation: 'app_main',
};

/** 只有外部 Agent 时降频的用途（每 AGENT_BACKGROUND_EVERY_N_RUNS 次一跑）。 */
const THROTTLED: ReadonlySet<LlmPurpose> = new Set(['reflection', 'summary']);

export function providerOfModelRef(modelRef: string): string {
  const index = modelRef.indexOf('/');
  return index > 0 ? modelRef.slice(0, index) : 'unknown';
}

/** 内置模型 ref → 路由（'' = 没有内置模型 → null）。 */
export function builtinRoute(engine: AgentEngine, modelRef: string): LlmRoute | null {
  if (modelRef.length === 0) return null;
  return { engine, modelRef, provider: providerOfModelRef(modelRef), agentId: null };
}

/**
 * Why an agent may not run background work at all (审查 S1 / C1); null =
 * eligible. Background sessions must have no native tools: only providers
 * that declare `backgroundNoNativeTools` qualify — plus testkit entries (the
 * scripted fake agent has no native tools, never shipped).
 */
export function agentBackgroundBlocker(
  settings: Settings,
  entry: AgentCatalogEntry,
  registry: ProviderRegistry = PROVIDERS,
): string | null {
  let toolFree: boolean;
  let parallel: boolean;
  try {
    const provider = providerFor(entry, registry);
    toolFree = backgroundToolFree(entry, provider);
    parallel = parallelSessionsFor(entry, provider);
  } catch {
    toolFree = false;
    parallel = false;
  }
  if (!toolFree) {
    return '无法为后台任务完全关闭它的原生工具（文件 / 命令 / 联网）';
  }
  if (settings.agents[entry.id]?.loadUserConfig === true) {
    return '已开启「加载我的个人配置」（后台任务不加载个人配置）';
  }
  // Same limit the scheduler applies (`agentConcurrency`): agents without
  // parallel sessions always run one session at a time.
  if (!parallel) {
    return '该智能体未验证可并行会话（并发上限恒为 1，后台任务需至少 2）';
  }
  if (agentConcurrency(settings.providerConcurrency, entry, registry) < 2) {
    return '并发上限为 1（后台任务需至少 2，为对话保留一个名额）';
  }
  return null;
}

export interface LlmRouterDeps {
  settings: { get(): Settings };
  bots: { get(id: string): Bot | null };
  builtin: AgentEngine;
  /** 外部智能体引擎；缺省 = 只走内置（无 Agent 兜底）。 */
  external?: AgentEngine;
  catalog?: () => readonly AgentCatalogEntry[];
  /** AgentsService 的本机状态视图（就绪判断）；缺省只看启用开关。 */
  agentView?: (agentId: string) => Pick<AgentView, 'enabled' | 'status' | 'statusDetail'> | null;
  /** Provider 登记表（后台合格判断）；缺省 PROVIDERS。 */
  providers?: ProviderRegistry;
  /**
   * 该 Bot 今日后台预算是否已用完（审查 C2：经 Agent 的群聊判断计入每日后台
   * 预算，用完即只响应 @ / 回复）；缺省不检查。
   */
  budgetExceeded?: (botId: string) => boolean;
  /** 节流时钟（测试注入）；缺省 Date.now。 */
  now?: () => number;
}

export class LlmRouter {
  readonly #deps: LlmRouterDeps;
  /** 降频计数（进程内；重启后从头计；回到 0 即删除，审查 C8）。 */
  readonly #counters = new Map<string, number>();
  /** 经 Agent 的群聊判断上次放行时间（`botId:conversationId`，进程内）。 */
  readonly #triageAt = new Map<string, number>();

  constructor(deps: LlmRouterDeps) {
    this.#deps = deps;
  }

  /** 与某个 Bot 相关的后台调用（`bot` 可为 id；null = 无所属 Bot）。 */
  resolveForBot(bot: Bot | string | null, purpose: LlmPurpose): LlmRoute | null {
    const resolved = typeof bot === 'string' ? this.#safeBot(bot) : (bot ?? null);
    return this.#resolve(purpose, resolved);
  }

  /** 无所属 Bot 的后台调用（画像整理等）。 */
  resolveDefault(purpose: LlmPurpose): LlmRoute | null {
    return this.#resolve(purpose, null);
  }

  /**
   * 降频闸门：只对外部 Agent 路由上的反思 / 摘要生效——同一 `key`（Bot / 对话）
   * 每 `AGENT_BACKGROUND_EVERY_N_RUNS` 次触发放行一次（第 1 次放行）。内置
   * 路由与其他用途恒放行。
   */
  admit(route: LlmRoute, purpose: LlmPurpose, key: string): boolean {
    if (route.agentId === null) return true;
    if (purpose === 'triage') return this.#admitTriage(key);
    if (!THROTTLED.has(purpose)) return true;
    const counterKey = `${purpose}:${key}`;
    const count = this.#counters.get(counterKey) ?? 0;
    const next = (count + 1) % AGENT_BACKGROUND_EVERY_N_RUNS;
    if (next === 0) this.#counters.delete(counterKey);
    else this.#counters.set(counterKey, next);
    return count === 0;
  }

  /**
   * 经 Agent 的群聊判断（审查 C2）：同一 `botId:conversationId` 每
   * AGENT_TRIAGE_MIN_INTERVAL_MS 至多放行一次；期间该 Bot 只响应 @ / 回复。
   */
  #admitTriage(key: string): boolean {
    const now = (this.#deps.now ?? Date.now)();
    for (const [other, at] of this.#triageAt) {
      if (now - at >= AGENT_TRIAGE_MIN_INTERVAL_MS) this.#triageAt.delete(other);
    }
    if (this.#triageAt.has(key)) return false;
    this.#triageAt.set(key, now);
    return true;
  }

  #safeBot(botId: string): Bot | null {
    try {
      return this.#deps.bots.get(botId);
    } catch {
      return null;
    }
  }

  #resolve(purpose: LlmPurpose, bot: Bot | null): LlmRoute | null {
    const settings = this.#deps.settings.get();
    const builtin = builtinRoute(
      this.#deps.builtin,
      builtinRef(BUILTIN_RULES[purpose], settings, bot),
    );
    if (builtin !== null) return builtin;
    return this.#agentRoute(purpose, settings, bot);
  }

  /** 无内置模型时的外部 Agent 兜底；null = 跳过。 */
  #agentRoute(purpose: LlmPurpose, settings: Settings, bot: Bot | null): LlmRoute | null {
    const external = this.#deps.external;
    const catalog = this.#deps.catalog?.() ?? [];
    if (external === undefined || catalog.length === 0) return null;
    const tasks = settings.backgroundTasks;
    if (!tasks.agentEnabled) return null;
    // 续接 L2 仲裁只用内置模型（外部 Agent 冷启动远超仲裁时限，design 28 §8）。
    if (purpose === 'continuation') return null;
    if (purpose === 'skill_authoring' && !tasks.agentSkillAuthoring) return null;
    if (purpose === 'triage') {
      // Opt-in only (审查 C2), and charged to the bot's daily background budget.
      if (tasks.groupMentionOnly) return null;
      if (bot !== null && this.#deps.budgetExceeded?.(bot.id) === true) return null;
    }
    const viewOf = this.#deps.agentView;
    // No state view for an entry (should not happen) = not usable in the background.
    const view =
      viewOf === undefined
        ? undefined
        : (id: string) =>
            viewOf(id) ?? { enabled: false, status: 'error' as const, statusDetail: null };
    const usable = (agentId: string) => {
      if (agentId.length === 0) return false;
      const entry = catalog.find((candidate) => candidate.id === agentId);
      return (
        entry !== undefined &&
        agentRunGate(settings, catalog, agentId, view) === null &&
        agentBackgroundBlocker(settings, entry, this.#deps.providers) === null
      );
    };
    const chosen = settings.backgroundAgentId ?? '';
    const own = bot?.profile.runtime.agent.id ?? '';
    let agentId: string | null;
    if (chosen.length > 0) {
      // 用户指定的 Agent 不可用时不擅自换用别家（额度归属由用户决定）。
      agentId = usable(chosen) ? chosen : null;
    } else if (purpose === 'profile_curation') {
      // 跨 Bot 的全局画像：只发给用户明确指定的 Agent（审查 S2）。
      agentId = null;
    } else {
      // 自动：只用该 Bot 自己的 Agent，永不换用别家（审查 S2）。
      agentId = usable(own) ? own : null;
    }
    if (agentId === null) return null;
    const model = agentId === own ? (bot?.profile.runtime.agent.model ?? '') : '';
    return {
      engine: external,
      modelRef: agentModelRef(agentId, model),
      provider: agentEngineKey(agentId),
      agentId,
    };
  }
}

function builtinRef(rule: BuiltinRule, settings: Settings, bot: Bot | null): string {
  const runtime = bot?.profile.runtime;
  switch (rule) {
    case 'light_for_bot':
      return (
        runtime?.light_model ||
        settings.defaultLightModel ||
        runtime?.model ||
        settings.defaultMainModel
      );
    case 'main_for_bot':
      return runtime?.model || settings.defaultMainModel;
    case 'app_light':
      return settings.defaultLightModel || settings.defaultMainModel;
    case 'app_main':
      return settings.defaultMainModel;
  }
}

/**
 * 后台 loop 的 run（Wiki 维护、技能生成）落到路由上：外部 Agent 路由补上后台
 * 精简会话参数（只读、空私有临时 cwd、不复用、只放行桥工具，见
 * `ExternalRunSpec.background`）；内置路由原样返回。
 */
export function backgroundRunSpec(route: LlmRoute, spec: RunSpec): RunSpec {
  if (route.agentId === null) return spec;
  return {
    ...spec,
    model: route.modelRef,
    external: {
      agentId: route.agentId,
      permission: 'read_only',
      capabilities: [],
      sessionKey: `bg:${spec.identity.runId}`,
      background: true,
    },
  };
}

/** `runs.engine` 列的取值。 */
export function engineKeyOf(route: LlmRoute): string {
  return route.agentId === null ? BUILTIN_ENGINE : agentEngineKey(route.agentId);
}

/** 后台 loop 的依赖切片（装配了路由器就用它，否则只走内置模型）。 */
export interface RoutedLoopDeps {
  engine: AgentEngine;
  settings: { get(): Settings };
  router?: LlmRouter | undefined;
  bots?: { get(id: string): Bot | null };
}

/**
 * 后台 loop 取路由：`deps.router` 缺省（精简装配 / 单测）时等价于 P6 之前的
 * 「只用内置模型」。
 */
export function routeFor(
  deps: RoutedLoopDeps,
  purpose: LlmPurpose,
  botId: string | null,
): LlmRoute | null {
  const router =
    deps.router ??
    new LlmRouter({
      settings: deps.settings,
      bots: deps.bots ?? { get: () => null },
      builtin: deps.engine,
    });
  return botId === null ? router.resolveDefault(purpose) : router.resolveForBot(botId, purpose);
}
