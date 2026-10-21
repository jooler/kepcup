export type LocaleId = 'zh-CN' | 'en-US';

/** Mainland China + Hong Kong/Macau time zones: first launch defaults to Chinese there. */
const CHINA_TIME_ZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Kashgar',
  'Asia/Hong_Kong',
  'Asia/Macau',
]);

/** Pure first-launch choice: location by time zone, with the OS language as a fallback. */
export function pickInitialLocale(timeZone: string, language: string): LocaleId {
  if (timeZone.length > 0) return CHINA_TIME_ZONES.has(timeZone) ? 'zh-CN' : 'en-US';
  return /^zh/i.test(language) ? 'zh-CN' : 'en-US';
}

export function detectLocale(): LocaleId {
  let timeZone = '';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    // Intl unavailable: fall back to navigator.language
  }
  const language = typeof navigator !== 'undefined' ? navigator.language : '';
  return pickInitialLocale(timeZone, language);
}
