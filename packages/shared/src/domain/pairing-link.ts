/**
 * 配对链接（D96 design 46 §3.1，D122 从 renderer 的 ws-transport.ts 上移为两端
 * 共用）：桌面出码内容是 `<origin>/#pair=<relayUrl>,<sessionId>,<pairingSecret>`。
 * 解析端原有两个：renderer 的 Gate / 传输层（粘贴、深链、页内扫码），以及 D122
 * 起的 apps/mobile 原生首页（原生扫码结果要先识别「是不是配对码」再交接给
 * WebView 里的 web 客户端）——纯函数、无运行时依赖，放 shared 避免第三份拷贝。
 */

import { RELAY_SESSION_ID_PATTERN } from './remote.js';

export interface PairingLink {
  relayUrl: string;
  sessionId: string;
  /** 16B 配对码的 base64url（一次性，5 分钟有效）。 */
  secret: string;
}

/** 解析配对链接（容忍整条 URL 或只有 `#pair=…` 片段）；不合法返回 null。 */
export function parsePairingLink(raw: string): PairingLink | null {
  const text = raw.trim();
  const at = text.indexOf('#pair=');
  const marker = at >= 0 ? text.slice(at + 6) : text.startsWith('pair=') ? text.slice(5) : null;
  if (marker === null) return null;
  const parts = marker.split(',');
  if (parts.length !== 3) return null;
  const [relayPart, sessionId, secret] = parts as [string, string, string];
  let relayUrl: string;
  try {
    relayUrl = decodeURIComponent(relayPart);
    const url = new URL(relayUrl);
    if ((url.protocol !== 'wss:' && url.protocol !== 'ws:') || url.hostname.length === 0)
      return null;
  } catch {
    return null;
  }
  if (
    !RELAY_SESSION_ID_PATTERN.test(sessionId) ||
    secret.length < 8 ||
    !/^[A-Za-z0-9_-]+$/.test(secret)
  ) {
    return null;
  }
  return { relayUrl: relayUrl.replace(/\/+$/, ''), sessionId, secret };
}
