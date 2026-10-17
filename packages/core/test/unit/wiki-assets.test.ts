import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  appendSource,
  assetIdOf,
  ledgerPath,
  readLedger,
  removeLedgerEntry,
  writeLedgerEntry,
  type WikiAssetEntry,
} from '../../src/wiki/assets.js';

/**
 * D92 T1b WP9 步骤 4.1：来源台账（raw/_assets/{assetId}.json）纯函数与薄 IO。
 * assetId 派生、写读往返、坏文件跳过不抛、appendSource 去重、原子写。
 */

const dir = mkdtempSync(path.join(tmpdir(), 'wiki-assets-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stubLogger = { warn() {}, info() {}, error() {}, debug() {} };

function makeRoot(): string {
  const root = path.join(dir, `root-${Math.random().toString(36).slice(2, 8)}`);
  return root;
}

function entryOf(id: string, overrides: Partial<WikiAssetEntry> = {}): WikiAssetEntry {
  const sha256 = id.slice(4).padEnd(64, '0');
  return {
    id,
    sha256,
    kind: 'text',
    fileName: 'notes.md',
    bytes: 128,
    storage: 'git',
    rawRelPath: `raw/20261017-${id.slice(4, 16)}-notes.md`,
    createdBy: { kind: 'bot', id: 'bot_m' },
    sources: [{ type: 'file', ref: '/tmp/notes.md', conversationId: 'conv_p', at: 1000 }],
    status: 'maintained',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('assetIdOf', () => {
  it('取 sha256 前 24 位十六进制并加 ast_ 前缀', () => {
    const sha = '3f9a0c0123456789abcdef'.padEnd(64, '0');
    expect(sha.length).toBe(64);
    expect(assetIdOf(sha)).toBe('ast_3f9a0c0123456789abcdef00');
    expect(assetIdOf(sha)).toMatch(/^ast_[0-9a-f]{24}$/);
  });
});

describe('writeLedgerEntry / readLedger 往返', () => {
  it('写入后原样读回；目录不存在时读返回空', () => {
    const root = makeRoot();
    expect(readLedger(root, stubLogger)).toEqual([]);

    const entry = entryOf('ast_aaaa00000000000000000001');
    writeLedgerEntry(root, entry);
    expect(readLedger(root, stubLogger)).toEqual([entry]);
    expect(existsSync(ledgerPath(root, entry.id))).toBe(true);
    expect(readdirSync(path.join(root, 'raw', '_assets'))).toEqual([`${entry.id}.json`]);
  });
});

describe('坏文件容错', () => {
  it('单个坏文件被跳过并记日志，不抛出、不影响其它条目', () => {
    const root = makeRoot();
    const good = entryOf('ast_bbbb00000000000000000002');
    writeLedgerEntry(root, good);
    writeFileSync(path.join(root, 'raw', '_assets', 'ast_broken.json'), '{ not json', 'utf8');
    writeFileSync(
      path.join(root, 'raw', '_assets', 'ast_wrong.json'),
      JSON.stringify({ id: 'nope' }),
      'utf8',
    );

    const entries = readLedger(root, stubLogger);
    expect(entries).toEqual([good]);
  });
});

describe('appendSource', () => {
  it('同 type+ref 去重；新来源追加并更新 updatedAt', () => {
    const entry = entryOf('ast_cccc00000000000000000003');
    expect(appendSource(entry, { type: 'file', ref: '/tmp/notes.md', conversationId: null, at: 2000 }, 2000)).toBe(false);
    expect(entry.sources).toHaveLength(1);
    expect(entry.updatedAt).toBe(1000);

    expect(appendSource(entry, { type: 'url', ref: 'https://example.com/a', conversationId: 'conv_p', at: 2000 }, 2000)).toBe(true);
    expect(entry.sources).toHaveLength(2);
    expect(entry.updatedAt).toBe(2000);
  });
});

describe('原子写与删除', () => {
  it('写后不留 .tmp 残留；removeLedgerEntry 删除文件', () => {
    const root = makeRoot();
    const entry = entryOf('ast_dddd00000000000000000004');
    writeLedgerEntry(root, entry);
    expect(readdirSync(path.join(root, 'raw', '_assets')).some((n) => n.endsWith('.tmp'))).toBe(false);

    removeLedgerEntry(root, entry.id);
    expect(existsSync(ledgerPath(root, entry.id))).toBe(false);
    // 幂等：再删一次不抛。
    removeLedgerEntry(root, entry.id);
  });
});
