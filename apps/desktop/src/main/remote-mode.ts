/**
 * 桌面远程模式（design 49 §7「桌面远程模式壳」）：`KEPCUP_REMOTE_URL` 指向一个
 * headless 服务端时，Electron 壳不启动本地 core，主窗口直接加载服务端托管的 web
 * 构建——与浏览器打开同一地址走同一条代码路径（`window.kepcup.isWeb` 由 web 垫片
 * 打标，渲染层因此走 WebSocket 传输）。
 *
 * 这里只做解析与校验：主进程的接线（跳过 core / 窗口不挂 preload）在 index.ts，
 * 窗口加载与导航策略在 window.ts。
 */

export interface RemoteModeTarget {
  /** 主窗口加载的 URL（去掉 query 与 hash，保留路径）。 */
  url: string;
  /** 权限白名单与导航判定使用的 origin。 */
  origin: string;
}

/**
 * 读取 `KEPCUP_REMOTE_URL`。未设置（或空串）= 本地模式，返回 null；设置但非法直接
 * 抛错——悄悄回落到本地模式会让用户以为连上了远端，实际写的是另一份数据。
 */
export function resolveRemoteMode(env: NodeJS.ProcessEnv): RemoteModeTarget | null {
  const raw = env['KEPCUP_REMOTE_URL']?.trim() ?? '';
  if (raw === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`KEPCUP_REMOTE_URL 不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`KEPCUP_REMOTE_URL 只支持 http / https：${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('KEPCUP_REMOTE_URL 不能内嵌用户名 / 密码');
  }

  const clean = new URL(parsed.origin + parsed.pathname);
  return { url: clean.toString(), origin: clean.origin };
}

/** 该 URL 是否 http(s)（远程模式下外链交给系统浏览器）。 */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
