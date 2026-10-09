import type { Run } from '@kepcup/shared';

/**
 * 对话内 Agent 设置卡的自动续跑判定（D58 + D72 P4，审查 HIGH #1）：只有在
 * Agent 状态**已加载**之后、本会话内观察到「不可用 → 可用」的转变才自动
 * 续跑。基线（`null` = 尚未建立）取第一个已知快照——重启后打开对话、状态
 * 加载完即为可用（`needs_auth` 只在 core 内存里，重启后显示 ready）时不会
 * 把旧 run 自动重放。
 */
export function stepAutoContinue(
  baseline: boolean | null,
  snapshot: { known: boolean; usable: boolean },
): { baseline: boolean | null; proceed: boolean } {
  if (!snapshot.known) return { baseline, proceed: false };
  if (baseline === null) return { baseline: snapshot.usable, proceed: false };
  return { baseline: snapshot.usable, proceed: snapshot.usable && !baseline };
}

/**
 * 打开会话时恢复的失败 run（`runs.list` 新→旧）：普通失败照旧取最近一条未
 * 关闭的；带 setup 的失败只有在它之后没有更新的同 Bot 对话轮 时才恢复——
 * 已被后续 run 接手的旧失败不再出现可续跑的设置卡（审查 HIGH #1）。
 */
export function restoredFailedRun(
  runs: readonly Run[],
  dismissed: ReadonlySet<string>,
): Run | null {
  const index = runs.findIndex(
    (run) => run.status === 'failed' && !dismissed.has(run.id) && showsFailure(run),
  );
  if (index === -1) return null;
  const failed = runs[index]!;
  if (failed.setup === null) return failed;
  const newer = runs.slice(0, index);
  // D75 §7.5: a task's setup failure is superseded by the task retrying it
  // (its failure wakes a turn, which must not hide the setup card).
  const superseded =
    failed.loopType === 'task'
      ? newer.some((run) => run.continuedFromRunIds.includes(failed.id))
      : newer.some((run) => run.loopType === 'turn' && run.botId === failed.botId);
  return superseded ? null : failed;
}

/**
 * Whether a failed run surfaces in the conversation (failure banner / setup
 * card). D75: a failed task has its task card (retry there) and wakes a turn
 * that tells the user — only a setup failure (§7.5: set up, then retry the
 * task) uses the conversation-level setup card.
 */
export function showsFailure(run: Pick<Run, 'loopType' | 'setup'>): boolean {
  // Background loops (reflection / conversation_summary / triage / subagent)
  // also carry the conversation id, but their failures are not the user's
  // turn failing — and retrying one would replay it as a turn. The core logs
  // them instead.
  if (run.loopType === 'turn') return true;
  return run.loopType === 'task' && run.setup !== null;
}
