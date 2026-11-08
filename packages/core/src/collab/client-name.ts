/** 客户端展示名清洗（presence / 草稿租约 / 消息与审批归属共用）。 */
export function sanitizeClientName(name: string): string {
  const cleaned = [...name]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join('')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : '未知客户端';
}
