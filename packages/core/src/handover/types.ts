import type { Bot, HandoverAction, HandoverAssetType, HandoverMark } from '@kepcup/shared';

/**
 * 资产清单层（D88，docs/design/37 §5.4）：每类资产一个适配器（盘点 / 校验 / 执行 /
 * 描述）。移交引擎（`dispatch/handover.ts`）、卡片与结果通知只认这个接口；新增资产类型
 * 只加适配器，不改引擎。
 */

/** 盘点出的一项资产。 */
export interface HandoverEntry {
  /** 全局唯一的条目 key：`{type}:{id}`（如 `mail:mal_x`、`schedule:sch_x`）。 */
  key: string;
  type: HandoverAssetType;
  /** 名称（邮箱地址、应用账号、任务标题……）。 */
  label: string;
  /** 补充说明（定时任务的时间、应用名……），可为空。 */
  detail: string;
  /** 可用动作，第一个之外的为可选动作。 */
  actions: HandoverAction[];
  defaultAction: HandoverAction;
  /** 与目标无关、盘点时就能判定的不可执行原因（如全局已停用、随承诺 P1 支持）。 */
  blocked?: string | undefined;
  /** label / detail 含外部或用户 / 模型写的文本：工具结果里包 `<untrusted>`。 */
  external: boolean;
  /** 卡上的标记（P1：外部导入的技能、敏感记忆）。 */
  marks?: HandoverMark[] | undefined;
  /** 卡上默认勾选（缺省 true；敏感记忆为 false）。 */
  defaultSelected?: boolean | undefined;
}

/** 盘点参数（记忆 / Wiki 的查询，P1 / P2 起使用）。 */
export interface InventoryQuery {
  memoryQuery?: string | undefined;
  /** 群聊里盘点：敏感记忆不作候选（同检索的群聊过滤）。 */
  excludeSensitiveMemory?: boolean | undefined;
  wikiQuery?: string | undefined;
}

/**
 * 一次校验 / 执行的上下文。`toBot` 为 null 表示新建目标还没建（提议时的校验）：适配器
 * 按「一个空白的新 Bot」判断（没有任何连接 / 绑定，只在自己的私聊里）。
 */
export interface HandoverContext {
  handoverId: string;
  fromBot: Bot;
  toBot: Bot | null;
  /** 目标显示名（新建目标建好前用提议里的名字）。 */
  toName: string;
}

/** 一项的执行结果。 */
export interface HandoverItemResult {
  /** 写进 `bot_handover_items.result_json`（如重建后的定时任务 id）。 */
  result?: Record<string, unknown> | undefined;
  /** 执行成功但值得告诉用户的副作用（如「A 有 2 个运行中的任务被中断」）。 */
  notes?: string[] | undefined;
}

/** 后台批量执行里一项的结果（`applyBatch`）。 */
export type HandoverBatchOutcome =
  | { status: 'done'; result?: Record<string, unknown> | undefined }
  | { status: 'skipped'; reason: string; result?: Record<string, unknown> | undefined };

export interface HandoverAdapter {
  readonly type: HandoverAssetType;
  /** §5.3 的执行阶段：2 = 配置类，3 = 知识类（Skill、记忆；Wiki、组件在后台），4 = 职责类（邮箱、定时任务、监看）。移交动作的 A 侧撤除统一在阶段 5。 */
  readonly stage: number;
  /**
   * P2：后台条目（Wiki、组件，设计 37 §5.3 阶段 3）。确认后的同步阶段不执行它们，宿主在
   * 阶段 2–6 之后登记一个 `handover_copy` 作业（jobs 表，崩溃后按既有机制恢复）在后台执行；
   * 作业结束前移交保持 `applying`（卡片「进行中」），交接说明与结算在作业完成后才做。
   */
  readonly background?: boolean;
  /** `key` 是否属于本适配器（按前缀）。 */
  owns(key: string): boolean;
  /**
   * 盘点源 Bot 名下的这类资产。按条复制的资产（记忆）只在给了查询时列条目；没有查询时
   * 返回空，统计走 `summary`。
   */
  inventory(botId: string, query?: InventoryQuery): HandoverEntry[];
  /** 盘点结果里这类资产的一行统计（如记忆的数量与按 kind 分布）；null = 不出。 */
  summary?(botId: string): string | null;
  /**
   * 存在、但永远不能移交的 key 的拒绝原因（如 `private_to_bot` 记忆）：提议里出现即退回并
   * 说明原因，而不是当作编造的 key。null = 不是这种情况。
   */
  refusal?(fromBotId: string, key: string): string | null;
  /**
   * 盘点之外仍合法的 key（如 `model:<ref>`：可用模型列表里的任何 ref）。返回条目 =
   * 合法；null = 编造的 key。缺省只认盘点里的。
   */
  resolve?(fromBotId: string, key: string): HandoverEntry | null;
  /** 针对目标的校验：null = 可执行，否则是不可执行的原因（卡上置灰 / 执行时跳过）。 */
  validate(ctx: HandoverContext, key: string, action: HandoverAction): string | null;
  /**
   * 执行（阶段 2–4 的那部分：让 B 获得）。必须可重入：重复执行不重复建、不重复绑。
   * 失败抛错（错误文案进结果通知）。
   */
  apply(
    ctx: HandoverContext & { toBot: Bot },
    key: string,
    action: HandoverAction,
  ): Promise<HandoverItemResult>;
  /**
   * 移交（move）的 A 侧撤除（阶段 5），只对需要分两步的资产（连接应用、MCP）实现；其余
   * 适配器在 `apply` 里一次做完。可重入。
   */
  release?(ctx: HandoverContext & { toBot: Bot }, key: string): Promise<HandoverItemResult>;
  /**
   * 崩溃恢复：这一项是否已经完整生效（例如邮箱已只绑 B）。为真则直接记 done，不再校验 /
   * 执行。缺省 = 依赖 `apply` 自身可重入。
   */
  isApplied?(ctx: HandoverContext & { toBot: Bot }, key: string, action: HandoverAction): boolean;
  /**
   * 执行时这一项没做成（重新校验不成立 → skipped，或 `apply` 抛错 → failed）：撤掉本次
   * 移交在接手方那边留下的半成品（如承诺联动的定时任务没移交成，B 的承诺副本要作废）。
   * best-effort、可重入；宿主吞掉它的异常。
   */
  abandon?(ctx: HandoverContext & { toBot: Bot }, key: string): void;
  /**
   * 后台条目的批量执行（Wiki：N 页一次提交）。宿主已对每项做过 `isApplied` / 校验，只传
   * 仍要执行的 key；返回每个 key 的结果（缺的记 failed）。必须可重入：重跑时已经做过的
   * 部分记 done、不重复写。抛错 = 整批暂时失败：作业按 jobs 机制重试，最后一次仍失败时
   * 宿主把这些条目记 failed。缺省 = 宿主逐项调用 `apply`。
   */
  applyBatch?(
    ctx: HandoverContext & { toBot: Bot },
    keys: string[],
  ): Promise<Map<string, HandoverBatchOutcome>>;
  /** 卡片与结果通知里的一行（「把邮箱 x 移交给 B」）。 */
  describe(entry: HandoverEntry, action: HandoverAction, toName: string): string;
  /** 卡片上的风险提示（如 A 正在运行的任务会被中断）。 */
  warnings?(ctx: HandoverContext, entry: HandoverEntry, action: HandoverAction): string[];
}
