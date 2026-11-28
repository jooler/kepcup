import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 「取消更新 = 跳过该版本」的持久化（userData/update-skip.json，先例见
 * update-sources.ts 的选源赢家记录）。只做纯取消的话，24 小时定时检查会立刻
 * 把同一个版本再下回来，用户会觉得「取消没用」——所以取消的语义同时记入
 * 跳过集合；出现更新的版本（不在集合里）自动恢复正常流程。集合语义等价于
 * 「跳过的版本永不提示、其它新版本恢复」且无需引 semver 比较。
 *
 * Electron-free：IO 只在默认实现里，主进程接线在 updater.ts，单测就地覆盖。
 * 任何 IO 失败都吞掉——跳过记录丢了最多多下载一次，绝不能影响更新流程。
 */
export interface UpdateSkipStore {
  load(): string[];
  save(versions: string[]): void;
}

export function createFileUpdateSkipStore(getDir: () => string): UpdateSkipStore {
  const file = (): string => path.join(getDir(), 'update-skip.json');
  return {
    load(): string[] {
      try {
        const raw: unknown = JSON.parse(readFileSync(file(), 'utf8'));
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'skipped' in raw &&
          Array.isArray((raw as { skipped: unknown }).skipped)
        ) {
          return (raw as { skipped: unknown[] }).skipped.filter(
            (version): version is string => typeof version === 'string',
          );
        }
      } catch {
        // 不存在 / 坏 JSON：当作无记录。
      }
      return [];
    },
    save(versions: string[]): void {
      try {
        mkdirSync(getDir(), { recursive: true });
        writeFileSync(file(), `${JSON.stringify({ skipped: versions }, null, 2)}\n`, 'utf8');
      } catch {
        // 只读 userData 等场景：跳过持久化，本会话内存集合照常生效。
      }
    },
  };
}

/** 追加一个跳过版本（幂等）并持久化。 */
export function appendSkippedVersion(store: UpdateSkipStore, version: string): void {
  const versions = store.load().filter((existing) => existing !== version);
  versions.push(version);
  store.save(versions);
}

/** 把一个版本移出跳过集合并持久化（用户在设置页手动下载被跳过的版本）。 */
export function removeSkippedVersion(store: UpdateSkipStore, version: string): void {
  store.save(store.load().filter((existing) => existing !== version));
}
