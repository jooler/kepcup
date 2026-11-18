import { type Bot, type Settings } from '@kepcup/shared';
import type { AgentEngine } from './types.js';

/**
 * 后台 LLM 调用的路由（2026-11 修订，design 28 §8）：后台任务**恒走内置引擎**——
 * 外部智能体只驱动任务（Bot `runtime.agent`），对话轮固定内置，后台整理同样内置。
 * 路由只剩「这个用途当下用哪个内置模型」：整理类用途（摘要 / 反思 / 记忆整理 /
 * 画像整理 / Wiki 维护 / 技能生成）走后台任务模型链（Bot `runtime.background_model`
 * → 全局 `backgroundModel` → 轻量 → 主模型）；分诊 / 上下文压缩 / 微应用仍走轻量
 * 链；组件制作与审查走主模型链。没有可用模型 → null（调用方照旧优雅跳过）。
 */

export type LlmPurpose =
  | 'triage'
  | 'summary'
  | 'reflection'
  | 'consolidation'
  | 'profile_curation'
  | 'wiki_maintenance'
  | 'skill_authoring'
  /** D87 组件制作 loop 的 SPEC / BUILD / FIX 阶段（设计 32 §11.11）。 */
  | 'widget_authoring'
  /** D87 P3c 组件制作 loop 的独立审查（设置「组件审查模型」，缺省跟随 Bot 主模型）。 */
  | 'widget_review'
  /** D112 微应用的 ai.chat / ai.session（设置「微应用模型」，缺省跟随 Bot 轻量模型）。 */
  | 'micro_app'
  | 'subagent_compaction'
  /** D93 内置 pi 任务的自动上下文压缩（轻量模型摘要旧消息）。 */
  | 'task_compaction';

/**
 * 模型选取的唯一入口（所有推理调用的 purpose）：后台用途 + `conversation`
 * （对话轮与任务，Bot 主模型 → 全局主模型）。内置模型一律经
 * {@link builtinModelRef} 取，业务代码不再自己拼 `bot.runtime.model ||
 * settings.default*`——设置 / Bot 改模型后各处才不会各走各的。
 */
export type ModelPurpose = LlmPurpose | 'conversation';

export interface LlmRoute {
  engine: AgentEngine;
  /** 内置 `provider/model`。 */
  modelRef: string;
  /** usage_ledger / 调度器并发键：内置厂商 id。 */
  provider: string;
}

/** 内置模型的取法（与 2026-11 修订前各调用点一致）。 */
type BuiltinRule = 'light_for_bot' | 'main_for_bot' | 'background_light' | 'background_main';

const BUILTIN_RULES: Readonly<Record<ModelPurpose, BuiltinRule>> = {
  // 对话轮 / 任务：Bot 主模型 → 全局主模型。
  conversation: 'main_for_bot',
  // 分诊（路由判断）/ SubAgent 压缩 / 任务压缩 / 微应用：Bot 轻量 → 全局轻量 → Bot 主 → 全局主。
  triage: 'light_for_bot',
  subagent_compaction: 'light_for_bot',
  task_compaction: 'light_for_bot',
  micro_app: 'light_for_bot',
  // 组件制作（D87）：与发起任务同一个 Bot 主模型。
  widget_authoring: 'main_for_bot',
  widget_review: 'main_for_bot',
  // 整理类后台任务（2026-11 修订）：Bot 后台任务模型 → 全局后台任务模型 →
  // 各自的既有兜底（摘要 / 反思 / 整理 = 轻量链；画像 / Wiki / 技能 = 主模型链）。
  summary: 'background_light',
  reflection: 'background_light',
  consolidation: 'background_light',
  profile_curation: 'background_main',
  wiki_maintenance: 'background_main',
  skill_authoring: 'background_main',
};

export function providerOfModelRef(modelRef: string): string {
  const index = modelRef.indexOf('/');
  return index > 0 ? modelRef.slice(0, index) : 'unknown';
}

/** 内置模型 ref → 路由（'' = 没有内置模型 → null）。 */
export function builtinRoute(engine: AgentEngine, modelRef: string): LlmRoute | null {
  if (modelRef.length === 0) return null;
  return { engine, modelRef, provider: providerOfModelRef(modelRef) };
}

export interface LlmRouterDeps {
  settings: { get(): Settings };
  bots: { get(id: string): Bot | null };
  builtin: AgentEngine;
}

export class LlmRouter {
  readonly #deps: LlmRouterDeps;

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

  #safeBot(botId: string): Bot | null {
    try {
      return this.#deps.bots.get(botId);
    } catch {
      return null;
    }
  }

  #resolve(purpose: LlmPurpose, bot: Bot | null): LlmRoute | null {
    return builtinRoute(
      this.#deps.builtin,
      builtinModelRef(purpose, this.#deps.settings.get(), bot),
    );
  }
}

/**
 * 某用途当下该用的内置模型 ref（'' = 没有）。每次调用都读当前 settings /
 * Bot，不缓存——「改设置立即生效」只靠这一点成立。
 */
export function builtinModelRef(
  purpose: ModelPurpose,
  settings: Settings,
  bot: Bot | null,
): string {
  const runtime = bot?.profile.runtime;
  // 组件审查可以单独指定模型（评估者与生成者不同源）；未指定 = 跟随 Bot 主模型。Bot 固定了自己的
  // 主模型（如出于数据去向选的本地 / 私有模型）时尊重它，不把 brief 与源码发给另一家（审查修复）。
  const reviewModel = settings.widgetReviewModel ?? '';
  if (purpose === 'widget_review' && reviewModel.length > 0 && !(runtime?.model ?? '')) {
    return reviewModel;
  }
  // 微应用模型（D112 §8.2）：宿主策略锚点；未指定 = light_for_bot 链。微应用自己不能
  // 指定厂商 / 模型 id——这条设置是用户手里唯一的策略入口。
  const microAppSetting = settings.microAppModel ?? '';
  if (purpose === 'micro_app' && microAppSetting.length > 0) {
    return microAppSetting;
  }
  switch (BUILTIN_RULES[purpose]) {
    case 'light_for_bot':
      return (
        runtime?.light_model ||
        settings.defaultLightModel ||
        runtime?.model ||
        settings.defaultMainModel
      );
    case 'main_for_bot':
      return runtime?.model || settings.defaultMainModel;
    case 'background_light':
      return (
        runtime?.background_model ||
        settings.backgroundModel ||
        settings.defaultLightModel ||
        settings.defaultMainModel
      );
    case 'background_main':
      return (
        runtime?.background_model ||
        settings.backgroundModel ||
        runtime?.model ||
        settings.defaultMainModel
      );
  }
}

/** 后台 loop 的依赖切片（装配了路由器就用它，否则只走内置模型）。 */
export interface RoutedLoopDeps {
  engine: AgentEngine;
  settings: { get(): Settings };
  router?: LlmRouter | undefined;
  bots?: { get(id: string): Bot | null };
}

/**
 * 后台 loop 取路由：`deps.router` 缺省（精简装配 / 单测）时用同样的内置规则。
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

/**
 * 路由是否仍指向 `modelRef`（给引擎的 `isRouteCurrent`）：设置 / Bot 改了模型
 * 后，对旧模型的同模型重试随即停止。后台 run 与结构化调用都用它，口径与
 * `routeFor` 一致。
 */
export function routeStillCurrent(
  deps: RoutedLoopDeps,
  purpose: LlmPurpose,
  botId: string | null,
  modelRef: string,
): boolean {
  return routeFor(deps, purpose, botId)?.modelRef === modelRef;
}
