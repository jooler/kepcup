import { renameSync } from 'node:fs';
import { rm } from 'node:fs/promises';

/**
 * Windows 上 app.close() 返回后旧句柄的释放（main.db 等）有延迟，立刻删
 * 数据目录会 EBUSY。两层兜底：
 * 1) 同卷 rename 优先 —— 目录更名不需要独占其内容（子文件被占用的目录
 *    常常仍可改名），路径立刻消失，后续不再有人引用这个 home；
 * 2) rename 失败再重试 rm 到 deadline（与 browser-host 的 removeDirTolerant
 *    同一问题的 spec 侧版本）；仍失败则报销给上层——不能吞掉清理失败，
 *    否则盘满/锁死类问题会被掩盖（残骸留在 `*.discarding` 里由 CI 环境回收）。
 */
export async function rmHomeTolerant(home: string, deadlineMs = 30_000): Promise<void> {
  const start = Date.now();
  try {
    renameSync(home, `${home}.discarding`);
    return;
  } catch {
    // rename 失败继续 rm 循环。
  }
  for (;;) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() + 250 > start + deadlineMs) {
        try {
          renameSync(home, `${home}.discarding`);
          return;
        } catch {
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
