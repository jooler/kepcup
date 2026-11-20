import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  appendSkippedVersion,
  createFileUpdateSkipStore,
  type UpdateSkipStore,
} from './update-skip.js';

/**
 * 「取消更新 = 跳过该版本」的持久化（userData/update-skip.json，先例与风格
 * 见 update-sources.test.ts）：往返容错、幂等追加、IO 失败静默吞。
 */

let dir: string | null = null;

function freshDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'kepcup-update-skip-'));
  return dir;
}

afterEach(() => {
  dir = null;
});

describe('createFileUpdateSkipStore', () => {
  test('load 在无记录时返回空数组；save/load 往返保序', () => {
    const at = freshDir();
    const store = createFileUpdateSkipStore(() => at);
    expect(store.load()).toEqual([]);
    store.save(['1.0.0', '1.1.0']);
    expect(store.load()).toEqual(['1.0.0', '1.1.0']);
  });

  test('坏 JSON 与非字符串元素都当作无记录/被过滤', () => {
    const at = freshDir();
    const file = path.join(at, 'update-skip.json');
    writeFileSync(file, '{not json', 'utf8');
    expect(createFileUpdateSkipStore(() => at).load()).toEqual([]);

    writeFileSync(file, JSON.stringify({ skipped: ['1.0.0', 42, null, '1.1.0'] }), 'utf8');
    expect(createFileUpdateSkipStore(() => at).load()).toEqual(['1.0.0', '1.1.0']);
  });

  test('save 的 IO 失败被吞掉，不影响调用方', () => {
    // getDir 指向一个文件：mkdirSync 会 ENOTDIR，save 必须静默。
    const at = freshDir();
    const blocker = path.join(at, 'not-a-dir');
    writeFileSync(blocker, '', 'utf8');
    const store = createFileUpdateSkipStore(() => path.join(blocker, 'nested'));
    expect(() => store.save(['1.0.0'])).not.toThrow();
  });
});

describe('appendSkippedVersion', () => {
  test('幂等追加并持久化', () => {
    const at = freshDir();
    const store = createFileUpdateSkipStore(() => at);
    appendSkippedVersion(store, '1.0.0');
    appendSkippedVersion(store, '1.0.0');
    appendSkippedVersion(store, '1.1.0');
    expect(store.load()).toEqual(['1.0.0', '1.1.0']);
    // 落盘形状（update-skip.json）：给排障与真机验证一个稳定锚点。
    const raw = JSON.parse(readFileSync(path.join(at, 'update-skip.json'), 'utf8'));
    expect(raw).toEqual({ skipped: ['1.0.0', '1.1.0'] });
  });

  test('内存 store 也能用（不落盘的接线场景）', () => {
    const memory: { versions: string[] } = { versions: [] };
    const store: UpdateSkipStore = {
      load: () => memory.versions,
      save: (versions) => {
        memory.versions = versions;
      },
    };
    appendSkippedVersion(store, '2.0.0');
    expect(store.load()).toEqual(['2.0.0']);
  });
});
