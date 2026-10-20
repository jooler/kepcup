import type { Message } from './types.js';

/**
 * 左栏「最后一条消息」的单行预览。文本消息原样返回；卡片消息整理成
 * 「卡片 icon + 标题 + 摘要」——卡片本体在对话里能看到多少，侧栏就取多少，
 * 不额外查库（任务 / 委派等没有快照的卡只保留通用标题）。
 *
 * 只支持简体中文：core 生成的卡片文字本来就是中文，渲染端目前也只有
 * zh-CN 词典；新增语言时随卡片文案一起迁移。
 */

const PRESENT_KIND_ICON: Record<string, string> = {
  table: '📊',
  bar: '📊',
  line: '📈',
  pie: '🥧',
  kpi: '🔢',
  steps: '🪜',
  timeline: '🕘',
  compare: '⚖️',
};

const PRESENT_KIND_LABEL: Record<string, string> = {
  table: '表格',
  bar: '柱状图',
  line: '折线图',
  pie: '饼图',
  kpi: '指标',
  steps: '步骤',
  timeline: '时间线',
  compare: '对比',
};

/** 审批类卡片的标题（payload 在审批表里，消息本身只有 cardType）。 */
const APPROVAL_CARD_TITLE: Record<string, { icon: string; title: string }> = {
  access: { icon: '🔐', title: '访问授权请求' },
  unsandboxed: { icon: '🔐', title: '沙箱外执行请求' },
  command: { icon: '🔐', title: '命令确认' },
  git_remote: { icon: '🔐', title: 'git 远程操作请求' },
  environment: { icon: '📦', title: '环境安装请求' },
  skill_import: { icon: '🧩', title: '技能导入请求' },
  skill_preset: { icon: '🧩', title: '安装推荐技能' },
  profile_change: { icon: '🔐', title: '资料变更请求' },
  mcp_tool: { icon: '🔐', title: '调用 MCP 工具' },
  butler_proposal: { icon: '🔐', title: '管家提议' },
  agent_tool: { icon: '🔐', title: '智能体工具权限请求' },
  egress: { icon: '🔐', title: '外发确认' },
  mail_send: { icon: '✉️', title: '发送邮件' },
  bot_handover: { icon: '🤝', title: 'Bot 移交' },
};

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** 用单行空格拼接非空片段（icon / 标题 / 摘要）。 */
function line(...parts: Array<string | undefined>): string {
  return parts
    .map(textOf)
    .filter((part) => part.length > 0)
    .join(' ');
}

/**
 * 把一张卡片整理成左栏可显示的单行文本；任何卡片都有兜底标题。
 * `run_changes` 是已退役、对话里不再显示的卡，返回空串让调用方跳过。
 */
export function cardPreviewText(content: Record<string, unknown>): string {
  const cardType = textOf(content.cardType);

  if (cardType === 'mail') {
    const summary = textOf(content.mailSummary);
    const event = textOf(content.mailEvent);
    if (event === 'error' || event === 'paused') {
      return line('⚠️', '新邮件提醒', summary || (event === 'paused' ? '已暂停' : '连接失败'));
    }
    const from = textOf(content.mailFrom);
    const subject = textOf(content.mailSubject);
    const detail = [from, subject].filter((part) => part.length > 0).join(' · ') || summary;
    return line('✉️', '新邮件', detail);
  }

  if (cardType === 'watch') {
    return textOf(content.watchEvent) === 'alert'
      ? line('👁️', '网页监看提醒', textOf(content.watchSummary))
      : line('👁️', '网页监看', '已创建');
  }

  if (cardType === 'task') return line('📋', '任务');
  if (cardType === 'delegation_sent') return line('🤝', '已转交任务');
  if (cardType === 'delegation_result') return line('🤝', '转交结果');
  if (cardType === 'run_changes') return '';

  if (cardType === 'mcp_app') {
    const app = recordOf(content.appUi);
    const appName = textOf(app.appName);
    const title = textOf(app.title);
    return line('🧩', appName || title || '应用界面', title === appName ? '' : title);
  }

  if (cardType === 'bot_widget') {
    const widget = recordOf(content.widget);
    return line('🧩', textOf(widget.title) || '交互组件', textOf(widget.description));
  }

  if (cardType === 'present') {
    const present = recordOf(content.present);
    const kind = textOf(present.kind);
    return line(
      PRESENT_KIND_ICON[kind] ?? '📊',
      textOf(present.title) || PRESENT_KIND_LABEL[kind] || '展示卡',
    );
  }

  const approval = APPROVAL_CARD_TITLE[cardType];
  if (approval !== undefined) return line(approval.icon, approval.title);

  return line('🗂️', '卡片');
}

/**
 * 左栏预览文本：可预览的消息返回单行文本（可能含 markdown，由调用方按需
 * 剥离），不可预览（撤回、空文本、内部事件等）返回 null。
 */
export function messagePreviewText(message: Message): string | null {
  if (message.status === 'recalled') return null;

  if (message.kind === 'text') {
    const content = message.content as { text?: unknown; interim?: unknown };
    if (content.interim === true) return null;
    const text = textOf(content.text);
    return text.length > 0 ? text : null;
  }

  if (message.kind === 'system_event') {
    // 存量邮件 / 监看状态卡读出时被改写成系统提示：仍然值得作为预览。
    const content = message.content as { event?: unknown; text?: unknown };
    if (content.event !== 'mail_status' && content.event !== 'watch_status') return null;
    const text = textOf(content.text);
    return text.length > 0 ? line('⚠️', text) : null;
  }

  if (message.kind === 'card') {
    return cardPreviewText(recordOf(message.content)) || null;
  }

  return null;
}
