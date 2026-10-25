import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { WikiService } from '../../src/wiki/service.js';
import { initWiki } from '../../src/wiki/init.js';
import { commitWikiTree } from '../../src/wiki/git.js';
import { resolvePaths } from '../../src/infra/paths.js';
import type { AppPaths } from '../../src/infra/paths.js';
import type { CoreLogger } from '../../src/infra/logger.js';

/**
 * wiki.commitTree / wiki.commitPage（历史快照读取）：右栏历史条目点开后展示
 * 该次提交时的页面与全文，用户据此判断是否回滚。读取只走 git 对象——改写
 * 页面后再读旧提交，必须仍是旧内容（工作区绝不参与）。
 */

const home = mkdtempSync(path.join(tmpdir(), 'wiki-snapshot-'));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const paths: AppPaths = resolvePaths(home);
const logger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as CoreLogger;

const service = new WikiService({
  paths,
  clock: { now: () => 1_700_000_000_000 },
  logger,
  jobs: { enqueue: () => '', lastDoneAt: () => 0, lastDoneAtFor: () => 0 },
  bots: { get: () => null, listActive: () => [] },
  conversations: { get: () => null, memberBotIds: () => [] },
  indexFor: () => {
    throw new Error('snapshot reads never touch the FTS index');
  },
  publish: () => {},
});

const owner = { kind: 'bot', id: 'bot_snapshot' } as const;

async function history(): Promise<Array<{ oid: string; message: string }>> {
  return service.history(owner);
}

describe('wiki 历史快照读取（commitTree / readCommitPage）', () => {
  it('读某次提交时的页面列表与全文；改写后旧提交仍是旧内容', async () => {
    await initWiki(paths, owner, logger);
    const entries = await history();
    const initOid = entries[entries.length - 1]!.oid;

    // 目录结构提交：pages/ 根一页 + 子目录一页（tree 递归）。
    mkdirSync(path.join(paths.home, 'bots', owner.id, 'wiki', 'pages', 'guides'), {
      recursive: true,
    });
    const root = path.join(paths.home, 'bots', owner.id, 'wiki');
    writeFileSync(path.join(root, 'pages', 'deploy.md'), '# 部署指南 v1\n\n构建、推送、发布。');
    writeFileSync(path.join(root, 'pages', 'guides', 'rollback.md'), '# 回滚指南\n\n恢复旧版本。');
    writeFileSync(path.join(root, 'index.md'), '# 目录\n\n- [部署指南](pages/deploy.md)');
    const addOid = await commitWikiTree(root, 'wiki: add pages');

    const tree = await service.commitTree(owner, addOid);
    expect(tree.map((page) => page.path)).toEqual(['pages/deploy.md', 'pages/guides/rollback.md']);
    expect(tree.map((page) => page.title)).toEqual(['部署指南 v1', '回滚指南']);

    expect((await service.readCommitPage(owner, addOid, 'pages/deploy.md')).content).toContain(
      '部署指南 v1',
    );
    const index = await service.readCommitPage(owner, addOid, 'index.md');
    expect(index.title).toBe('目录');
    expect(index.content).toContain('[部署指南](pages/deploy.md)');

    // init 提交时还没有任何页面。
    expect(await service.commitTree(owner, initOid)).toEqual([]);

    // 新提交改写 deploy.md：旧提交的快照不变。
    writeFileSync(path.join(root, 'pages', 'deploy.md'), '# 部署指南 v2\n\n全新的步骤。');
    await commitWikiTree(root, 'wiki: update deploy');
    expect((await service.readCommitPage(owner, addOid, 'pages/deploy.md')).content).toContain(
      '部署指南 v1',
    );
    // init 提交时该页面还不存在：明确 NOT_FOUND，而不是读到别的什么。
    await expect(
      service.readCommitPage(owner, initOid, 'pages/deploy.md'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('越界路径、不存在的提交 / 页面、无 Wiki 的 owner 全部拒绝', async () => {
    const entries = await history();
    const oid = entries[0]!.oid;
    await expect(service.readCommitPage(owner, oid, 'log.md')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(service.readCommitPage(owner, oid, 'pages/../index.md')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      service.readCommitPage(owner, oid, 'pages/missing.md'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.commitTree(owner, 'f'.repeat(40))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const stranger = { kind: 'bot', id: 'bot_without_wiki' } as const;
    await expect(service.commitTree(stranger, oid)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
