import { defaultDeviceName } from '$lib/device-name';

/**
 * 本客户端的显示名（D121 P3）：只存 localStorage，不上报核心设置。
 * 多客户端协作里其他设备看到的就是这个名字（presence / 消息 / 审批归属）。
 */

const CLIENT_NAME_KEY = 'kepcup.collab.clientName';
export const CLIENT_NAME_MAX_CHARS = 80;

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function sanitize(raw: string): string {
  const cleaned = [...raw]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join('')
    .trim()
    .slice(0, CLIENT_NAME_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : defaultDeviceName();
}

function initial(): string {
  const stored = storage()?.getItem(CLIENT_NAME_KEY)?.trim();
  return stored !== undefined && stored.length > 0
    ? stored.slice(0, CLIENT_NAME_MAX_CHARS)
    : defaultDeviceName();
}

class ClientNameState {
  name = $state(initial());

  setName(next: string): void {
    const value = sanitize(next);
    this.name = value;
    try {
      storage()?.setItem(CLIENT_NAME_KEY, value);
    } catch {
      // 隐私模式 / 配额满：本次会话内仍然生效。
    }
  }
}

export const clientNameState = new ClientNameState();
