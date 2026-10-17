import { rm } from 'node:fs/promises';

/**
 * Windows 上 app.close() 返回后旧句柄的释放（main.db 等）有延迟，立刻删
 * 数据目录会 EBUSY：重试到 deadline（与 browser-host 的 removeDirTolerant 同
 * 一问题的 spec 侧版本），仍失败则最后一次报销给上层（不能吞掉清理失败，
 * 否则盘满/锁死类问题会被掩盖）。
 */
export async function rmHomeTolerant(home: string, deadlineMs = 8_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() + 250 > start + deadlineMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
