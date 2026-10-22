import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { SHARE_TARGETS_MAX_BYTES, type ShareTargets } from '@kepcup/shared';
import { shareTargetsPath } from './app-group';

/**
 * D94 §5.2：主应用写进 App Group 的目标快照（`targets.v1.json`）。
 *
 * 只含 id、显示名、类型与归档状态——没有密钥、消息、备注、头像文件。扩展读
 * 它渲染目标列表；读不到就显示「打开 KepCup 同步列表」。
 */

export interface WriteTargetsResult {
  ok: boolean;
  /** 失败原因（可展示短文案，不含正文）。 */
  reason?: string;
}

/** 原子写：tmp + rename；目录 0700、文件 0600。 */
export function writeTargetsSnapshot(groupDir: string, targets: ShareTargets): WriteTargetsResult {
  const target = shareTargetsPath(groupDir);
  const payload = JSON.stringify(targets);
  if (Buffer.byteLength(payload, 'utf8') > SHARE_TARGETS_MAX_BYTES) {
    return { ok: false, reason: '目标列表过大' };
  }
  try {
    mkdirSync(groupDir, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reason: 'App Group 目录不可写' };
  }
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, payload, { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true };
}
