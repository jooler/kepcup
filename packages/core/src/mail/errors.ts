import { AppError } from '@kepcup/shared';

/**
 * 邮件错误的归类（IMAP 与 SMTP 共用）。会话层靠它决定「还重试吗」，服务层靠它决定
 * 给模型和用户看什么，两处必须是同一套判断。
 */

export interface MailErrorFields {
  name?: string;
  message: string;
  code?: string;
  responseText?: string;
  responseStatus?: string;
  /** message 与服务器应答拼在一起的原文，只能先脱敏再外传。 */
  detail: string;
}

export function mailErrorFields(error: unknown): MailErrorFields {
  if (!(error instanceof Error)) {
    const message = String(error);
    return { message, detail: message };
  }
  const extra = error as Error & {
    code?: string;
    responseText?: string;
    responseStatus?: string;
    response?: unknown;
  };
  // imapflow 在认证失败时把 `response` 改写成文本；SMTP 则是 `response`（整行）与 `responseCode`。
  const responseText =
    typeof extra.responseText === 'string'
      ? extra.responseText
      : typeof extra.response === 'string'
        ? extra.response
        : '';
  const detail = [error.message, responseText].filter((part) => part.length > 0).join(' | ');
  return {
    name: error.name,
    message: error.message,
    ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
    ...(responseText.length > 0 ? { responseText } : {}),
    ...(typeof extra.responseStatus === 'string' ? { responseStatus: extra.responseStatus } : {}),
    detail,
  };
}

/** 服务器说「稍后再试 / 登录太频繁」的措辞。 */
const THROTTLE_PATTERN =
  /too many|too frequent|frequen|rate.?limit|throttl|try again|temporar|later|busy|limit(?:ed|ation)? exceeded|exceed/i;

/**
 * 应答文本里明确的「凭据不对」措辞。注意 QQ 对错误授权码的应答会同时带这类措辞和
 * 「frequency limited / busy」（一句话列举所有可能原因），所以它必须先于限流措辞判断。
 */
const AUTH_TEXT_PATTERN =
  /authenticationfailed|authorizationfailed|invalid credentials|authentication failed|auth(?:entication)? (?:error|required|unsuccessful)|login fail(?:ed|ure)?\b|invalid (?:user|login|password)|(?:password|passcode|authorization code) (?:is )?(?:incorrect|wrong|invalid|error)|(?:incorrect|wrong|bad) (?:password|credentials)|password error|username and password not accepted|bad credentials|application-specific password|app password/i;

/**
 * 连续多少次「认证类」失败（含只带限流措辞的模糊拒绝）后，不论文本如何都停止重连。
 * 防止把限流文本当成可重试而对错误授权码无限试，最终把账号试到锁定。
 */
export const MAX_AUTH_LIKE_FAILURES = 3;

export type MailAuthClass = 'auth' | 'throttled' | null;

/**
 * 凭据拒绝的三分类：
 * - `auth`：确凿的认证失败——服务器给了明确信号（`serverResponseCode` 为 AUTHENTICATIONFAILED /
 *   AUTHORIZATIONFAILED，nodemailer 的 `EAUTH` / 535 / 534）或应答文本明确说凭据不对。
 *   即使文本同时带「频繁 / busy」也判认证失败（QQ 的做法）。
 * - `throttled`：imapflow 对任何 LOGIN 的 NO 都会设 `authenticationFailed`，它本身不区分
 *   「密码错」与「登录太频繁」（163 用 NO 回限流）。所以仅有这个标志、文本又明确是限流、
 *   没有其它确凿信号时，才降级为可重试；调用方应把它计入 {@link MAX_AUTH_LIKE_FAILURES}。
 * - `null`：与凭据无关（网络断开、纯限流文本而没有任何认证信号等）。
 */
export function classifyMailAuthFailure(error: unknown): MailAuthClass {
  if (error instanceof AppError) return error.code === 'MAIL_AUTH_FAILED' ? 'auth' : null;
  if (!(error instanceof Error)) return null;
  const extra = error as Error & {
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    responseCode?: number | string;
  };
  const fields = mailErrorFields(error);
  if (fields.code === 'EAUTH') return 'auth';
  const smtpCode = Number(extra.responseCode);
  if (smtpCode === 535 || smtpCode === 534) return 'auth';
  const serverCode = (extra.serverResponseCode ?? '').toUpperCase();
  if (serverCode === 'AUTHENTICATIONFAILED' || serverCode === 'AUTHORIZATIONFAILED') return 'auth';
  if (AUTH_TEXT_PATTERN.test(fields.detail)) return 'auth';
  if (extra.authenticationFailed === true) {
    return THROTTLE_PATTERN.test(fields.detail) ? 'throttled' : 'auth';
  }
  return null;
}

/** 是否是「凭据被拒」（确凿的认证失败）。模糊的限流型拒绝返回 false，见 {@link classifyMailAuthFailure}。 */
export function isMailAuthError(error: unknown): boolean {
  return classifyMailAuthFailure(error) === 'auth';
}
