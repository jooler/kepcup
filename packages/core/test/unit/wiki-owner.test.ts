import { describe, expect, it } from 'vitest';
import { wikiOwnerKey, wikiOwnerSchema } from '@kepcup/shared';
import {
  botWikiPagesDir,
  botWikiRawDir,
  botWikiRoot,
  botWikiStoreRoot,
  projectRoot,
  projectWikiDbPath,
  projectWikiRoot,
  projectWikiStoreRoot,
  resolvePaths,
  wikiPagesDir,
  wikiRawDir,
  wikiRoot,
  wikiStoreRoot,
} from '../../src/infra/paths.js';

/**
 * D92 T1b WP9 步骤 1：wiki owner 类型、互斥 / 去重键与按 owner 的路径助手。
 * Bot 的磁盘路径必须与改动前逐字相同（`bots/{id}/wiki`…）；项目 wiki 落在
 * `projects/{id}/` 下（README §4.14）。
 */

const paths = resolvePaths('/tmp/kepcup-wiki-owner-test');
const home = paths.home; // resolvePaths 会 realpath（macOS /tmp → /private/tmp），期望值从它出发。

describe('wikiOwnerSchema', () => {
  it('接受 bot / project 两种 owner', () => {
    expect(wikiOwnerSchema.parse({ kind: 'bot', id: 'bot_1' })).toEqual({ kind: 'bot', id: 'bot_1' });
    expect(wikiOwnerSchema.parse({ kind: 'project', id: 'conv_1' })).toEqual({
      kind: 'project',
      id: 'conv_1',
    });
  });

  it('拒绝未知 kind 与空 id', () => {
    expect(wikiOwnerSchema.safeParse({ kind: 'team', id: 'x' }).success).toBe(false);
    expect(wikiOwnerSchema.safeParse({ kind: 'bot', id: '' }).success).toBe(false);
    expect(wikiOwnerSchema.safeParse({ kind: 'project', id: '' }).success).toBe(false);
    expect(wikiOwnerSchema.safeParse({ kind: 'bot' }).success).toBe(false);
  });
});

describe('wikiOwnerKey', () => {
  it('互斥键与去重键共用 `kind:id` 字符串形态', () => {
    expect(wikiOwnerKey({ kind: 'bot', id: 'bot_1' })).toBe('bot:bot_1');
    expect(wikiOwnerKey({ kind: 'project', id: 'conv_1' })).toBe('project:conv_1');
  });
});

describe('wiki 路径助手', () => {
  it('bot 路径与改动前逐字相同', () => {
    expect(botWikiRoot(paths, 'bot_a')).toBe(path_a('bot_a', 'wiki'));
    expect(botWikiRawDir(paths, 'bot_a')).toBe(path_a('bot_a', 'wiki', 'raw'));
    expect(botWikiPagesDir(paths, 'bot_a')).toBe(path_a('bot_a', 'wiki', 'pages'));
    expect(botWikiStoreRoot(paths, 'bot_a')).toBe(path_a('bot_a', 'wiki-store'));
    // 泛化助手对 bot owner 输出同一路径。
    const owner = { kind: 'bot', id: 'bot_a' } as const;
    expect(wikiRoot(paths, owner)).toBe(botWikiRoot(paths, 'bot_a'));
    expect(wikiRawDir(paths, owner)).toBe(botWikiRawDir(paths, 'bot_a'));
    expect(wikiPagesDir(paths, owner)).toBe(botWikiPagesDir(paths, 'bot_a'));
    expect(wikiStoreRoot(paths, owner)).toBe(botWikiStoreRoot(paths, 'bot_a'));
  });

  it('项目 wiki 路径在 projects/{id}/ 下', () => {
    const owner = { kind: 'project', id: 'conv_p' } as const;
    expect(projectRoot(paths, 'conv_p')).toBe(path_p('conv_p'));
    expect(projectWikiRoot(paths, 'conv_p')).toBe(path_p('conv_p', 'wiki'));
    expect(projectWikiStoreRoot(paths, 'conv_p')).toBe(path_p('conv_p', 'wiki-store'));
    expect(projectWikiDbPath(paths, 'conv_p')).toBe(path_p('conv_p', 'wiki.db'));
    expect(wikiRoot(paths, owner)).toBe(projectWikiRoot(paths, 'conv_p'));
    expect(wikiRawDir(paths, owner)).toBe(path_p('conv_p', 'wiki', 'raw'));
    expect(wikiPagesDir(paths, owner)).toBe(path_p('conv_p', 'wiki', 'pages'));
    expect(wikiStoreRoot(paths, owner)).toBe(projectWikiStoreRoot(paths, 'conv_p'));
  });
});

function path_a(botId: string, ...rest: string[]): string {
  return [home, 'bots', botId, ...rest].join('/');
}
function path_p(projectId: string, ...rest: string[]): string {
  return [home, 'projects', projectId, ...rest].join('/');
}
