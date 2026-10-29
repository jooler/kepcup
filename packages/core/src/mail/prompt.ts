/**
 * 邮件通道提示词规则（D84 + design 18）：`mail_request_setup` 与应用侧
 * `app_request_connection` 同形——用户要接管邮箱时在对话里出添加卡，不要只指路去扩展中心。
 * D91 后续：`mail_request_setup` 有 mail 就注册（有无绑定都一样），本规则随它出现，所以措辞
 * 不依赖「是否已有绑定」——已有绑定时同样调用，会新增一个、原有的保持不变。
 * 与「把已有邮箱从另一个 Bot 移交过来」（propose_handover）区分开。
 */
const MAIL_REQUEST_SETUP_BASE =
  '用户说「帮我接管邮箱 / 代管邮箱 / 添加（更多）邮箱 / 把邮箱交给你」时，**立刻**调用 mail_request_setup({ reason? })，不要先让用户去扩展中心、不要先口头确认「要不要弹配置卡」；你已有绑定邮箱时也一样，会再新增一个，原有的保持不变。保存后自动交给你并继续（还没有绑定邮箱时，续跑时才有 mail_list / mail_read / mail_send 等邮件读写工具）。不要索要授权码，也不要让用户把授权码贴进聊天；';

/**
 * 普通 Bot（D88 P1：只能交出自己的资产）：别的 Bot 已接管的邮箱，由持有者或管家发起移交。
 */
export const MAIL_REQUEST_SETUP_RULE = `${MAIL_REQUEST_SETUP_BASE}要接过**另一个 Bot 已接管的邮箱**时，你自己不能替对方提移交（移交只能由持有者发起，或由管家发起），请用户让管家或原来负责的 Bot 发起 propose_handover。还没有绑定邮箱时你读不了信，一次性「帮我看这封信」也要先走上面的添加流程。`;

/**
 * 管家（D88：可以以任何 Bot 为来源提移交，与 BUTLER_RULES 一致）：把另一个 Bot 已接管的
 * 邮箱移交过来用 propose_handover（来源填那个 Bot）。
 */
export const MAIL_REQUEST_SETUP_RULE_BUTLER = `${MAIL_REQUEST_SETUP_BASE}要把**另一个 Bot 已接管的邮箱**转给你（或别的 Bot）负责时，用 propose_handover（from_bot_id 填原来负责的 Bot，先用 inspect_bot_assets 盘点）。还没有绑定邮箱时你读不了信，一次性「帮我看这封信」也要先走上面的添加流程。`;

/** The mail setup rule for this bot (butler vs regular bot wording). */
export function mailRequestSetupRule(butler: boolean): string {
  return butler ? MAIL_REQUEST_SETUP_RULE_BUTLER : MAIL_REQUEST_SETUP_RULE;
}
