/** Local calendar helpers for daily schedules (consolidation, budget days). */

/** YYYY-MM-DD of `date` in `timeZone` (budget days, consolidation days). */
export function localDateKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Hour of day (0-23) of `date` in `timeZone`. */
export function localHourOf(date: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(date);
  return Number(hour) % 24;
}

/** Offset of `timeZone` from UTC in ms at the given instant. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) map[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(map['year']),
    Number(map['month']) - 1,
    Number(map['day']),
    Number(map['hour']) % 24,
    Number(map['minute']),
    Number(map['second']),
  );
  return asUtc - date.getTime();
}

/** Start (UTC ms) of the local day containing `now`. */
export function localDayStart(now: number, timeZone: string): number {
  const [y, m, d] = localDateKey(new Date(now), timeZone).split('-').map(Number);
  const guess = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  const offset = tzOffsetMs(new Date(guess), timeZone);
  let start = guess - offset;
  const secondOffset = tzOffsetMs(new Date(start), timeZone);
  if (secondOffset !== offset) start = guess - secondOffset;
  return start;
}

/** UTC ms of the next local midnight after `now` (budget deferral). */
export function nextLocalMidnight(now: number, timeZone: string): number {
  const todayStart = localDayStart(now, timeZone);
  return localDayStart(todayStart + 36 * 60 * 60 * 1000, timeZone);
}
