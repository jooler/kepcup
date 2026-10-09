import type { ToolRisk } from '../../mcp/risk.js';

/**
 * 工具调用的副作用类别（W2 外部副作用台账，todo/borrowings-from-personal-agents.md；
 * 与 D67 docs/design/24-durable-execution.md 的 replay 分类对齐）：
 *
 * - `none`：只读 / 无副作用，重做安全（D67 `safe`）——不进台账。
 * - `local`：只改本机或应用内状态，且可撤销 / 可重做（write / edit 有 revert；
 *   记忆、定时、应用内消息、任务；沙箱内的 bash）——不进台账。
 * - `external`：离开本机或不可撤销（D67 `unsafe`）：浏览器的点击 / 输入 / 按键、
 *   非只读 MCP 工具、git 远程、沙箱外命令、委派给其他 Bot、@ 其他 Bot 的消息——
 *   执行前写 `executing`，结束后结。
 *
 * 词表即全部内置工具名（tool-effects 单测断言没有遗漏）；**未登记的工具名一律
 * 按 external**（保守：只多记一行，不改变行为）。
 */
export type EffectClass = 'none' | 'local' | 'external';

export interface EffectClassContext {
  /** W5 风险档：给出即按 MCP 工具分类（read → none，write / destructive → external）。 */
  mcpRisk?: ToolRisk;
  /**
   * 该调用已确定在沙箱外执行（网关在执行已批准的命令前经 tool-call scope 报告，
   * 见 recorder 的 escalate）。
   */
  unsandboxed?: boolean;
}

type Rule = EffectClass | ((params: Record<string, unknown>) => EffectClass);

/**
 * 内置工具词表（tools/**、wiki/maintenance-tools.ts、skills/authoring-tools.ts 的
 * 全部 ToolDefinition 名；pi-coding-agent 的 read / write / edit / ls / find /
 * grep / bash）。新增内置工具必须在这里登记。
 */
const BUILTIN_EFFECTS: Readonly<Record<string, Rule>> = {
  // --- 文件与命令（coding-tools；wiki 维护 / 技能生成各有同名的受限版本）---
  read: 'none',
  ls: 'none',
  find: 'none',
  grep: 'none',
  write: 'local',
  edit: 'local',
  /** wiki 维护 loop 删除 Wiki 页面（Bot 自己的 wiki 目录，git 版本可恢复）。 */
  delete: 'local',
  /**
   * 沙箱内执行 → local（沙箱外由网关 escalate，见 EffectClassContext.unsandboxed）。
   * 确认模式（沙箱不可用）下：白名单只读命令 → 仍 local；需批准的命令在执行前
   * escalate → external。技能生成 loop 的 bash 只在沙箱里跑（fail-closed）。
   *
   * 已定（W2 复查）：沙箱内**联网**的命令（curl POST、npm publish、git push
   * 走 https 等）同样按 local、不进台账——逐条记录会让几乎每个编程任务都触发
   * W3-P1 的「检查后重试」门。所以台账不覆盖沙箱内命令；W3-P1 面板文案须写明
   * 「沙箱内执行的命令不在此清单中，请查看执行记录」。
   */
  bash: 'local',
  /** 用户逐条批准后在沙箱外执行。 */
  request_unsandboxed: 'external',
  /** git push / pull / fetch / clone…：沙箱外、用用户凭据访问远端。 */
  git_remote: 'external',
  request_access: 'local',
  acquire_project_write: 'local',
  request_environment: 'local',

  // --- 浏览器（W1）：GET 导航可安全重做（与 W1 一致：browser_open 失败按 not_started）---
  browser_open: 'none',
  browser_snapshot: 'none',
  browser_screenshot: 'none',
  browser_scroll: 'none',
  browser_back: 'none',
  browser_close: 'none',
  browser_click: 'external',
  browser_type: 'external',
  browser_press: 'external',

  // --- 对话与消息 ---
  /**
   * 应用内消息（本机对话，无外部渠道）→ local；@ 了其他 Bot 时会触发它们执行
   * （与委派同类）→ external。
   */
  send_message: (params) => {
    const mentions = params['mention_bot_ids'];
    return Array.isArray(mentions) && mentions.length > 0 ? 'external' : 'local';
  },
  skip_reply: 'none',
  search_messages: 'none',
  get_messages_around: 'none',
  /** 非文本附件会复制进 workspace。 */
  get_attachment: 'local',
  list_my_runs: 'none',
  get_run: 'none',
  ask_user: 'none',
  ask_question: 'none',

  // --- 任务、SubAgent、委派 ---
  start_task: 'local',
  inject_task: 'local',
  cancel_task: 'local',
  list_tasks: 'none',
  forward_task_result: 'local',
  /** 宿主 SubAgent（D66）：子 run 自己的外部调用按子 run 入账。 */
  delegate_task: 'local',
  collect_delegate_results: 'none',
  /** 跨 Bot 委派（D71）：另一个 Bot 会据此执行（可能有它自己的外部动作）。 */
  delegate_to_bot: 'external',
  cancel_delegation: 'local',

  // --- 记忆、画像、Wiki、定时 ---
  remember: 'local',
  recall_memory: 'none',
  get_user_profile: 'none',
  list_commitments: 'none',
  memory_feedback: 'local',
  forget: 'local',
  propose_profile_change: 'local',
  wiki_search: 'none',
  wiki_read: 'none',
  wiki_enqueue: 'local',
  schedule: 'local',
  list_schedules: 'none',
  cancel_schedule: 'local',

  // --- 联网读取与媒体（调用云端服务，但不改外部状态；重做只多花费用）---
  web_search: 'none',
  web_fetch: 'none',
  understand_image: 'none',
  transcribe_audio: 'none',
  generate_image: 'local',
  generate_speech: 'local',
  generate_video: 'local',

  // --- 技能、引导、管家 ---
  install_skill: 'local',
  create_skill: 'local',
  save_profile: 'local',
  finish_setup: 'local',
  list_bots: 'none',
  suggest_route: 'none',
  propose_team: 'local',
  propose_bot: 'local',
  propose_group: 'local',
};

/** All built-in tool names registered in the classifier (tests assert coverage). */
export const CLASSIFIED_BUILTIN_TOOLS: readonly string[] = Object.keys(BUILTIN_EFFECTS);

/** Whether `toolName` is a registered built-in tool name. */
export function isClassifiedBuiltin(toolName: string): boolean {
  return Object.hasOwn(BUILTIN_EFFECTS, toolName);
}

/**
 * The effect class of one call. MCP tools (risk given) go by their W5 risk;
 * built-ins by the table (some look at params); an unsandboxed escalation
 * makes any call external; unknown names are external (conservative).
 */
export function effectClassOf(
  toolName: string,
  params: unknown,
  ctx: EffectClassContext = {},
): EffectClass {
  if (ctx.unsandboxed === true) return 'external';
  if (ctx.mcpRisk !== undefined) return ctx.mcpRisk === 'read' ? 'none' : 'external';
  if (!Object.hasOwn(BUILTIN_EFFECTS, toolName)) return 'external';
  const rule = BUILTIN_EFFECTS[toolName]!;
  if (typeof rule === 'string') return rule;
  const record =
    params !== null && typeof params === 'object' && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return rule(record);
}
