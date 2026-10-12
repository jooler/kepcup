import { randomBytes } from 'node:crypto';
import {
  MCP_APP_SCHEME,
  WIDGET_PREVIEW_HOST_PREFIX,
  WIDGET_PREVIEW_OUTLINE_MAX_CHARS,
  widgetPreviewFindingSchema,
  widgetPreviewRuleSchema,
  type WidgetAcceptance,
  type WidgetPreviewFinding,
  type WidgetPreviewViewportResult,
} from '@kepcup/shared';

/**
 * S2 预览宿主的纯函数部分（D87 P3b，设计 32 §11.9；无 Electron 依赖，可单测）：资源地址、导航 /
 * 请求判定、探针回报的清洗、主进程 `console-message` 兜底通道的合并去重、截图空白判定。
 * Electron 部分见 `widget-preview.ts`，外壳页见 `widget-preview-shell.ts`。
 */

/** 预览专用的内存分区（无 `persist:`，实测不落盘）。 */
export const PREVIEW_PARTITION = 'widget-preview';
/** 单个视口结果里 findings 的上限（同 shared schema）。 */
export const PREVIEW_FINDINGS_MAX = 200;
/** 预览资源地址的前缀（`kepcup-app://widget-preview-…/`）。 */
export const PREVIEW_URL_PREFIX = `${MCP_APP_SCHEME}://${WIDGET_PREVIEW_HOST_PREFIX}`;

/**
 * 每个视口一个新的随机 host（避免被分进上一个还没回收的进程）与资源 id；两者都过既有
 * `parseAppUiUrl` 的形状校验（host `[a-z0-9-]{1,63}`、id `[A-Za-z0-9_-]{16,64}`）。
 */
export function newPreviewResource(): { host: string; resourceId: string; url: string } {
  const host = `${WIDGET_PREVIEW_HOST_PREFIX}${randomBytes(12).toString('hex')}`;
  const resourceId = randomBytes(16).toString('base64url');
  return { host, resourceId, url: `${MCP_APP_SCHEME}://${host}/${resourceId}` };
}

/**
 * 预览窗口的导航判定（失败即关闭）：主框架只许是外壳页自己（`loadFile` 是程序发起的，通常不经过
 * 这个事件）；子框架只许**首次**导航（框架还是空白）到预览资源，已加载组件的框架不能再去任何地方。
 */
export function shouldBlockPreviewNavigation(input: {
  isMainFrame: boolean;
  /** 发起导航的框架当前 URL；框架未知 = undefined。 */
  frameUrl: string | undefined;
  targetUrl: string;
  /** 外壳页的 file:// URL。 */
  shellUrl: string | null;
}): boolean {
  if (input.isMainFrame)
    return input.shellUrl === null || !sameUrl(input.targetUrl, input.shellUrl);
  const fresh =
    input.frameUrl === undefined || input.frameUrl === '' || input.frameUrl === 'about:blank';
  return !(fresh && input.targetUrl.startsWith(PREVIEW_URL_PREFIX));
}

/**
 * 预览分区的请求白名单（webRequest 兜底；CSP 已经先拦一道）：外壳页本身、预览资源、内联的
 * data: / blob: / about:，其余（http(s)、别的 file:、别的 kepcup-app 资源）一律取消。
 */
export function isPreviewRequestAllowed(url: string, shellUrl: string | null): boolean {
  if (url.startsWith(PREVIEW_URL_PREFIX)) return true;
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return true;
  return shellUrl !== null && sameUrl(url, shellUrl);
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** 主进程 `console-message` 的一条（只收预览组件框架的）。 */
export interface PreviewConsoleEntry {
  level: string;
  message: string;
  line: number;
}

/** 把 console 文本归到 S2 规则：只认未捕获异常 / promise 拒绝 / CSP 违规（console 输出由探针负责）。 */
export function classifyConsoleMessage(
  message: string,
): { rule: 'runtime.error' | 'runtime.rejection' | 'csp.violation'; text: string } | null {
  const rejection = /^Uncaught \(in promise\)\s*/.exec(message);
  if (rejection !== null)
    return { rule: 'runtime.rejection', text: message.slice(rejection[0].length) };
  if (/^Uncaught\b/.test(message)) return { rule: 'runtime.error', text: message };
  if (/Content Security Policy/i.test(message)) return { rule: 'csp.violation', text: message };
  return null;
}

/** CSP 文本的去重键：被拦的 URL（首个引号内容），eval / 内联脚本另给固定键（探针报的 blockedURI 同名）。 */
function cspKey(message: string): string {
  if (/evaluate a string as JavaScript/i.test(message)) return 'eval';
  if (/execute inline|inline (script|style|event handler)/i.test(message)) return 'inline';
  return /'([^']+)'/.exec(message)?.[1] ?? message;
}

/**
 * 防篡改对照（设计 32 §11.9）：组件就算覆盖了探针，主进程 `console-message` 仍能看到未捕获异常、
 * promise 拒绝与 CSP 违规。这里把探针漏掉的并进来，按文本去重（双方都看到的只留探针那条——
 * 它带 trigger 与列号）。
 */
export function mergeConsoleFindings(
  probe: readonly WidgetPreviewFinding[],
  entries: readonly PreviewConsoleEntry[],
): WidgetPreviewFinding[] {
  const out = [...probe];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.level !== 'error') continue;
    const hit = classifyConsoleMessage(entry.message);
    if (hit === null) continue;
    const dupKey = `${hit.rule}|${hit.rule === 'csp.violation' ? cspKey(hit.text) : hit.text}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const known = out.some((finding) => {
      if (finding.rule !== hit.rule) return false;
      if (hit.rule === 'csp.violation') return finding.message.includes(cspKey(hit.text));
      return (
        finding.message === hit.text ||
        finding.message.includes(hit.text) ||
        hit.text.includes(finding.message)
      );
    });
    if (known) continue;
    out.push({
      rule: hit.rule,
      message: truncate(hit.text, 500),
      ...(entry.line >= 1 ? { line: Math.floor(entry.line) } : {}),
    });
  }
  return out.slice(0, PREVIEW_FINDINGS_MAX);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 探针回报的 findings 清洗：探针与组件同一个 realm，回报内容按不可信输入处理——形状不对的
 * 条目丢弃，文本截断到 schema 上限。
 */
export function sanitizeProbeFindings(raw: unknown): WidgetPreviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: WidgetPreviewFinding[] = [];
  for (const item of raw.slice(0, PREVIEW_FINDINGS_MAX)) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rule = widgetPreviewRuleSchema.safeParse(record['rule']);
    if (!rule.success || typeof record['message'] !== 'string') continue;
    const candidate = {
      rule: rule.data,
      message: truncate(record['message'], 1_900),
      ...(isPositiveInt(record['line']) ? { line: record['line'] } : {}),
      ...(isPositiveInt(record['col']) ? { col: record['col'] } : {}),
      ...(typeof record['trigger'] === 'string' && record['trigger'] !== ''
        ? { trigger: truncate(record['trigger'], 290) }
        : {}),
    };
    const parsed = widgetPreviewFindingSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * 验收结果按**输入**的验收点逐条对齐（id 与 must 以输入为准，探针只贡献 passed / detail）；
 * 探针没回报的条目记失败。
 */
export function alignAcceptance(
  acceptance: WidgetAcceptance | null,
  raw: unknown,
  missingDetail = '未执行（探针没有回报这一条）',
): WidgetPreviewViewportResult['acceptance'] {
  if (acceptance === null) return [];
  const reported = new Map<string, Record<string, unknown>>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || typeof item !== 'object') continue;
      const id = (item as Record<string, unknown>)['id'];
      if (typeof id === 'string' && !reported.has(id))
        reported.set(id, item as Record<string, unknown>);
    }
  }
  return acceptance.map((item) => {
    const got = reported.get(item.id);
    if (got === undefined)
      return { id: item.id, must: item.must, passed: false, detail: missingDetail };
    const detail = typeof got['detail'] === 'string' ? truncate(got['detail'], 500) : '';
    return { id: item.id, must: item.must, passed: got['passed'] === true, detail };
  });
}

/** 大纲按 schema 上限截断。 */
export function sanitizeOutline(raw: unknown): string {
  return typeof raw === 'string' ? truncate(raw, WIDGET_PREVIEW_OUTLINE_MAX_CHARS) : '';
}

/** 外链记录（外壳页已按 https 规范化；这里只做形状与数量兜底）。 */
export function sanitizeLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((url): url is string => typeof url === 'string')
    .slice(0, 50)
    .map((url) => truncate(url, 2_048));
}

/**
 * 探针跑完之后这一视口算不算数：组件框架是 0×0 视口时（跨进程 iframe 的尺寸没同步过去）渲染体检、
 * 乱点与大纲都不可信（innerText 会退化成含脚本源码的 textContent），记 `failed` 让 core 按「没跑」
 * 处理，而不是报一堆假问题；探针没报 ready 或自身出错只记在 detail 里。
 */
export function probeVerdict(input: { probeReady: boolean; viewport: unknown; error: unknown }): {
  status: 'ok' | 'failed';
  detail: string;
} {
  const size = Array.isArray(input.viewport) ? input.viewport : null;
  if (size !== null && (size[0] === 0 || size[1] === 0)) {
    return { status: 'failed', detail: '组件框架没有拿到视口尺寸（0×0），预览结果不可信' };
  }
  const notes: string[] = [];
  if (!input.probeReady) notes.push('探针没有报告就绪（按 iframe load 之后的宽限继续检查）');
  if (typeof input.error === 'string' && input.error !== '')
    notes.push(`探针出错：${truncate(input.error, 200)}`);
  return { status: 'ok', detail: notes.join('；') };
}

/** 超时诊断（外壳 `drop()` 返回的进度）→ `preview.timeout` 的文字。 */
/**
 * 探针在时限内没回报、但组件框架还能应答（审查修复）：页面长时间无响应（连续的长任务把事件循环
 * 占满）或组件弄坏了探针。对用户来说同样是「卡」，记阻断项 preview.timeout——不能当成宿主故障
 * 把组件放行。
 */
export function unresponsiveFinding(input: {
  timeoutMs: number;
  lastTrigger: string | null;
}): WidgetPreviewFinding {
  const seconds = Math.round(input.timeoutMs / 100) / 10;
  const where = input.lastTrigger !== null ? `（最后一步：${input.lastTrigger}）` : '';
  return {
    rule: 'preview.timeout',
    message: truncate(
      `预览 ${seconds}s 内页面没有完成检查${where}：页面一直在执行长任务、几乎不响应，或组件改写了浏览器的全局对象（如 Array.prototype、postMessage）`,
      1_900,
    ),
    ...(input.lastTrigger !== null ? { trigger: truncate(input.lastTrigger, 300) } : {}),
  };
}

export function timeoutFinding(input: {
  timeoutMs: number;
  stage: string | null;
  lastTrigger: string | null;
}): WidgetPreviewFinding {
  const seconds = Math.round(input.timeoutMs / 100) / 10;
  const where =
    input.stage === 'loading'
      ? '页面加载期间（load 事件始终没有触发）'
      : input.stage === 'loaded'
        ? '页面加载完成后、开始检查之前'
        : input.stage === 'inspecting'
          ? input.lastTrigger !== null
            ? ` ${input.lastTrigger} 这一步`
            : '渲染体检期间'
          : '';
  return {
    rule: 'preview.timeout',
    message: truncate(
      `预览 ${seconds}s 内没有完成${where !== '' ? `，卡在${where}` : ''}：多半是死循环或长时间的同步计算，组件进程已被回收`,
      1_900,
    ),
    ...(input.stage === 'inspecting' && input.lastTrigger !== null
      ? { trigger: truncate(input.lastTrigger, 290) }
      : {}),
  };
}

/**
 * 截图是否「整幅一个颜色」（BGRA 位图）：跨进程 iframe 的首帧要 100–200ms 才合成，`load` 之后
 * 第一张常常还是外壳底色（spike 实测）——这种图要重试。
 */
export function isUniformBitmap(bitmap: Uint8Array, tolerance = 2): boolean {
  if (bitmap.length < 4) return true;
  const b0 = bitmap[0]!;
  const g0 = bitmap[1]!;
  const r0 = bitmap[2]!;
  for (let i = 4; i + 2 < bitmap.length; i += 4) {
    if (
      Math.abs(bitmap[i]! - b0) > tolerance ||
      Math.abs(bitmap[i + 1]! - g0) > tolerance ||
      Math.abs(bitmap[i + 2]! - r0) > tolerance
    ) {
      return false;
    }
  }
  return true;
}

/** 进程是否还在（`kill(pid, 0)` 只探测不发信号）。 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在、只是不归我们管（不会是自己的渲染进程，但按「还在」算更保守）。
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
