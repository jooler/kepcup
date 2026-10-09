import { z } from 'zod';
import {
  WATCH_CONDITION_TEXT_MAX_CHARS,
  WATCH_MAX_INTERVAL_SEC,
  WATCH_MIN_INTERVAL_SEC,
  WATCH_SELECTOR_MAX_CHARS,
} from '../constants.js';

/**
 * 确定性监看（W7，D79，todo/borrowings-from-personal-agents.md W7）：「盯着
 * 某个网页，变了才叫我」。检查本身不花 LLM，只有条件边沿触发时才唤醒 Bot 的
 * 一个对话轮。本轮只有网页来源；`kind` 判别字段为后期的传感器来源留口，但
 * schema 只接受 `web_page`。
 */

/** http(s) only: the watch is fetched by the bot's background browser page. */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const selectorSchema = z.string().trim().min(1).max(WATCH_SELECTOR_MAX_CHARS);

export const watchWebPageSourceSchema = z.object({
  kind: z.literal('web_page'),
  url: z.string().trim().max(2048).refine(isHttpUrl, { message: '只支持 http / https 网址' }),
  /** CSS selector: only this element's text is watched (default: the page body). */
  selector: selectorSchema.optional(),
});

/** Watch sources. Only `web_page` this round (sensor sources later, §4). */
export const watchSourceSchema = z.discriminatedUnion('kind', [watchWebPageSourceSchema]);
export type WatchSource = z.infer<typeof watchSourceSchema>;

const conditionTextSchema = z.string().trim().min(1).max(WATCH_CONDITION_TEXT_MAX_CHARS);

/**
 * Conditions are edge-triggered: an alert fires when the condition was false
 * at the previous check and is true now (`changed`: the denoised page hash
 * differs from the previous one).
 */
export const watchConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changed') }),
  z.object({ kind: z.literal('contains'), text: conditionTextSchema }),
  z.object({ kind: z.literal('not_contains'), text: conditionTextSchema }),
  z.object({
    kind: z.literal('number_below'),
    /** Element holding the number (default: the first price-like number of the watched text). */
    selector: selectorSchema.optional(),
    value: z.number().finite(),
  }),
  z.object({
    kind: z.literal('number_above'),
    selector: selectorSchema.optional(),
    value: z.number().finite(),
  }),
]);
export type WatchCondition = z.infer<typeof watchConditionSchema>;

export const watchStatusSchema = z.enum(['active', 'paused', 'stopped']);
export type WatchStatus = z.infer<typeof watchStatusSchema>;

export const watchIntervalSecSchema = z
  .number()
  .int()
  .min(WATCH_MIN_INTERVAL_SEC)
  .max(WATCH_MAX_INTERVAL_SEC);

/** One row of main.db `watches` (docs/dev/03-data-model.md「watches」), page text omitted. */
export const watchSchema = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  source: watchSourceSchema,
  condition: watchConditionSchema,
  intervalSec: z.number().int(),
  status: watchStatusSchema,
  /** sha256 of the page lines at the last successful check (null = never checked). */
  lastHash: z.string().nullable(),
  /** Same with relative times ("3 分钟前") removed: what `changed` compares. */
  lastQuietHash: z.string().nullable(),
  /** The condition's value at the last successful check (edge trigger). */
  lastMatched: z.boolean(),
  /** Alerts sent so far (part of the alert idempotency key). */
  alertSeq: z.number().int(),
  /** Consecutive failed checks (reset by a success; pause at WATCH_PAUSE_AFTER_FAILURES). */
  failures: z.number().int(),
  nextCheckAt: z.number(),
  lastCheckedAt: z.number().nullable(),
  /** The last failure's message (cleared by a success). */
  lastError: z.string().nullable(),
  /** CAS version: every write bumps it. */
  version: z.number().int(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Watch = z.infer<typeof watchSchema>;

/** watches.list / watches.get row: the watch plus what the interface renders alongside. */
export const watchEntrySchema = watchSchema.extend({
  botName: z.string().nullable(),
});
export type WatchEntry = z.infer<typeof watchEntrySchema>;

/** In-conversation watch cards (`cardType: 'watch'`, `watchEvent`). */
export const watchCardEventSchema = z.enum(['created', 'alert', 'paused']);
export type WatchCardEvent = z.infer<typeof watchCardEventSchema>;

/**
 * Why a paused card was posted: consecutive failed checks (`failures`), or too
 * many alerts in 24 hours (`too_frequent`, WATCH_MAX_ALERTS_PER_DAY).
 */
export const watchPauseReasonSchema = z.enum(['failures', 'too_frequent']);
export type WatchPauseReason = z.infer<typeof watchPauseReasonSchema>;

export const WATCH_CARD_TYPE = 'watch';

function siteHost(hostname: string): string {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

/**
 * 监看后台页的重定向规则（W7 复查）：最终地址必须与请求的地址同站，否则视为失败
 * （多半是跳到了登录页 / 风控页，不能把它当成页面内容）。同站 =
 * - 主机名相同（不分大小写，忽略开头的 `www.`：example.com ↔ www.example.com）；
 * - 协议相同，或 http → https 升级（https → http 降级不算）；
 * - 端口相同（协议相同时）；http → https 升级时两边都必须是默认端口。
 * 路径、查询串、片段随意（/item → /item/、/a → /a?ref=1 都允许）。
 */
export function watchRedirectAllowed(requestedUrl: string, finalUrl: string): boolean {
  let requested: URL;
  let final: URL;
  try {
    requested = new URL(requestedUrl);
    final = new URL(finalUrl);
  } catch {
    return false;
  }
  if (siteHost(requested.hostname) !== siteHost(final.hostname)) return false;
  if (requested.protocol === final.protocol) return requested.port === final.port;
  return (
    requested.protocol === 'http:' &&
    final.protocol === 'https:' &&
    requested.port === '' &&
    final.port === ''
  );
}

/** Where a refused redirect went, for the failure message (origin + path, no query). */
export function watchRedirectTarget(finalUrl: string): string {
  try {
    const url = new URL(finalUrl);
    const target = `${url.origin}${url.pathname}`;
    return target.length > 200 ? `${target.slice(0, 199)}…` : target;
  } catch {
    return finalUrl.slice(0, 200);
  }
}
/** Internal system event that wakes the bot's turn (trigger reason `watch`). */
export const WATCH_ALERT_EVENT = 'watch_alert';
