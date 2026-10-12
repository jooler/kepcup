import type { Bot, BotProfile, ButlerProposedBot, Conversation } from '@kepcup/shared';
import type { CoreLogger } from '../infra/logger.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { ScheduleToolFacade } from '../tools/schedule-tools.js';

/**
 * 按提议确定性建一个 Bot（D70 管家提议 / D88 移交卡的「新建目标」共用）：头像、
 * identity / role、模型、开私聊，以及确认时保留下来的例行事项（D80）。不经模型再编造
 * 任何字段。
 */

export interface ProposedBotDeps {
  bots: BotsService;
  conversations: ConversationsService;
  logger: CoreLogger;
  /** D80: routines of proposed bots (optional in stripped setups: routines are dropped). */
  schedule?: Pick<ScheduleToolFacade, 'createFromWhen' | 'describeWhen'> | undefined;
  publish: (event: string, payload: unknown) => void;
}

/** Built-in preset avatars handed out to bots created from a proposal (renderer presets). */
const AVATAR_SHAPES = ['orb', 'cloud', 'tile', 'clover', 'heart', 'blossom', 'drop', 'hex'];
const AVATAR_COLORS = ['blue', 'green', 'orange', 'teal', 'pink', 'amber', 'red', 'brown'];

/** The preset avatar of the `slot`-th created bot (cycles through shapes and colors). */
export function proposedBotAvatar(slot: number): string {
  return `preset:${AVATAR_SHAPES[slot % AVATAR_SHAPES.length]}:${AVATAR_COLORS[slot % AVATAR_COLORS.length]}`;
}

/** The new bot row and its (possibly just opened) direct chat — nothing published yet. */
export interface CreatedBotRecord {
  bot: Bot;
  conversation: Conversation;
  /** The direct chat was opened by this call (announce it to the sidebar). */
  opened: boolean;
}

/**
 * 只写库：建 Bot 行并打开私聊，不推送事件（调用方可以把它放进事务，提交后再
 * `announceCreatedBot`）。`runtime` 覆盖模型相关字段（D88；缺省 = 跟随设置默认）。
 */
export function createProposedBotRecord(
  deps: Pick<ProposedBotDeps, 'bots' | 'conversations'>,
  item: ButlerProposedBot,
  slot: number,
  runtime?: Partial<Pick<BotProfile['runtime'], 'model' | 'light_model' | 'agent'>>,
): CreatedBotRecord {
  const model = runtime?.model ?? item.model;
  const bot = deps.bots.create({
    identity: { name: item.name, bio: item.bio, avatar: proposedBotAvatar(slot) },
    role: { expertise: item.expertise, responsibilities: item.responsibilities },
    ...(model.length > 0 || runtime !== undefined
      ? {
          runtime: {
            model,
            ...(runtime?.light_model !== undefined ? { light_model: runtime.light_model } : {}),
            ...(runtime?.agent !== undefined ? { agent: runtime.agent } : {}),
          } as BotProfile['runtime'],
        }
      : {}),
  });
  const { conversation, created } = deps.conversations.openDirect(bot.id);
  return { bot, conversation, opened: created };
}

/** `bot.updated` + the new direct chat for the sidebar. */
export function announceCreatedBot(
  deps: Pick<ProposedBotDeps, 'publish'>,
  record: CreatedBotRecord,
): void {
  deps.publish('bot.updated', { bot: record.bot });
  // 新联系人直接出现在左栏（空私聊），用户点开即可开聊。带上 bot：renderer 把「单聊无
  // bot」当作已删除，不会加入侧栏。
  if (record.opened) {
    deps.publish('conversation.updated', {
      conversation: { ...record.conversation, bot: record.bot },
    });
  }
}

/**
 * D80: the kept routines go into the new bot's direct chat (their receipt cards are the
 * first thing the user sees there). Returns one line per created / failed routine.
 */
export function createProposedRoutines(
  deps: Pick<ProposedBotDeps, 'schedule' | 'logger'>,
  record: CreatedBotRecord,
  item: ButlerProposedBot,
  keep: (routineIndex: number) => boolean,
  logContext: Record<string, unknown>,
): { lines: string[]; failures: string[] } {
  const lines: string[] = [];
  const failures: string[] = [];
  const schedule = deps.schedule;
  for (const [routineIndex, routine] of item.routines.entries()) {
    if (!keep(routineIndex)) continue;
    if (schedule === undefined) {
      failures.push(`${item.name}「${routine.title}」（当前环境不支持定时任务）`);
      continue;
    }
    try {
      const row = schedule.createFromWhen({
        botId: record.bot.id,
        conversationId: record.conversation.id,
        when: routine.when,
        timezone: routine.timezone,
        title: routine.title,
        note: routine.note,
        origin: 'proposal',
      });
      lines.push(`${item.name}「${routine.title}」${schedule.describeWhen(row)}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      deps.logger.warn(
        { ...logContext, botId: record.bot.id, title: routine.title, error: reason },
        'proposed bot routine creation failed',
      );
      failures.push(`${item.name}「${routine.title}」（${reason}）`);
    }
  }
  return { lines, failures };
}
