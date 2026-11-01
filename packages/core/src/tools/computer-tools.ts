import { Type } from '@earendil-works/pi-ai';
import { AppError, TOOL_OUTPUT_MAX_CHARS } from '@kepcup/shared';
import type {
  ComputerActionResult,
  ComputerInvokeMethod,
  ComputerSnapshotResult,
} from '@kepcup/shared';
import { truncateToBudget } from '../agent/tokens.js';
import { untrustedBlock } from '../infra/data-boundary.js';
import type { ToolDefinition, ToolResult, RunIdentity } from '../agent/types.js';
import type {
  ApprovalsService,
  ApprovalOutcome,
} from '../permissions/approvals.js';
import type { ComputerHostRpc } from '../computer/facade.js';
import type { ToolImage } from './browser.js';

/**
 * 计算机操控工具面（D105，docs/design/52 §4）：12 个工具与 sidecar 方法一对一
 * （pressKey / hotkey 合一为 computer_key），任务 loop 才注册（对话轮不注册）。
 *
 * 用法规则浓缩自 orca skills/computer-use，承载在工具描述里（不进常驻提示词）：
 * 无障碍优先、观察-动作-再观察、索引寻址、坐标只取当前帧、web 内容走 browser 工具、
 * 权限被拒不换技术、验证后才算完成。
 *
 * 安全语义（硬约束，执行文档「风险与注意」3/4）：
 * - `ComputerActionVerification` 的 unverified（可能已下发）→ `outcome: 'uncertain'`，
 *   结果文本明示「先观察再决定重试」；
 * - type / paste / set_value 的文本参数标 `sensitiveParams`（审批卡与日志脱敏）；
 * - 权限被拒绝不引入 osascript / AppleScript / 系统事件兜底——错误文案写明。
 */

export interface ComputerToolDeps {
  identity: RunIdentity;
  computer: ComputerHostRpc;
  /** 审批（computer_control）：run 内首个动作前出卡；缺省 = 不出卡（测试）。 */
  requestApproval:
    | ((identity: RunIdentity, kind: 'computer_control', payload: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<ApprovalOutcome>)
    | undefined;
  /** 跨 run 复用：查本会话 / 该 Bot 已有的 conversation / bot 档批准。 */
  approvals?: Pick<ApprovalsService, 'list'> | undefined;
}

/** 审批卡上的三档（对齐 git_remote；默认勾选 conversation 由卡面决定）。 */
const COMPUTER_DURATIONS = ['once', 'conversation', 'bot'] as const;

const SENSITIVE_MASK = '«已隐藏»';

/** 工具描述共用的规则尾（设计 §4 工具描述承载用法规则）。 */
const OBSERVE_RULE =
  '操作遵循「观察-动作-再观察」：动作前先 computer_get_app_state 读树，动作后核对返回的界面状态；结果标注「可能已执行」时，先观察确认实际效果再决定是否重试，不要盲目重放。';

const ADDRESS_RULE =
  '元素索引来自最近一次 computer_get_app_state 的树文本（行首数字）；观察会重排索引，旧索引失效。坐标兜底只使用最近一帧截屏的窗口栅格坐标。';

const SCOPE_RULE =
  '本工具操控原生桌面应用窗口；网页内容一律用 browser 工具。权限被拒绝（PERMISSION_DENIED）时让用户到 设置 › 浏览器 › 计算机操控 授权「KepCup Computer Use」，绝不改用其他自动化方式。';

function asToolFailure(error: unknown, outcome?: ToolResult['outcome']): ToolResult {
  const hint = computerErrorHint(error);
  return {
    ok: false,
    content: hint.message,
    errorCode: hint.code,
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

/** RuntimeClientError code → 模型可读引导（code 原样透传，不改写）。 */
function computerErrorHint(error: unknown): { message: string; code: string } {
  if (error instanceof AppError) {
    switch (error.code) {
      case 'COMPUTER_UNAVAILABLE':
        return { message: '计算机操控宿主不可用（仅桌面端支持；服务端 / 远程场景无此能力）。', code: error.code };
      case 'PERMISSION_DENIED':
        return {
          message:
            '系统权限不足：需要给「KepCup Computer Use」授予辅助功能与屏幕录制权限。请让用户到 设置 › 浏览器 › 计算机操控 的权限引导里授权后重试。权限被拒后不会改用其他自动化方式。',
          code: error.code,
        };
      case 'APP_NOT_FOUND':
        return { message: `未找到目标应用：${error.message}。先 computer_list_apps 查看准确的应用名（跟随系统语言）。`, code: error.code };
      case 'WINDOW_NOT_FOUND':
      case 'WINDOW_STALE':
        return { message: `目标窗口不存在或已失效：${error.message}。用 computer_list_windows 重新选窗，再 computer_get_app_state 刷新。`, code: error.code };
      case 'ELEMENT_NOT_FOUND':
        return { message: `元素索引失效：${error.message}。重新 computer_get_app_state 拿新索引。`, code: error.code };
      case 'BACKGROUND_UNAVAILABLE':
        return { message: `后台输入不可用：${error.message}`, code: error.code };
      default:
        return { message: error.message, code: error.code };
    }
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    code: 'INTERNAL',
  };
}

/**
 * sidecar 错误里「可能已下发」的 code：helper 的 focusRecordFailed 以
 * `window_not_focused` 报出且消息明示 "input may already have been delivered"
 *（main.swift BackgroundInputTransport 部分）——按防重放的保守侧归 uncertain。
 * （CONTROLLER_BUSY 是 ZCode 的错误码，orca 侧不存在；并发防护由 main 单例
 * sidecar + helper 的 AgentSessionOwnership 承担，见 DEVIATIONS DEV-079。）
 */
const MAYBE_SENT_CODES: ReadonlySet<string> = new Set(['WINDOW_NOT_FOCUSED']);

/**
 * 动作结果的 outcome 映射（D105-5 防重放，不得简化）：
 * `action.verification.state === 'unverified'`（可能已下发 / 疑似空转 / 读回不支持）
 * → `uncertain`；verified 或无 verification → completed。
 */
function actionOutcome(result: ComputerActionResult): ToolResult['outcome'] {
  return result.action?.verification?.state === 'unverified' ? 'uncertain' : 'completed';
}

/** 结果前缀：动作通道与验证状态的人话摘要（uncertain 时明示先观察）。 */
function actionPrefix(label: string, result: ComputerActionResult): string {
  const action = result.action;
  const channel = action?.path === 'accessibility' ? '无障碍动作' : action?.path === 'clipboard' ? '剪贴板粘贴' : '合成输入';
  const verification = action?.verification;
  if (verification?.state === 'unverified') {
    return (
      `${label}已通过${channel}发出，但**可能未生效或效果未确认**（${verification.reason}）。` +
      '动作可能已执行：先观察下方界面状态（或再 computer_get_app_state）确认实际效果，确认未生效才重做；不要盲目重放该动作。'
    );
  }
  if (verification?.state === 'verified') {
    return `${label}已通过${channel}执行并验证（${verification.property} 已确认）。`;
  }
  return `${label}已通过${channel}执行。`;
}

/** 快照渲染：树文本 + 截屏（截屏进 images，模型无图像能力时由引擎丢弃并降级）。 */
function renderSnapshot(
  prefix: string,
  result: ComputerSnapshotResult,
  options: { mask?: string | null } = {},
): ToolResult {
  const treeText = options.mask ? result.snapshot.treeText.split(options.mask).join(SENSITIVE_MASK) : result.snapshot.treeText;
  const truncated = truncateToBudget(treeText, TOOL_OUTPUT_MAX_CHARS);
  const diff = result.snapshot.treeDiff;
  const diffNote = diff
    ? `\n[相对基线 ${diff.baseSnapshotId.slice(0, 8)} 的增量：${diff.changed} 变更 / ${diff.added} 新增 / ${diff.removed} 移除]`
    : '';
  const trunc = result.snapshot.truncation?.truncated === true ? '\n[输出已截断]' : '';
  const shot = result.screenshot;
  const shotNote =
    shot?.data && shot.data.length > 0
      ? `\n[附截屏 ${shot.width}x${shot.height}]`
      : result.screenshotStatus.state === 'failed'
        ? `\n[截屏失败：${result.screenshotStatus.message}]`
        : '';
  const content = `${prefix}\n${untrustedBlock(truncated.text)}${diffNote}${trunc}${shotNote}`;
  return {
    ok: true,
    content,
    ...(shot?.data && shot.data.length > 0
      ? { images: [{ mimeType: 'image/png', base64: shot.data } satisfies ToolImage] }
      : {}),
  };
}

export function buildComputerTools(deps: ComputerToolDeps): ToolDefinition[] {
  const { identity, computer } = deps;

  // --- 审批（D105 §5）：run 内首个 computer 动作前出卡一次 -----------------
  let approved = false;
  const ensureApproval = async (
    action: string,
    app: string,
    ctx: { signal: AbortSignal },
  ): Promise<ToolResult | null> => {
    if (approved) return null;
    // 跨 run 复用：用户批过的 conversation / bot 档（自动批准的不算——本 kind 永不自动批）。
    if (deps.approvals !== undefined) {
      const standing = deps.approvals
        .list()
        .find(
          (entry) =>
            entry.kind === 'computer_control' &&
            entry.status === 'approved' &&
            entry.autoApproved !== true &&
            (entry.decision?.duration === 'conversation' ||
              (entry.decision?.duration === 'bot' && entry.botId === identity.botId)),
        );
      if (standing !== undefined) {
        approved = true;
        return null;
      }
    }
    if (deps.requestApproval === undefined) {
      approved = true; // 测试环境：无审批依赖直接放行
      return null;
    }
    const outcome = await deps.requestApproval(
      identity,
      'computer_control',
      { app, summary: action, durations: [...COMPUTER_DURATIONS] },
      { signal: ctx.signal },
    );
    if (outcome.decision === 'approved') {
      approved = true;
      return null;
    }
    // 审批被拒发生在动作前：正常失败结果，不标 uncertain（执行文档 WP4）。
    return {
      ok: false,
      content: '用户未授权计算机操控。询问用户是否开启（设置 › 浏览器 › 计算机操控），未经授权不要操作桌面应用。',
      errorCode: 'COMPUTER_DENIED',
      outcome: 'not_started',
    };
  };

  /** 统一 invoke 包装：审批 → 调用 → 错误分类（MAYBE_SENT → uncertain）。 */
  async function invoke<M extends ComputerInvokeMethod>(
    method: M,
    params: Record<string, unknown>,
    ctx: { signal: AbortSignal },
    options: { approval?: { action: string; app: string }; label?: string } = {},
  ): Promise<ToolResult> {
    if (options.approval !== undefined) {
      const blocked = await ensureApproval(options.approval.action, options.approval.app, ctx);
      if (blocked !== null) return blocked;
    }
    try {
      const result = (await computer.invoke(method, params)) as ComputerSnapshotResult;
      if (method === 'getAppState' || method === 'listApps' || method === 'listWindows' || method === 'capabilities') {
        return renderSnapshot(options.label ?? '已读取应用状态', result);
      }
      const actionResult = result as ComputerActionResult;
      const outcome = actionOutcome(actionResult);
      return { ...renderSnapshot(actionPrefix(options.label ?? '动作', actionResult), actionResult), outcome };
    } catch (error) {
      if (error instanceof AppError && MAYBE_SENT_CODES.has(error.code)) {
        return {
          ...asToolFailure(error, 'uncertain'),
          content: `动作结果未知：${computerErrorHint(error).message} 动作可能已发出——先 computer_get_app_state 观察实际效果，确认未生效再重做。`,
        };
      }
      return asToolFailure(error, 'not_started');
    }
  }

  /** 观察 / 列表类工具（无动作、不需审批）。 */
  const computerListApps: ToolDefinition<Record<string, never>> = {
    name: 'computer_list_apps',
    description:
      `列出本机正在运行的桌面应用（名称跟随系统语言，如英文系统里备忘录是 "Notes"）。操控前先调用它拿准确的应用名。${SCOPE_RULE}`,
    parameters: Type.Object({}),
    execute: async (_params, ctx) => {
      ctx.progress('正在读取应用列表');
      try {
        const result = await computer.invoke('listApps', {});
        const lines = result.apps.map((app) => `- ${app.name}${app.bundleId !== null ? ` (${app.bundleId})` : ''}`);
        const truncated = truncateToBudget(lines.join('\n'), TOOL_OUTPUT_MAX_CHARS);
        return {
          ok: true,
          content: `正在运行的应用（${result.apps.length}）：\n${untrustedBlock(truncated.text)}${truncated.truncated ? '\n[输出已截断]' : ''}`,
        };
      } catch (error) {
        return asToolFailure(error);
      }
    },
  };

  const computerListWindows: ToolDefinition<{ app: string }> = {
    name: 'computer_list_windows',
    description: `列出一个应用的在屏窗口（id / 标题 / 位置尺寸）。后续 computer_get_app_state 用 window_id 或 window_index 指定目标窗。${SCOPE_RULE}`,
    parameters: Type.Object({
      app: Type.String({ description: '应用名或 bundle id（来自 computer_list_apps）' }),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在读取 ${params.app} 的窗口列表`);
      try {
        const result = await computer.invoke('listWindows', { app: params.app });
        const lines = result.windows.map(
          (win) => `- index ${win.index} id ${win.id}: "${win.title}" ${win.width}x${win.height} @ (${win.x},${win.y})`,
        );
        return {
          ok: true,
          content:
            lines.length === 0
              ? `${result.app.name} 没有在屏窗口。`
              : `${result.app.name} 的窗口（${lines.length}）：\n${untrustedBlock(lines.join('\n'))}`,
        };
      } catch (error) {
        return asToolFailure(error);
      }
    },
  };

  const computerGetAppState: ToolDefinition<{
    app: string;
    window_id?: number;
    window_index?: number;
    screenshot?: boolean;
  }> = {
    name: 'computer_get_app_state',
    description:
      `读取一个应用窗口的界面状态：无障碍树的紧凑文本（元素索引在行首，可直接用于后续动作）与可选截屏。首次返回全量树，之后自动返回相对基线的增量。${ADDRESS_RULE}${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: Type.String({ description: '应用名或 bundle id' }),
      window_id: Type.Optional(Type.Number({ description: '目标窗口 id（来自 computer_list_windows）' })),
      window_index: Type.Optional(Type.Number({ description: '目标窗口序号（来自 computer_list_windows）' })),
      screenshot: Type.Optional(
        Type.Boolean({ description: '同时返回窗口截屏（默认 false）。树文本读不到的画面（canvas / 图片）才需要' }),
      ),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在读取 ${params.app} 的界面状态`);
      try {
        const result = await computer.invoke('getAppState', {
          app: params.app,
          ...(params.window_id !== undefined ? { windowId: params.window_id } : {}),
          ...(params.window_index !== undefined ? { windowIndex: params.window_index } : {}),
          ...(params.screenshot === true ? {} : { noScreenshot: true }),
        });
        const prefix =
          `"${result.snapshot.window.title}"（${result.snapshot.elementCount} 个元素` +
          `${result.snapshot.focusedElementId !== null ? `，焦点 ${result.snapshot.focusedElementId}` : ''}）`;
        return renderSnapshot(prefix, result);
      } catch (error) {
        return asToolFailure(error);
      }
    },
  };

  /** 动作类工具共用参数（app + 目标寻址）。 */
  const appParam = Type.String({ description: '应用名或 bundle id' });
  const elementIndexParam = Type.Number({ description: '元素索引（来自最近一次 computer_get_app_state 树文本行首数字）' });

  const computerClick: ToolDefinition<{
    app: string;
    element_index?: number;
    x?: number;
    y?: number;
    mouse_button?: string;
    click_count?: number;
    modifiers?: string;
  }> = {
    name: 'computer_click',
    description: `点击一个元素（优先）或窗口坐标（兜底），后台投递不抢用户焦点。${ADDRESS_RULE}${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      element_index: Type.Optional(elementIndexParam),
      x: Type.Optional(Type.Number({ description: '窗口坐标 X（只与最近一帧截屏对应）' })),
      y: Type.Optional(Type.Number({ description: '窗口坐标 Y（只与最近一帧截屏对应）' })),
      mouse_button: Type.Optional(Type.String({ description: 'left（默认）/ right' })),
      click_count: Type.Optional(Type.Number({ description: '点击次数（默认 1，双击 2）' })),
      modifiers: Type.Optional(Type.String({ description: '修饰键，逗号分隔：cmd / ctrl / alt / shift' })),
    }),
    execute: async (params, ctx) => {
      const at = params.element_index !== undefined ? `元素 ${params.element_index}` : `(${params.x},${params.y})`;
      ctx.progress(`正在点击 ${params.app} 的 ${at}`);
      return invoke('click', { app: params.app, ...targetOf(params), ...clickExtras(params) }, ctx, {
        approval: { action: `点击 ${at}`, app: params.app },
        label: `对 ${params.app} 的 ${at} 的点击`,
      });
    },
  };

  const computerPerformAction: ToolDefinition<{ app: string; element_index: number; action: string }> = {
    name: 'computer_perform_action',
    description: `对元素执行一个无障碍次级动作（来自树文本元素的 Secondary Actions，如 show menu / confirm / press）。${ADDRESS_RULE}${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      element_index: elementIndexParam,
      action: Type.String({ description: '动作名（来自树文本元素的动作列表）' }),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在对 ${params.app} 的元素 ${params.element_index} 执行 ${params.action}`);
      return invoke('performSecondaryAction', { app: params.app, elementIndex: params.element_index, action: params.action }, ctx, {
        approval: { action: `执行动作 ${params.action}`, app: params.app },
        label: `对 ${params.app} 的元素 ${params.element_index} 的 ${params.action}`,
      });
    },
  };

  const computerScroll: ToolDefinition<{
    app: string;
    element_index?: number;
    x?: number;
    y?: number;
    direction: string;
    pages?: number;
  }> = {
    name: 'computer_scroll',
    description: `滚动一个元素或坐标处的内容。${ADDRESS_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      element_index: Type.Optional(elementIndexParam),
      x: Type.Optional(Type.Number({ description: '窗口坐标 X' })),
      y: Type.Optional(Type.Number({ description: '窗口坐标 Y' })),
      direction: Type.String({ description: 'up / down / left / right' }),
      pages: Type.Optional(Type.Number({ description: '滚动页数（默认 1）' })),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在对 ${params.app} ${params.direction} 滚动`);
      return invoke('scroll', { app: params.app, ...targetOf(params), direction: params.direction, ...(params.pages !== undefined ? { pages: params.pages } : {}) }, ctx, {
        approval: { action: '滚动内容', app: params.app },
        label: `${params.app} 的滚动`,
      });
    },
  };

  const computerDrag: ToolDefinition<{
    app: string;
    from_element_index?: number;
    to_element_index?: number;
    from_x?: number;
    from_y?: number;
    to_x?: number;
    to_y?: number;
  }> = {
    name: 'computer_drag',
    description: `从一个元素 / 坐标拖到另一个元素 / 坐标（后台投递）。${ADDRESS_RULE}${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      from_element_index: Type.Optional(elementIndexParam),
      to_element_index: Type.Optional(elementIndexParam),
      from_x: Type.Optional(Type.Number({ description: '起点窗口坐标 X' })),
      from_y: Type.Optional(Type.Number({ description: '起点窗口坐标 Y' })),
      to_x: Type.Optional(Type.Number({ description: '终点窗口坐标 X' })),
      to_y: Type.Optional(Type.Number({ description: '终点窗口坐标 Y' })),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在对 ${params.app} 拖拽`);
      const params2: Record<string, unknown> = { app: params.app };
      if (params.from_element_index !== undefined && params.to_element_index !== undefined) {
        params2.fromElementIndex = params.from_element_index;
        params2.toElementIndex = params.to_element_index;
      } else {
        params2.fromX = params.from_x;
        params2.fromY = params.from_y;
        params2.toX = params.to_x;
        params2.toY = params.to_y;
      }
      return invoke('drag', params2, ctx, {
        approval: { action: '拖拽', app: params.app },
        label: `${params.app} 的拖拽`,
      });
    },
  };

  const computerType: ToolDefinition<{ app: string; text: string; element_index?: number }> = {
    name: 'computer_type',
    description: `向应用的当前焦点输入文本（后台注入）。文本内容按敏感处理：执行记录不保留明文、结果不回显。${ADDRESS_RULE}${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      text: Type.String({ description: '要输入的文本' }),
      element_index: Type.Optional(elementIndexParam),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在向 ${params.app} 输入文本（${params.text.length} 字符）`);
      const result = await invoke(
        'typeText',
        { app: params.app, text: params.text, ...(params.element_index !== undefined ? { elementIndex: params.element_index } : {}) },
        ctx,
        { approval: { action: `输入文本（${params.text.length} 字符，不回显）`, app: params.app }, label: `${params.app} 的文本输入` },
      );
      // sensitiveParams：审批卡 / 日志 / 步骤记录里的 text 全部脱敏（硬约束）。
      return { ...result, sensitiveParams: ['text'], content: maskText(result.content, params.text) };
    },
  };

  const computerKey: ToolDefinition<{ app: string; key: string; repeat?: number; hold_seconds?: number }> = {
    name: 'computer_key',
    description: `按一个键或组合键弦（如 "return"、"cmd+a"、"shift+arrowdown"）。后台注入。${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      key: Type.String({ description: '键名或 + 连接的组合弦（cmd+c / ctrl+shift+t）' }),
      repeat: Type.Optional(Type.Number({ description: '重复次数（默认 1）' })),
      hold_seconds: Type.Optional(Type.Number({ description: '按住秒数（默认点按）' })),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在对 ${params.app} 按键 ${params.key}`);
      const method: ComputerInvokeMethod = params.key.includes('+') ? 'hotkey' : 'pressKey';
      return invoke(method, { app: params.app, key: params.key, ...(params.repeat !== undefined ? { repeat: params.repeat } : {}), ...(params.hold_seconds !== undefined ? { holdSeconds: params.hold_seconds } : {}) }, ctx, {
        approval: { action: `按键 ${params.key}`, app: params.app },
        label: `${params.app} 的按键 ${params.key}`,
      });
    },
  };

  const computerPaste: ToolDefinition<{ app: string; text: string; format?: string }> = {
    name: 'computer_paste',
    description: `通过系统剪贴板把文本粘贴进应用（粘贴前经剪贴板校验，防提示注入）。优先用于大段文本（比逐字输入快且可靠）。文本按敏感处理。${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      text: Type.String({ description: '要粘贴的文本' }),
      format: Type.Optional(Type.String({ description: '剪贴板格式（默认纯文本）' })),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在向 ${params.app} 粘贴文本（${params.text.length} 字符）`);
      const result = await invoke('pasteText', { app: params.app, text: params.text, ...(params.format !== undefined ? { format: params.format } : {}) }, ctx, {
        approval: { action: `粘贴文本（${params.text.length} 字符，不回显）`, app: params.app },
        label: `${params.app} 的粘贴`,
      });
      return { ...result, sensitiveParams: ['text'], content: maskText(result.content, params.text) };
    },
  };

  const computerSetValue: ToolDefinition<{ app: string; element_index: number; value: string }> = {
    name: 'computer_set_value',
    description: `直接设置一个元素的值（无障碍 set-value，不经键盘；适合下拉选择、开关等控件）。值按敏感处理。${ADDRESS_RULE}${OBSERVE_RULE}${SCOPE_RULE}`,
    parameters: Type.Object({
      app: appParam,
      element_index: elementIndexParam,
      value: Type.String({ description: '要设置的值（下拉的选项文本 / 开关的 on-off 等）' }),
    }),
    execute: async (params, ctx) => {
      ctx.progress(`正在设置 ${params.app} 元素 ${params.element_index} 的值`);
      const result = await invoke('setValue', { app: params.app, elementIndex: params.element_index, value: params.value }, ctx, {
        approval: { action: `设置元素 ${params.element_index} 的值（不回显）`, app: params.app },
        label: `${params.app} 元素 ${params.element_index} 的赋值`,
      });
      return { ...result, sensitiveParams: ['value'], content: maskText(result.content, params.value) };
    },
  };

  const computerStop: ToolDefinition<{ reason?: string }> = {
    name: 'computer_stop',
    description: '结束当前计算机操控会话（释放对桌面输入的占用）。完成操控任务后调用；用户也可以随时从界面上的「停止操控」按钮停止。',
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ description: '停止原因（便于说明）' })),
    }),
    execute: async (params, ctx) => {
      ctx.progress('正在停止操控会话');
      try {
        const out = await computer.stop(params.reason);
        return {
          ok: true,
          outcome: 'completed',
          content: out.stopped ? '操控会话已停止。' : '没有进行中的操控会话。',
        };
      } catch (error) {
        return asToolFailure(error);
      }
    },
  };

  return [
    computerListApps,
    computerListWindows,
    computerGetAppState,
    computerClick,
    computerPerformAction,
    computerScroll,
    computerDrag,
    computerType,
    computerKey,
    computerPaste,
    computerSetValue,
    computerStop,
  ];
}

/** 索引寻址或坐标兜底的公共映射。 */
function targetOf(params: { element_index?: number; x?: number; y?: number }): Record<string, unknown> {
  if (params.element_index !== undefined) return { elementIndex: params.element_index };
  return { x: params.x, y: params.y };
}

function clickExtras(params: { mouse_button?: string; click_count?: number; modifiers?: string }): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  if (params.mouse_button !== undefined) extras.mouseButton = params.mouse_button;
  if (params.click_count !== undefined) extras.clickCount = params.click_count;
  if (params.modifiers !== undefined) extras.modifiers = params.modifiers;
  return extras;
}

/** 结果文本里的敏感值脱敏（对齐 browser_type 的 mask 语义）。 */
function maskText(content: string, value: string): string {
  if (value.length < 4) return content;
  return content.split(value).join(SENSITIVE_MASK);
}
