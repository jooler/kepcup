import type { LoopType, TriggerReason } from '../domain/types.js';
import { DIRECT_ITEM_IDS } from './items.js';
import { SETTING_WRITE_MODE_ORDER, type SettingItem, type SettingWriteMode } from './types.js';

/**
 * 宿主裁定修改档位（todo/conversational-app-setup.md §5.3）：确定性纯函数，Bot 无法绕过。
 * 最终档位 = 条目的 `maxMode`，再按上下文逐条收紧（只会变严，不会变宽）。
 */

/**
 * 允许 direct 的触发源（§5.3 第 1 条）：`direct`，或 `mention` / `reply` 且触发消息的发送者
 * 是用户本人。三者都还要求 `triggerFromUser`（组件回传 / 代发的消息不算用户本人）。
 */
export const SETTING_DIRECT_TRIGGERS: ReadonlySet<TriggerReason> = new Set([
  'direct',
  'mention',
  'reply',
]);

/** 能修改设置的 loop：对话轮与任务（§5.2「对话轮与任务都注册」）；后台 loop 一律拒绝。 */
export const SETTINGS_TOOL_LOOP_TYPES: ReadonlySet<LoopType> = new Set(['turn', 'task']);

/** 裁定的输入：本 run 的触发与上下文，由 core 计算后传入。 */
export interface SettingModeContext {
  /** 本 run 的触发原因（null = 无触发批，如部分后台 run）。 */
  triggerReason: TriggerReason | null;
  /**
   * 触发批的发送者是用户本人：`senderType = 'user'`，且不是组件回传（`origin: 'widget'`）、
   * 不是跨 Bot 代发（`origin: 'delegation'`）。其他 Bot 的 mention / reply 为 false。
   */
  triggerFromUser: boolean;
  /**
   * 本 run 已接触不可信内容（§5.3 第 2 条）：web_fetch、mail_read / mail_search、浏览器快照、
   * MCP / 连接应用的读取、附件正文。宿主按 run 记。
   */
  runTouchedUntrusted: boolean;
  /** D73 污点（按（Bot, 对话）计），与上一项取并集。 */
  tainted: boolean;
  /** 项目组会话（§5.3 第 3 条）。 */
  isProject: boolean;
  /** 改的是别的 Bot 的配置（§5.3 第 4 条）：普通 Bot 拒绝，管家最多出卡。 */
  targetsOtherBot: boolean;
  /** 管家（D70）。 */
  isButler: boolean;
  loopType: LoopType;
  /**
   * 本次 `values` 是放宽方向（只对带 `wideningMode` 的条目有意义）：core 适配器按旧值 →
   * 新值判定。缺省 = 未知，按放宽处理。
   */
  valuesWiden?: boolean;
  /**
   * 本次修改需要用户自填敏感字段（缺 Key、要新增厂商、未登录……）：至少 form。
   * 由 core 适配器按当前状态判定。
   */
  needsSensitiveInput?: boolean;
}

/** 最终档位：五档之一，或 `redirect`（改用专门工具）/ `refused`（宿主拒绝）。 */
export type SettingEffectiveMode = SettingWriteMode | 'redirect' | 'refused';

/** 收紧 / 拒绝的规则代号（测试与日志用；`reason` 是给 Bot 与卡片看的人话）。 */
export type SettingModeRule =
  | 'read-only'
  | 'via-tool'
  | 'loop'
  | 'other-bot-refused'
  | 'not-whitelisted'
  | 'trigger'
  | 'untrusted'
  | 'group'
  | 'other-bot'
  | 'widens'
  | 'renderer'
  | 'sensitive-input'
  | 'widening-values'
  | 'no-card';

export interface SettingModeDecision {
  mode: SettingEffectiveMode;
  /**
   * 宿主是否采用 Bot 给的 `values`（预填 / 直接写）：只有 direct / confirm / form 采用；
   * user-only 出空白卡（§5.3 第 5 条），link / redirect / refused 不涉及值。
   */
  acceptValues: boolean;
  /** `redirect` 时应改用的工具名；其余为 null。 */
  tool: string | null;
  /** 起作用的规则（按 `RULE_ORDER`），空 = 没有收紧。 */
  rules: SettingModeRule[];
  /** 人话原因（多条以「；」连接）；没有收紧时为 null。 */
  reason: string | null;
}

const RULE_TEXT: Record<SettingModeRule, string> = {
  'read-only': '这一项只读，只能在设置中查看',
  'via-tool': '这一项有专门的工具',
  loop: '后台工作不能修改设置',
  'other-bot-refused': '只能修改你自己的配置，别的 Bot 的配置请交给管家或用户',
  'not-whitelisted': '这一项不在可直接修改的范围内，只能出卡请用户确认',
  trigger: '这一轮不是用户本人直接发起的，只能出卡请用户确认',
  untrusted: '本轮读过网页、邮件等外部内容，只能出卡请用户确认',
  group: '群聊中只能出卡，不能直接修改',
  'other-bot': '修改的是别的 Bot 的配置，只能出卡请用户确认',
  widens: '这一项会放宽权限或安全边界，不能直接修改',
  renderer: '这一项只存在本机界面，只能出卡由用户在卡上修改',
  'sensitive-input': '需要用户自己填写密钥或登录，已出待填卡',
  'widening-values': '这次修改会放宽权限或安全边界，须由用户亲手设置',
  'no-card': '这一项暂时不能在对话里设置，只能出卡跳转到设置页',
};

function rank(mode: SettingWriteMode): number {
  return SETTING_WRITE_MODE_ORDER.indexOf(mode);
}

function stricter(a: SettingWriteMode, b: SettingWriteMode): SettingWriteMode {
  return rank(a) >= rank(b) ? a : b;
}

function terminal(
  mode: 'redirect' | 'refused' | 'link',
  rule: SettingModeRule,
  tool: string | null = null,
): SettingModeDecision {
  const reason =
    rule === 'via-tool' && tool !== null ? `这一项请改用 ${tool} 工具` : RULE_TEXT[rule];
  return { mode, acceptValues: false, tool, rules: [rule], reason };
}

/** 是否 direct 白名单条目（§5.3，`DIRECT_ITEM_IDS`）。 */
export function isDirectItemId(id: string): boolean {
  return (DIRECT_ITEM_IDS as readonly string[]).includes(id);
}

/**
 * 档位裁定（§5.3）。依次：
 * 1. 只读项 → link；`via` 专门工具 → redirect；非对话轮 / 任务 → refused；
 *    改别的 Bot 而自己不是管家 → refused。
 * 2. 起点 = `maxMode`；不在 `DIRECT_ITEM_IDS` 的 direct 降为 confirm（防有人加条目时顺手放宽）。
 * 3. 收紧到至少 confirm：触发源不在白名单、读过不可信内容 / 污点、群聊、改别的 Bot（管家）、
 *    条目可放宽权限、渲染层条目。需要用户自填敏感字段 → 至少 form；本次是放宽方向且条目带
 *    `wideningMode` → user-only。
 * 4. 收紧后不是 direct 而条目没有内嵌组件 → link（跳转卡兜底）。
 *
 * `rules` 记的是**各自就足以收紧**的规则（与先后无关），便于测试与给 Bot 解释。
 */
export function effectiveMode(item: SettingItem, ctx: SettingModeContext): SettingModeDecision {
  if (item.readOnly) return terminal('link', 'read-only');
  if (item.write.via !== 'catalog') return terminal('redirect', 'via-tool', item.write.via.tool);
  if (!SETTINGS_TOOL_LOOP_TYPES.has(ctx.loopType)) return terminal('refused', 'loop');
  if (ctx.targetsOtherBot && !ctx.isButler) return terminal('refused', 'other-bot-refused');

  const base: SettingWriteMode =
    item.write.maxMode === 'direct' && !isDirectItemId(item.id) ? 'confirm' : item.write.maxMode;
  const rules: SettingModeRule[] = [];
  if (base !== item.write.maxMode) rules.push('not-whitelisted');

  const userTriggered =
    ctx.triggerFromUser &&
    ctx.triggerReason !== null &&
    SETTING_DIRECT_TRIGGERS.has(ctx.triggerReason);
  const floors: Array<[SettingModeRule, boolean, SettingWriteMode]> = [
    ['trigger', !userTriggered, 'confirm'],
    ['untrusted', ctx.runTouchedUntrusted || ctx.tainted, 'confirm'],
    ['group', ctx.isProject, 'confirm'],
    ['other-bot', ctx.targetsOtherBot, 'confirm'],
    ['widens', item.write.widensPermission, 'confirm'],
    ['renderer', item.owner === 'renderer', 'confirm'],
    ['sensitive-input', ctx.needsSensitiveInput === true, 'form'],
    [
      'widening-values',
      item.write.wideningMode !== undefined && ctx.valuesWiden !== false,
      item.write.wideningMode ?? 'confirm',
    ],
  ];
  let mode = base;
  for (const [rule, active, floor] of floors) {
    if (!active) continue;
    if (rank(floor) > rank(base)) rules.push(rule);
    mode = stricter(mode, floor);
  }
  if (mode !== 'direct' && mode !== 'link' && item.card === null) {
    rules.push('no-card');
    mode = 'link';
  }
  return {
    mode,
    acceptValues: mode === 'direct' || mode === 'confirm' || mode === 'form',
    tool: null,
    rules,
    reason: rules.length > 0 ? rules.map((rule) => RULE_TEXT[rule]).join('；') : null,
  };
}
