import { t } from '$lib/i18n';
import { ageOf } from './workbench-model';

/** 距今多久的人话：刚刚 / N 分钟前 / N 小时前 / N 天前 / 「10月12日」。 */
export function ageText(at: number, now: number = Date.now()): string {
  const age = ageOf(at, now);
  switch (age.unit) {
    case 'justNow':
      return t('workbench.age.justNow');
    case 'minutes':
      return t('workbench.age.minutes', { n: age.n });
    case 'hours':
      return t('workbench.age.hours', { n: age.n });
    case 'days':
      return t('workbench.age.days', { n: age.n });
    case 'date':
      return new Date(age.at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  }
}
