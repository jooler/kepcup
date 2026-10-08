/**
 * 主窗口 default session 的权限策略（docs/design/31-sensors.md，D76-7）。
 *
 * Electron 在未设置处理器时默认放行**所有**权限请求。主窗口只加载本地界面，
 * 因此收紧为白名单：来源必须是应用自身（dev 的 renderer URL 或打包的 file://），
 * 且权限属于下列几类；其余一律拒绝（Bot 浏览器各自的 session 已全拒，见
 * browser-host.ts）。
 *
 * 白名单依据（审计结论，见 todo/sensors.md P4）：
 * - `media`：麦克风 / 摄像头（传感器层 getUserMedia + enumerateDevices 标签检查）。
 *   只放行 audio / video；标准屏幕共享（getDisplayMedia → display-capture）是独立权限，拒绝。
 *   已知局限：旧式 `chromeMediaSource: 'desktop'` 的 getUserMedia 同样以 video 上报，
 *   此处无法区分——该路径需要渲染层已有代码执行（CSP script-src 'self'），风险低。
 * - `clipboard-sanitized-write`：界面里的复制按钮（navigator.clipboard.writeText）。
 * - `fullscreen`：消息里 <video controls> 的全屏键。
 */

export const ALLOWED_APP_PERMISSIONS: ReadonlySet<string> = new Set([
  'media',
  'clipboard-sanitized-write',
  'fullscreen',
]);

export interface PermissionQuery {
  permission: string;
  /** 请求方 URL（权限请求的 requestingUrl / 检查的 requestingOrigin）。 */
  requestingUrl: string;
  /** `media` 请求的轨道类型；其他权限无此字段。 */
  mediaTypes?: readonly string[];
  /** 应用界面的基准 URL（dev 的 renderer URL，或打包版的 file:// 入口）。 */
  appUrl: string;
}

/** 请求方是否就是应用自身界面。file:// 的 origin 是不透明的，按协议比较。 */
export function isAppOrigin(requestingUrl: string, appUrl: string): boolean {
  try {
    const requesting = new URL(requestingUrl);
    const app = new URL(appUrl);
    if (app.protocol === 'file:') return requesting.protocol === 'file:';
    return requesting.origin === app.origin;
  } catch {
    return false;
  }
}

export function isPermissionAllowed(query: PermissionQuery): boolean {
  if (!isAppOrigin(query.requestingUrl, query.appUrl)) return false;
  if (!ALLOWED_APP_PERMISSIONS.has(query.permission)) return false;
  if (query.permission === 'media') {
    const types = query.mediaTypes ?? [];
    return types.every((type) => type === 'audio' || type === 'video');
  }
  return true;
}
