/**
 * `when` parsing shared by the schedule tool, offer cards and butler routines
 * (D80): ISO 8601 → one-shot instant, anything else → cron.
 */

/**
 * Strict ISO 8601 shape: `YYYY-MM-DD` with an optional time part. Date.parse
 * must only see ISO-shaped strings — V8 happily parses `0 3 * * *` as
 * February 3rd 2000 (BR-P10-001), so the cron branch is the default and a
 * cron expression can never be mistaken for a past instant.
 */
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

/** ISO-shaped strings parse as instants (NaN throws); everything else is cron (null). */
export function parseIsoOrThrow(when: string): number | null {
  const trimmed = when.trim();
  if (!ISO_DATETIME.test(trimmed)) return null;
  const parsed = Date.parse(trimmed.replace(' ', 'T'));
  if (Number.isNaN(parsed)) {
    throw new Error(`无法识别的时间格式：${when}（应为 ISO 8601 时间或 cron 表达式）`);
  }
  return parsed;
}
