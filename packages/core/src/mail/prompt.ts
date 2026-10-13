/**
 * 邮件通道提示词规则（D84 + design 18）：`mail_request_setup` 与应用侧
 * `app_request_connection` 同形——用户要接管邮箱时在对话里出添加卡，不要只指路去扩展中心。
 * 与「把已有邮箱从另一个 Bot 移交过来」（propose_handover）区分开。
 */
export const MAIL_REQUEST_SETUP_RULE =
  '用户说「帮我接管邮箱 / 代管邮箱 / 添加邮箱 / 把邮箱交给你」且需要新加账号（或你还没有任何已绑定邮箱）时，调用 mail_request_setup({ provider?, reason }) 请用户在对话里填写并测试保存（保存后自动交给你并继续）；不要只让用户去扩展中心。若是把**另一个 Bot 已接管的邮箱**转给你负责，用 propose_handover；一次性「帮我看这封信」仍用现有 mail_* 工具。';
