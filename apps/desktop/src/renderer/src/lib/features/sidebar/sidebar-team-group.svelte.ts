import type { TeamBotView } from '@kepcup/shared';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { teamContext } from '$lib/features/team/team-context.svelte';

/**
 * 「+」面板团队分组与 Bot 行 per-bot 菜单的判定层（B4 子域 B，方案决策 B-4 /
 * B-12）：纯函数接受快照输入，响应式薄壳读真实 store——AppSidebar 只做接线，
 * 分支逻辑在这里单测（渲染分支在无 DOM 的 svelte 测试环境下以判定输出覆盖）。
 *
 * 休眠铁律（逐 PR 验收项）：非团队上下文（web 非团队端点 / 桌面未融合团队
 * 服务器）`teamPlusSource()` 恒 null、`botRowMenuAction()` 恒走本地分支——
 * 「+」面板团队分组不渲染、右键菜单与现状逐项一致。
 */

/** One configured source with its connection status (snapshot for the pure resolver). */
export interface TeamSourceStatus {
  source: SourceId;
  connected: boolean;
}

/**
 * The team source the "+" panel group acts on:
 * - web team endpoint: the same-origin core IS the team server → `'local'`;
 * - desktop fusion: the selected conversation's source when it is a (connected)
 *   team source — the group must never silently switch to another server just
 *   because the viewed one dropped; otherwise the first connected team source;
 * - anything else → null (the whole group stays unrendered, baseline unchanged).
 */
export function resolveTeamPlusSource(input: {
  teamActive: boolean;
  currentSource: SourceId | null;
  sources: TeamSourceStatus[];
}): SourceId | null {
  if (input.teamActive) return 'local';
  const current = input.currentSource;
  if (current !== null && current !== 'local') {
    const status = input.sources.find((entry) => entry.source === current);
    // Viewing a team server that just went offline: hide the group rather than
    // acting on a different connected server (no fabricated data).
    return status?.connected === true ? current : null;
  }
  return input.sources.find((entry) => entry.source !== 'local' && entry.connected)
    ?.source ?? null;
}

/** Reactive wrapper: reads the real stores (AppSidebar consumes this inside $derived). */
export function teamPlusSource(): SourceId | null {
  const sources = connections.sources().map((source) => ({
    source,
    connected: connections.get(source).status === 'connected',
  }));
  return resolveTeamPlusSource({
    teamActive: teamContext.active,
    currentSource: chat.currentRef?.source ?? null,
    sources,
  });
}

/** What a conversation-row context menu should offer for its bot (B-12 per-bot gate). */
export type BotRowMenuAction =
  | { kind: 'teamEdit'; bot: TeamBotView }
  | { kind: 'localRename' }
  | { kind: 'none' };

/**
 * Per-bot menu decision for a bot conversation row (the row list is the local
 * `chat.conversations`, so the member plane in play is the `'local'` slice — it
 * is only served by a team server on the web team endpoint):
 * - member-plane bot (team.bots.list carries it) → per-bot `canEdit` opens the
 *   team edit dialog (transfer / delete live inside it, B-1); non-editable bots
 *   get no entry — the `bot-edit` surface no longer blocks the whole row;
 * - team endpoint, bot outside the (resolved) member plane (butler, list load
 *   failure) → no entry either: core `bots.update` is member-deny on team
 *   servers (B2), so the local rename could never succeed there. Pre-B2
 *   servers already hid the entry via the `bot-edit` surface — same result;
 * - list not resolved yet on a team endpoint → no entry: never show a local
 *   action the team server would reject (also avoids the wrong-entry flash
 *   while team.bots.list is in flight);
 * - non-team context → the existing local rename branch unchanged (surface +
 *   bot-status gates).
 */
export function botRowMenuAction(input: {
  teamActive: boolean;
  memberBots: TeamBotView[];
  /** team.bots.list finished (successfully or not) for the row's source. */
  memberBotsResolved: boolean;
  /** The row bot's id (null when the row is not a bot row / has no bot view). */
  botId: string | null;
  /** Local bot status check powering the existing rename gate. */
  botActive: boolean;
  editSurfaceHidden: boolean;
}): BotRowMenuAction {
  const localFallback = (): BotRowMenuAction =>
    input.botActive && !input.editSurfaceHidden ? { kind: 'localRename' } : { kind: 'none' };
  if (input.botId === null) return { kind: 'none' };
  if (input.teamActive) {
    if (!input.memberBotsResolved) return { kind: 'none' };
    const view = input.memberBots.find((bot) => bot.id === input.botId);
    if (view === undefined) return { kind: 'none' };
    return view.canEdit ? { kind: 'teamEdit', bot: view } : { kind: 'none' };
  }
  return localFallback();
}
