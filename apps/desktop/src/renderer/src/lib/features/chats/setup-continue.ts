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
 * 打开会话时恢复的失败 run（`runs.list` 新→旧）：取最近一条未关闭的失败；
 * 已标 `failureDismissed` 的（用户关过横幅，落在 error_json）和本会话内存里
 * 关掉的都跳过。已被后续同 Bot 对话轮接手的旧失败不再恢复——失败横幅与可
 * 续跑的设置卡都只描述「对话当前」的状态（审查 HIGH #1）：用户后来又发了
 * 消息且拿到了回复（或重试成功）时，几天前的旧失败不该每次打开都重新弹出来。
 * 运行中 / 被取消 / 被中断的后续对话轮不算接手（旧消息仍未回答，保留重试
 * 入口）；但更新的失败已被用户关闭时，更早的失败也不再冒出来。
 */
export function restoredFailedRun(
  runs: readonly Run[],
  dismissed: ReadonlySet<string>,
): Run | null {
  const index = runs.findIndex(
    (run) =>
      run.status === 'failed' &&
      run.failureDismissed !== true &&
      !dismissed.has(run.id) &&
      showsFailure(run),
  );
  if (index === -1) return null;
  const failed = runs[index]!;
  const newer = runs.slice(0, index);
  const superseded = newer.some((run) =>
    supersedesFailure(failed, run, run.failureDismissed === true || dismissed.has(run.id)),
  );
  return superseded ? null : failed;
}

/**
 * 一个更新的 run 是否让 `failed` 不再是对话当前需要重试的失败。恢复（打开
 * 会话）与实时事件共用：
 *
 * - task：只有任务自己重试它（`continuedFromRunIds`）才算接手。失败唤醒的
 *   对话轮不能收掉设置卡（D75 §7.5）。
 * - turn：同 Bot 更新的对话轮**已完成**（用户拿到了回复 / 重试成功），或它
 *   自己也失败且已被用户关闭。running / cancelled / interrupted 的后续轮没有
 *   回答旧消息，保留旧横幅的重试入口。
 */
export function supersedesFailure(
  failed: Pick<Run, 'id' | 'botId' | 'loopType'>,
  run: Pick<Run, 'botId' | 'loopType' | 'status' | 'continuedFromRunIds'>,
  failureHidden = false,
): boolean {
  if (failed.loopType === 'task') {
    return run.continuedFromRunIds.includes(failed.id);
  }
  return (
    run.loopType === 'turn' &&
    run.botId === failed.botId &&
    (run.status === 'completed' || (run.status === 'failed' && failureHidden))
  );
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
