import { isShareIntakeId } from '@kepcup/shared';

/**
 * D94 §7.2：主应用注册的 URL Scheme（`kepcup://share-intake?id=…`）。
 * 扩展写完 inbox 后用它唤起主应用；主应用无论是否已运行都从 inbox 消费。
 */

/** 注册的 scheme（electron-builder.yml 的 CFBundleURLTypes 与之一致）。 */
export const SHARE_URL_SCHEME = 'kepcup';

export interface ShareIntakeUrl {
  kind: 'share-intake';
  intakeId: string;
}

/**
 * 解析 `kepcup://share-intake?id=shr_…`。不是分享 URL 或 id 不合法时返回
 * null（调用方忽略，不当作错误）。
 */
export function parseShareUrl(raw: string): ShareIntakeUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${SHARE_URL_SCHEME}:`) return null;
  // kepcup://share-intake?id=… → host = 'share-intake'
  if (url.hostname !== 'share-intake' && url.pathname.replace(/^\/+/, '') !== 'share-intake') {
    return null;
  }
  const intakeId = url.searchParams.get('id') ?? '';
  if (!isShareIntakeId(intakeId)) return null;
  return { kind: 'share-intake', intakeId };
}
