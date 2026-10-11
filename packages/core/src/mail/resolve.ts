/**
 * 对话里模型经常把邮箱地址、显示名，或用户原话（「JERR jerr@foxmail.com」）
 * 当成 account_id。库里的主键是 mal_…，对不上就抛「邮箱不存在」。
 * 这里在该 Bot 已绑定的账号里按 id、地址、显示名解析；只有一个邮箱时，
 * 填错或省略也用那一个。填了别的 mal_ id 则不悄悄换号。
 */

export interface MailAccountRef {
  id: string;
  address: string;
  label: string;
  username: string;
}

export type BoundAccountMatch<T extends MailAccountRef> =
  | { ok: true; account: T }
  | { ok: false; code: 'MAIL_NOT_BOUND' | 'NOT_FOUND' | 'INVALID_INPUT'; message: string };

export function resolveBoundAccount<T extends MailAccountRef>(
  bound: readonly T[],
  raw: string | undefined,
): BoundAccountMatch<T> {
  if (bound.length === 0) {
    return {
      ok: false,
      code: 'MAIL_NOT_BOUND',
      message: '当前没有交给你的邮箱。请在扩展中心「邮件」里把邮箱交给这个 Bot。',
    };
  }
  const needle = (raw ?? '').trim();
  if (needle.length === 0) {
    if (bound.length === 1) return { ok: true, account: bound[0]! };
    return { ok: false, code: 'INVALID_INPUT', message: `有多个邮箱，请指定 id 或地址：\n${describe(bound)}` };
  }
  const lower = needle.toLowerCase();
  const exact = bound.find(
    (account) =>
      account.id === needle ||
      account.address.toLowerCase() === lower ||
      account.label.toLowerCase() === lower ||
      account.username.toLowerCase() === lower,
  );
  if (exact !== undefined) return { ok: true, account: exact };
  const contained = bound.filter((account) => {
    const address = account.address.toLowerCase();
    return address.length > 0 && lower.includes(address);
  });
  if (contained.length === 1) return { ok: true, account: contained[0]! };
  if (bound.length === 1 && !needle.startsWith('mal_')) return { ok: true, account: bound[0]! };
  return {
    ok: false,
    code: 'NOT_FOUND',
    message: `没有找到邮箱「${needle}」。请改用下面的 id 或地址：\n${describe(bound)}`,
  };
}

function describe(bound: readonly MailAccountRef[]): string {
  return bound.map((account) => `- ${account.id} ${account.label} <${account.address}>`).join('\n');
}
