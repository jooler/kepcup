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
  const index = runs.findIndex((run) => run.status === 'failed' && !dismissed.has(run.id));
  if (index === -1) return null;
  const failed = runs[index]!;
  if (failed.setup === null) return failed;
  const superseded = runs
    .slice(0, index)
    .some((run) => run.loopType === 'turn' && run.botId === failed.botId);
  return superseded ? null : failed;
}
