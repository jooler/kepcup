import { describe, expect, it } from 'vitest';

import {
  decodeMountSource,
  encodeMountSource,
  isValidMountpoint,
  planMounts,
  resolvePolicyMounts,
  type MountRegistration,
} from '../../src/sandbox/wsl/mounts.js';
import { mountpointFor } from '../../src/sandbox/wsl/paths.js';
import type { SandboxPolicy } from '../../src/sandbox/types.js';

/**
 * 红线单测（P12 任务 5）：挂载参数严格校验，只接受已登记的 project /
 * 授权目录 / 应用数据目录根。任何未登记路径（模拟上游任何 bug 产生的策略
 * 路径）都必须被拒绝并使整条命令 fail-closed。
 */

const DATA_HOME = 'C:\\Users\\me\\.kepcup';
const WORKSPACE = `${DATA_HOME}\\bots\\bot_1\\workspaces\\conv_1`;
const PROJECT = 'C:\\code\\my-project';
const GRANT = 'D:\\shared\\docs';

const registration: MountRegistration = {
  registeredWindowsPaths: () => [DATA_HOME, PROJECT, GRANT],
};

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    readWrite: [WORKSPACE],
    readOnly: [],
    denyRead: ['C:\\Users\\me'],
    network: { mode: 'none', allowDomains: [] },
    env: {},
    ...overrides,
  };
}

const opts = { cwd: WORKSPACE, registration };

describe('resolvePolicyMounts — 红线：未登记路径拒绝', () => {
  it('mounts a registered workspace rw and a registered grant ro', () => {
    const resolved = resolvePolicyMounts(policy({ readOnly: [GRANT] }), opts);
    expect(resolved.rejections).toEqual([]);
    const rw = resolved.entries.find((entry) => entry.source === WORKSPACE)!;
    expect(rw.mode).toBe('rw');
    const ro = resolved.entries.find((entry) => entry.source === GRANT)!;
    expect(ro.mode).toBe('ro');
  });

  it('REJECTS an unregistered readWrite path (e.g. a foreign directory)', () => {
    const resolved = resolvePolicyMounts(
      policy({ readWrite: [WORKSPACE, 'E:\\elsewhere'] }),
      opts,
    );
    expect(resolved.rejections).toHaveLength(1);
    expect(resolved.rejections[0]).toMatchObject({ path: 'E:\\elsewhere', kind: 'readWrite' });
    // The rejected path must not appear as a mount.
    expect(resolved.entries.some((entry) => entry.source === 'E:\\elsewhere')).toBe(false);
  });

  it('REJECTS an unregistered readOnly path outside the static roots', () => {
    const resolved = resolvePolicyMounts(policy({ readOnly: ['C:\\private\\stuff'] }), opts);
    expect(resolved.rejections).toHaveLength(1);
    expect(resolved.rejections[0]!.kind).toBe('readOnly');
  });

  it('authorizes paths INSIDE a registered root (grant on a subdirectory)', () => {
    const resolved = resolvePolicyMounts(
      policy({ readOnly: [`${GRANT}\\sub\\file.txt`] }),
      opts,
    );
    expect(resolved.rejections).toEqual([]);
    expect(resolved.entries.map((entry) => entry.source)).toContain(`${GRANT}\\sub\\file.txt`);
  });

  it('accepts static trusted read-only roots without registration', () => {
    const trustedRoot = 'C:\\Users\\me\\.nvm';
    const resolved = resolvePolicyMounts(policy({ readOnly: [trustedRoot] }), {
      ...opts,
      trustedReadOnlyRoots: [trustedRoot],
    });
    expect(resolved.rejections).toEqual([]);
    expect(resolved.entries.find((entry) => entry.source === trustedRoot)!.role).toBe('app-root');
  });

  it('SKIPS host home toolchain readOnly roots the backend keeps out of the image (BR-P12-003)', () => {
    // On a Windows machine with ~/.cargo etc., buildSandboxPolicy puts those
    // directories into readOnly; the WSL backend does not project them (the
    // distro ships its own toolchains) — they must be skipped, not rejected.
    const cargo = 'C:\\Users\\me\\.cargo';
    const resolved = resolvePolicyMounts(policy({ readOnly: [GRANT, cargo] }), {
      ...opts,
      skipReadOnlyRoots: [cargo],
    });
    expect(resolved.rejections).toEqual([]);
    expect(resolved.entries.map((entry) => entry.source)).toEqual([WORKSPACE, GRANT]);
    // Nested paths inside a skipped root are skipped too (workspace still mounts).
    const nested = resolvePolicyMounts(policy({ readOnly: [`${cargo}\\bin`] }), {
      ...opts,
      skipReadOnlyRoots: [cargo],
    });
    expect(nested.rejections).toEqual([]);
    expect(nested.entries.map((entry) => entry.source)).toEqual([WORKSPACE]);
  });

  it('mounts the policy path itself, never its registered ancestor (data home stays invisible)', () => {
    const resolved = resolvePolicyMounts(policy(), opts);
    expect(resolved.entries.map((entry) => entry.source)).toEqual([WORKSPACE]);
    // Mounting DATA_HOME wholesale would expose the whole data directory —
    // the planner must always mount the narrower policy entry.
    expect(resolved.entries.some((entry) => entry.source === DATA_HOME)).toBe(false);
  });

  it('treats cache directories as rewritten, not mounted', () => {
    const cacheDir = `${DATA_HOME}\\cache\\npm`;
    const resolved = resolvePolicyMounts(policy({ readWrite: [WORKSPACE, cacheDir] }), {
      ...opts,
      cacheDirs: [{ path: cacheDir, name: 'npm' }],
    });
    expect(resolved.rejections).toEqual([]);
    expect(resolved.entries.map((entry) => entry.source)).toEqual([WORKSPACE]);
  });

  it('upgrades a ro mount to rw when the same path needs both', () => {
    const resolved = resolvePolicyMounts(policy({ readOnly: [PROJECT], readWrite: [WORKSPACE, PROJECT] }), opts);
    expect(resolved.entries.find((entry) => entry.source === PROJECT)!.mode).toBe('rw');
  });

  it('treats case variants of the same Windows path as ONE planned mount (BR-P12-008)', () => {
    const plan = planMounts(
      policy({ readOnly: [PROJECT], readWrite: [WORKSPACE, PROJECT.toLowerCase()] }),
      opts,
    );
    expect(plan.rejections).toEqual([]);
    // Exactly two mounts: workspace + the project once (not once per spelling).
    expect(plan.mounts).toHaveLength(2);
    const projectMount = plan.mounts.find((m) => m.source.toLowerCase() === PROJECT.toLowerCase())!;
    expect(projectMount.mode).toBe('rw'); // the rw entry upgrades the ro one
    expect(projectMount.mountpoint).toBe(mountpointFor(PROJECT));
  });
});

describe('planMounts — distro policy mapping', () => {
  it('maps policy paths to hash mountpoints and the cwd', () => {
    const plan = planMounts(policy(), opts);
    expect(plan.rejections).toEqual([]);
    expect(plan.mounts).toHaveLength(1);
    expect(plan.mounts[0]!.mountpoint).toMatch(/^\/mnt\/kepcup\/[0-9a-f]{16}$/);
    expect(plan.distroReadWrites).toEqual([plan.mounts[0]!.mountpoint]);
    expect(plan.distroCwd).toBe(plan.mounts[0]!.mountpoint);
  });

  it('rewrites cache env paths to the distro cache root', () => {
    const cacheDir = `${DATA_HOME}\\cache\\pip`;
    const plan = planMounts(policy({ readWrite: [WORKSPACE, cacheDir] }), {
      ...opts,
      cacheDirs: [{ path: cacheDir, name: 'pip' }],
    });
    expect(plan.distroReadWrites).toContain('/home/kepcup/cache/pip');
    expect(plan.mounts.map((m) => m.source)).toEqual([WORKSPACE]);
  });

  it('forwards denyRead entries that fall inside a mount (project protect rules)', () => {
    const plan = planMounts(policy({ denyRead: [`${WORKSPACE}\\secrets`] }), opts);
    // 根 deny 在前（BR-P12-001），计划内的保护规则映射跟在其后（更具体的条目）。
    expect(plan.distroDenyReads).toEqual(['/mnt/kepcup', '/home/kepcup', `${plan.mounts[0]!.mountpoint}/secrets`]);
  });

  it('denies the mount root and the distro user home wholesale (BR-P12-001)', () => {
    // srt 的读模型是 deny-then-allow：发行版内若无显式 deny，则一切都默认可读
    // ——包括共享 VM 里其他对话仍挂着的挂载点（已撤销的一次性授权、其他
    // Bot 的目录）和发行版用户家目录（所有 Bot 的缓存）。两者必须整树拒绝，
    // 本命令计划的挂载点/缓存路径由 allowRead/allowWrite 按 last match wins
    // 重暴露（与数据目录策略同构）。
    const plan = planMounts(policy({ denyRead: [`${WORKSPACE}\\secrets`] }), opts);
    expect(plan.distroDenyReads[0]).toBe('/mnt/kepcup');
    expect(plan.distroDenyReads[1]).toBe('/home/kepcup');
    expect(plan.distroDenyReads).toContain(`${plan.mounts[0]!.mountpoint}/secrets`);
    // 无任何映射的 denyRead 也不影响两条根 deny 的存在。
    const bare = planMounts(policy(), opts);
    expect(bare.distroDenyReads).toEqual(['/mnt/kepcup', '/home/kepcup']);
  });

  it('REJECTS the whole exec when the cwd is unregistered', () => {
    const plan = planMounts(policy(), { ...opts, cwd: 'E:\\unregistered' });
    expect(plan.rejections.some((entry) => entry.kind === 'cwd')).toBe(true);
    expect(plan.distroCwd).toBeNull();
  });

  it('passes distro-internal cwds through unchanged', () => {
    const plan = planMounts(policy(), { ...opts, cwd: '/home/kepcup/workspaces/bot_1/conv_1' });
    expect(plan.rejections).toEqual([]);
    expect(plan.distroCwd).toBe('/home/kepcup/workspaces/bot_1/conv_1');
  });
});

describe('mount argument encoding', () => {
  it('round-trips base64url sources (spaces / non-ASCII safe)', () => {
    const source = 'C:\\Users\\我的 项目\\proj';
    expect(decodeMountSource(encodeMountSource(source))).toBe(source);
  });

  it('validates the mountpoint shape', () => {
    expect(isValidMountpoint('/mnt/kepcup/0123abcdef456789')).toBe(true);
    expect(isValidMountpoint('/mnt/kepcup/UPPERCASEHEX00')).toBe(false);
    expect(isValidMountpoint('/mnt/kepcup/short')).toBe(false);
    expect(isValidMountpoint('/etc/passwd')).toBe(false);
    expect(isValidMountpoint('/home/kepcup/0123abcdef456789')).toBe(false);
  });
});
