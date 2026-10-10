import type { AppSkillOfferBot, AppsSkillsInstallOutput } from '@kepcup/shared';

/**
 * 随附技能提示的纯函数（D73 P3 §7.6）：提示卡文案要素、安装结果归类。
 * 组件见 ConnectedSkillsPrompt.svelte。
 */

export type SkillInstallResult = AppsSkillsInstallOutput['results'][number];

/** 提示卡一行的状态：未处理 / 已发出确认卡 / 已有待确认卡 / 出错。 */
export type BotPromptState = 'idle' | 'submitted' | 'pending' | 'failed';

/** 把一次安装的结果归成这个 Bot 行的状态（有失败 → failed；否则有新提交 → submitted；否则有待确认 → pending）。 */
export function promptStateOf(results: readonly SkillInstallResult[] | undefined): BotPromptState {
  if (results === undefined || results.length === 0) return 'idle';
  if (results.some((result) => result.status === 'failed' || result.status === 'mismatch')) {
    return 'failed';
  }
  if (results.some((result) => result.status === 'submitted')) return 'submitted';
  if (results.some((result) => result.status === 'pending')) return 'pending';
  return 'idle';
}

/** 失败说明（逐个技能拼接，去重）。 */
export function failureText(results: readonly SkillInstallResult[] | undefined): string {
  const errors = (results ?? [])
    .filter((result) => result.status === 'failed' || result.status === 'mismatch')
    .map((result) => `${result.name}：${result.error ?? ''}`.replace(/：$/, ''));
  return [...new Set(errors)].join('；');
}

/** 还要显示的行：用户点了「稍后」的 Bot 不再显示（只对本次挂载有效）。 */
export function visibleBots(
  bots: readonly AppSkillOfferBot[],
  dismissed: ReadonlySet<string>,
): AppSkillOfferBot[] {
  return bots.filter((bot) => !dismissed.has(bot.botId));
}
