/**
 * 邮件通道提示词规则（D84 + design 18）：`mail_request_setup` 与应用侧
 * `app_request_connection` 同形——用户要接管邮箱时在对话里出添加卡，不要只指路去扩展中心。
 * 与「把已有邮箱从另一个 Bot 移交过来」（propose_handover）区分开。
 */
export const MAIL_REQUEST_SETUP_RULE =
  '用户说「帮我接管邮箱 / 代管邮箱 / 添加邮箱 / 把邮箱交给你」时：若你还没有任何已绑定邮箱（<mail_accounts> 为空，或 mail_accounts 显示没有），**立刻**调用 mail_request_setup({ provider?, reason })，不要先让用户去扩展中心、不要先口头确认「要不要弹配置卡」。保存后自动交给你并继续。若你已有绑定邮箱，不要再调 mail_request_setup——直接用 mail_*，或告知已接管；要接过**另一个 Bot 已接管的邮箱**时，你自己不能替对方提移交（移交只能由持有者发起，或由管家发起），请用户让管家或原来负责的 Bot 发起 propose_handover。一次性「帮我看这封信」仍用 mail_*。';
