// 脱敏：类 token / key 的字段值 -> '***'；已知密钥字面量在任意字符串中也被替换。
const KEY_RE = /(token|secret|password|passwd|authorization|credential|cookie|bearer|api[-_]?key|apikey|private[-_]?key|session[-_]?key|access[-_]?key)/i;
const KEY_EXEMPT_RE = /^(maxTokens|.*Tokens|tokens|.*_tokens|.*Count|authMethods?|authMethodId|authType|authenticate|auth|terminal-auth)$/i;
const VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bAIza[A-Za-z0-9_-]{30,}/g,
];
const MAX_STRING = 20000;

export const secrets = new Set();
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
}

function scrubString(s) {
  for (const sec of secrets) if (s.includes(sec)) s = s.split(sec).join('***');
  for (const re of VALUE_RES) s = s.replace(re, '***');
  if (s.length > MAX_STRING) s = `${s.slice(0, MAX_STRING)}…[truncated ${s.length - MAX_STRING}]`;
  return s;
}

function sensitiveKey(k) {
  return KEY_RE.test(k) && !KEY_EXEMPT_RE.test(k);
}

export function redact(value, depth = 0) {
  if (depth > 40) return '[depth]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    // { name: 'Authorization', value: '...' } / env 数组项
    const nameSensitive = typeof value.name === 'string' && sensitiveKey(value.name);
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string' && (sensitiveKey(k) || (nameSensitive && k === 'value'))) out[k] = '***';
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
