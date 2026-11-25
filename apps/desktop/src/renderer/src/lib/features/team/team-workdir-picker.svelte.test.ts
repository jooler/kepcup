import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * TeamWorkdirPicker 表单逻辑（member-bots B-10；2026-11 工作路径重构）：
 * - 分组：admin 预置根平铺 / 我的目录按 parentKey 组树，public（adminOnly）
 *   只出预置根；
 * - mkdir：仅本人子树（member 选项行 / 子树根 `member:`）；admin 键下建 →
 *   WORKDIR_NOT_ALLOWED；非法目录名（分隔符 / 控制字符 / 空 / `..`）→
 *   INVALID_INPUT；成功返回服务端 opaque 选项（真实路径不出服务端）；
 * - 服务端越界拒绝同样以 mkdirError 码呈现（组件层转文案）。
 */

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Array<{ method: string; input: unknown }>,
    options: [] as Array<{
      key: string;
      name: string;
      source: 'admin' | 'member';
      parentKey?: string | null;
    }>,
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
          const parent = (input as { parentKey?: string }).parentKey ?? 'member:';
          const rel = parent === 'member:' ? '' : parent.slice('member:'.length);
          const name = (input as { name: string }).name;
          const childRel = rel.length === 0 ? name : `${rel}/${name}`;
          return {
            option: { key: `member:${childRel}`, name, source: 'member', parentKey: parent },
          };
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
    { key: 'admin:wrt_p', name: 'Projects', source: 'admin' },
    { key: 'admin:wrt_s', name: 'Shared', source: 'admin' },
    { key: 'member:research', name: 'research', source: 'member', parentKey: 'member:' },
    { key: 'member:notes', name: 'notes', source: 'member', parentKey: 'member:' },
    // research 下的子目录（parentKey 链组树）。
    { key: 'member:research/2026', name: '2026', source: 'member', parentKey: 'member:research' },
  ];
  h.state.failWith = null;
});

describe('分组展示（opaque key；服务器路径不出服务端）', () => {
  it('admin 预置根平铺在前（按名称排序）、我的目录按 parentKey 组树在后', async () => {
    const { groupWorkdirOptions } = await import('./team-workdir-picker.svelte');
    const groups = groupWorkdirOptions(h.state.options);
    expect(groups.admin.map((o) => o.key)).toEqual(['admin:wrt_p', 'admin:wrt_s']);
    const flatMember = (nodes: typeof groups.member): string[] =>
      nodes.flatMap((node) => [node.option.key, ...flatMember(node.children)]);
    // notes / research 顶层按名称排序；2026 挂在 research 下。
    expect(flatMember(groups.member)).toEqual([
      'member:notes',
      'member:research',
      'member:research/2026',
    ]);
    expect(groups.member[1]?.children[0]?.option.name).toBe('2026');
  });

  it('parentKey 缺失（旧服务端）的 member 选项挂顶层不丢', async () => {
    const { groupWorkdirOptions } = await import('./team-workdir-picker.svelte');
    const groups = groupWorkdirOptions([
      { key: 'member:legacy', name: 'legacy', source: 'member' },
    ]);
    expect(groups.member[0]?.option.key).toBe('member:legacy');
  });

  it('parentKey 成环（防御深度，服务端契约不产环）：节点提升顶层不无声消失', async () => {
    const { groupWorkdirOptions } = await import('./team-workdir-picker.svelte');
    const groups = groupWorkdirOptions([
      { key: 'member:a', name: 'a', source: 'member', parentKey: 'member:b' },
      { key: 'member:b', name: 'b', source: 'member', parentKey: 'member:a' },
    ]);
    const flatMember = (nodes: typeof groups.member): string[] =>
      nodes.flatMap((node) => [node.option.key, ...flatMember(node.children)]);
    expect(flatMember(groups.member).sort()).toEqual(['member:a', 'member:b']);
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

describe('mkdir（仅本人子树，opaque key 往返）', () => {
  it('member 目录下新建：parentKey 透传、成功后重拉并返回新选项', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const option = await picker.mkdir('2026-q4', 'member:research');
    expect(option).toMatchObject({ key: 'member:research/2026-q4', name: '2026-q4', source: 'member' });
    expect(h.state.calls.find((c) => c.method === 'team.bots.workdirMkdir')?.input).toEqual({
      name: '2026-q4',
      parentKey: 'member:research',
    });
    // 成功后重拉选项。
    expect(h.state.calls.filter((c) => c.method === 'team.bots.workdirOptions').length).toBe(2);
    expect(picker.mkdirError).toBeNull();
  });

  it('parentKey 缺省 = 本人子树根 member:', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const option = await picker.mkdir('scratch');
    expect(option?.key).toBe('member:scratch');
    expect(h.state.calls.find((c) => c.method === 'team.bots.workdirMkdir')?.input).toEqual({
      name: 'scratch',
    });
  });

  it('admin 键下新建：客户端预检即拒（WORKDIR_NOT_ALLOWED），不发 RPC', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const option = await picker.mkdir('evil', 'admin:wrt_p');
    expect(option).toBeNull();
    expect(picker.mkdirError).toBe('WORKDIR_NOT_ALLOWED');
    expect(h.state.calls.some((c) => c.method === 'team.bots.workdirMkdir')).toBe(false);
  });

  it('未知 member 键（越权 / 已删除目录）：预检同 WORKDIR_NOT_ALLOWED', async () => {
    const picker = await freshPicker();
    await picker.refresh();
    const option = await picker.mkdir('evil', 'member:nope');
    expect(option).toBeNull();
    expect(picker.mkdirError).toBe('WORKDIR_NOT_ALLOWED');
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
    const option = await picker.mkdir('wherever');
    expect(option).toBeNull();
    expect(picker.mkdirError).toBe('WORKDIR_NOT_ALLOWED');
  });
});
