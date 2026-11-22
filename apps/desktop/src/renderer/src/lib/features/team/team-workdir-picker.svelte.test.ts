import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TeamWorkdirPicker 表单逻辑（member-bots B-10）：
 * - 分组：admin 启用根 / 我的目录（member），public（adminOnly）只出管理根；
 * - mkdir：仅本人 workdirs 子树（member 选项行 / 子树根）；admin 根下建 →
 *   WORKDIR_NOT_ALLOWED；非法目录名（分隔符 / 控制字符 / 空 / `..`）→ INVALID_INPUT；
 * - 服务端越界拒绝同样以 mkdirError 码呈现（组件层转文案）。
 */

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ method: string; input: unknown }>,
    options: [] as Array<{ path: string; name: string; source: 'admin' | 'member' }>,
    failWith: null as { code: string } | null,
  };
  return { state };
});

vi.mock('$lib/rpc/connections.svelte', () => ({
  serverHashOf: (source: string) => (source === 'local' ? null : source.slice('team:'.length)),
  teamSourceId: (hash: string) => `team:${hash}`,
  connections: {
    sources: () => ['local'],
    onSourcesChanged: () => () => undefined,
    get: () => ({
      status: 'connected',
      memberId: 'mbr_me',
      onConnected: () => () => undefined,
      onEvent: () => () => undefined,
      callTeam: async (method: string, input?: unknown) => {
        h.state.calls.push({ method, input });
        if (method === 'team.bots.workdirOptions') {
          if (h.state.failWith !== null) throw h.state.failWith;
          return { options: h.state.options };
        }
        if (method === 'team.bots.workdirMkdir') {
          if (h.state.failWith !== null) throw h.state.failWith;
          return { path: `${(input as { parentPath?: string }).parentPath ?? '/data/members/mbr_me/workdirs'}/${(input as { name: string }).name}` };
        }
        throw new Error(`unexpected ${method}`);
      },
    }),
  },
}));

async function freshPicker(adminOnly = false) {
  const { TeamWorkdirPickerState } = await import('./team-workdir-picker.svelte');
  return new TeamWorkdirPickerState('team:h1', { adminOnly });
}

beforeEach(() => {
  h.state.calls = [];
  h.state.options = [
    { path: '/srv/projects', name: 'Projects', source: 'admin' },
    { path: '/srv/shared', name: 'Shared', source: 'admin' },
    { path: '/data/members/mbr_me/workdirs/research', name: 'research', source: 'member' },
    { path: '/data/members/mbr_me/workdirs/notes', name: 'notes', source: 'member' },
  ];
  h.state.failWith = null;
});

describe('分组展示', () => {
  it('admin 根在前、我的目录在后（各按 path 排序）', async () => {
    const { groupWorkdirOptions } = await import('./team-workdir-picker.svelte');
    const groups = groupWorkdirOptions(h.state.options);
    expect(groups.admin.map((o) => o.path)).toEqual(['/srv/projects', '/srv/shared']);
    expect(groups.member.map((o) => o.path)).toEqual([
      '/data/members/mbr_me/workdirs/notes',
      '/data/members/mbr_me/workdirs/research',
    ]);
  });

  it('adminOnly（public Bot）：我的目录分组不展示', async () => {
    const picker = await freshPicker(true);
    await picker.refresh();
    expect(picker.groups.admin).toHaveLength(2);
    expect(picker.groups.member).toHaveLength(0);
  });

  it('拉取失败：loadError 写码、不伪造选项', async () => {
    h.state.failWith = { code: 'INTERNAL' };
    const picker = await freshPicker();
    await picker.refresh();
    expect(picker.loadError).toBe('INTERNAL');
    expect(picker.loaded).toBe(false);
  });
});

describe('mkdir（仅本人 workdirs 子树）', () => {
  it('member 目录下新建：parentPath 透传、成功后重拉并返回新路径', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const path = await picker.mkdir('2026-q4', '/data/members/mbr_me/workdirs/research');
    expect(path).toBe('/data/members/mbr_me/workdirs/research/2026-q4');
    expect(h.state.calls.find((c) => c.method === 'team.bots.workdirMkdir')?.input).toEqual({
      name: '2026-q4',
      parentPath: '/data/members/mbr_me/workdirs/research',
    });
    // 成功后重拉选项。
    expect(h.state.calls.filter((c) => c.method === 'team.bots.workdirOptions').length).toBe(2);
    expect(picker.mkdirError).toBeNull();
  });

  it('parentPath 缺省 = 本人 workdirs 根', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const path = await picker.mkdir('scratch');
    expect(path).toBe('/data/members/mbr_me/workdirs/scratch');
    expect(h.state.calls.find((c) => c.method === 'team.bots.workdirMkdir')?.input).toEqual({
      name: 'scratch',
    });
  });

  it('admin 根下新建：客户端预检即拒（WORKDIR_NOT_ALLOWED），不发 RPC', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const path = await picker.mkdir('evil', '/srv/projects');
    expect(path).toBeNull();
    expect(picker.mkdirError).toBe('WORKDIR_NOT_ALLOWED');
    expect(h.state.calls.some((c) => c.method === 'team.bots.workdirMkdir')).toBe(false);
  });

  it('非法目录名（分隔符 / 控制字符 / 空 / `..`）：INVALID_INPUT 预检', async () => {
    const { validMkdirName } = await import('./team-workdir-picker.svelte');
    expect(validMkdirName('a/b')).toBe(false);
    expect(validMkdirName('a\\b')).toBe(false);
    expect(validMkdirName('a\u0007b')).toBe(false);
    expect(validMkdirName('   ')).toBe(false);
    expect(validMkdirName('..')).toBe(false);
    expect(validMkdirName('正常目录')).toBe(true);

    const picker = await freshPicker();
    await picker.refresh();
    expect(await picker.mkdir('a/b')).toBeNull();
    expect(picker.mkdirError).toBe('INVALID_INPUT');
  });

  it('服务端越界拒绝（B-10 兜底）：mkdirError 呈现服务端码', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    h.state.failWith = { code: 'WORKDIR_NOT_ALLOWED' };
    const path = await picker.mkdir('wherever');
    expect(path).toBeNull();
    expect(picker.mkdirError).toBe('WORKDIR_NOT_ALLOWED');
  });
});
