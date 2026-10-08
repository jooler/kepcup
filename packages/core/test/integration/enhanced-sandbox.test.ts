import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createSkillRepo,
  createTestStack,
  makeBot,
  openDirect,
  sendDrafts,
  step,
  waitFor,
  viaTask,
} from '@kepcup/testkit';
import type { SkillEntry, SkillRepoFixture } from '@kepcup/shared';
import type {
  SandboxAvailability,
  SandboxBackend,
  SandboxBackendKind,
  SandboxExecRequest,
  SandboxExecResult,
} from '../../src/sandbox/types.js';

/**
 * P12 任务 6 集成：增强级后端与技能声明的衔接。真实 Lima/Podman 在本机
 * 不可用（`command -v limactl` 为空，按任务书不安装）——用注入的 stub 后端
 * 驱动门控与路由；真实增强后端上的安全用例集列
 * todo/cross-platform-acceptance.md P12（任务书测试要求「增强级：在 macOS
 * 与 Linux 上运行安全用例集」）。
 */

/** Records execs; probe/exec behavior scriptable per case. */
class StubEnhancedBackend implements SandboxBackend {
  readonly kind: SandboxBackendKind = 'lima';
  available: boolean;
  readonly execs: SandboxExecRequest[] = [];

  constructor(available: boolean) {
    this.available = available;
  }

  async probe(): Promise<SandboxAvailability> {
    return this.available
      ? { backend: 'lima', available: true }
      : {
          backend: 'lima',
          available: false,
          reason: '未安装 Lima，增强沙箱不可用（stub）',
          fixHint: 'brew install lima',
        };
  }

  async exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    this.execs.push(req);
    return { exitCode: 0, stdout: 'enhanced-ok', stderr: '', timedOut: false, violations: [] };
  }
}

const tempHomes: string[] = [];

/** SKILL.md with `sandbox: enhanced` in the frontmatter. */
function enhancedSkillFiles(name: string, description: string): Record<string, string> {
  return {
    [`${name}/SKILL.md`]: [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      'sandbox: enhanced',
      '---',
      '',
      `# ${name}`,
    ].join('\n'),
    [`${name}/scripts/run.sh`]: '#!/usr/bin/env bash\necho enhanced-ok\n',
  };
}

async function importAndApprove(
  core: CoreHarness,
  repo: SkillRepoFixture,
  botId: string,
): Promise<void> {
  const result = (await core.rpc.call('skills.import', {
    botId,
    sourceUrl: repo.repoDir,
  })) as { status: string; approvalId?: string };
  expect(result.status).toBe('submitted');
  await core.rpc.call('approvals.decide', { id: result.approvalId!, approve: true });
}

/** Warms the enhanced-availability cache via the sandbox.status RPC. */
async function warmEnhancedCache(core: CoreHarness): Promise<void> {
  await core.rpc.call('sandbox.status', { probe: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('P12 增强级：技能门控与执行路由（stub 后端）', () => {
  it('增强后端未安装：导入的 enhanced 技能 → incompatible + 可安装提示；enable 拒绝', async () => {
    const stub = new StubEnhancedBackend(false);
    const stack = await createTestStack({ enhancedSandbox: stub });
    const repo = await createSkillRepo(enhancedSkillFiles('needs-vm', '需要虚拟机级隔离的技能'));
    try {
      const bot = await makeBot(stack.core, '阿增');
      // 缓存预热：让导入时的兼容性判定看到「不可用」。
      await warmEnhancedCache(stack.core);
      await importAndApprove(stack.core, repo, bot.id);

      const list = await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
            skills: SkillEntry[];
          };
          return result.skills.length === 1 ? result.skills : null;
        },
        { label: 'imported skill listed' },
      );
      expect(list[0]!.status).toBe('incompatible');
      expect(list[0]!.compatibility).toBe('incompatible');
      expect(list[0]!.enhancedRequired).toBe(true);
      expect(list[0]!.enhancedInstallHint).toContain('增强沙箱');
      // 状态原因带可安装提示（对话里的导入说明同源）。
      expect(list[0]!.statusReason).toContain('增强沙箱');

      // enable 被拒（含提示文案）。
      await expect(
        stack.core.rpc.call('skills.enable', { botId: bot.id, name: 'needs-vm' }),
      ).rejects.toThrowError(/增强沙箱/);
    } finally {
      await repo.cleanup();
      await stack.cleanup();
    }
  });

  it('导入时不可用 → 安装后 enable 翻转为 active 并路由增强后端（BR-P12-002）', async () => {
    const stub = new StubEnhancedBackend(false);
    const stack = await createTestStack({ enhancedSandbox: stub });
    const repo = await createSkillRepo(enhancedSkillFiles('late-vm', '安装后可用的技能'));
    try {
      const bot = await makeBot(stack.core, '阿flip');
      const conversationId = (await openDirect(stack.core, bot.id)).id;
      await warmEnhancedCache(stack.core);
      await importAndApprove(stack.core, repo, bot.id);
      const imported = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
        skills: SkillEntry[];
      };
      expect(imported.skills[0]!.status).toBe('incompatible');

      // 安装增强沙箱（stub 翻转 + 缓存刷新）。
      stub.available = true;
      await warmEnhancedCache(stack.core);

      // 导入说明承诺的「安装所需的增强沙箱后，可在技能面板重新启用」成立。
      const enabled = (await stack.core.rpc.call('skills.enable', {
        botId: bot.id,
        name: 'late-vm',
      })) as { skills: SkillEntry[] };
      expect(enabled.skills[0]!.status).toBe('active');

      // 存储状态已回写 active：activeSkills/readableDirs/enhancedSandboxRequired
      // 消费同一行 → bash 路由到增强后端执行。
      // D75 W2: commands run in tasks (a turn has no bash).
      stack.llm.script(
        'mock-main',
        viaTask({
          taskSteps: [
            step().replyToolCall('bash', { command: 'echo routed-after-flip' }),
            step().replyText('完成'),
          ],
          relay: '好了',
        }),
      );
      await sendDrafts(stack.core, conversationId, [{ text: '再跑一下命令' }]);
      await waitFor(
        async () => (stub.execs.length > 0 ? stub.execs : null),
        { label: 'enhanced backend received the exec after flip' },
      );
      expect(stub.execs[0]!.command).toBe('echo routed-after-flip');
    } finally {
      await repo.cleanup();
      await stack.cleanup();
    }
  }, 60_000);

  it('增强后端可用：技能 active；bash 命令经增强后端执行（路由生效）', async () => {    const stub = new StubEnhancedBackend(true);
    const stack = await createTestStack({ enhancedSandbox: stub });
    const repo = await createSkillRepo(enhancedSkillFiles('vm-skill', '虚拟机级隔离技能（可用）'));
    try {
      const bot = await makeBot(stack.core, '阿route');
      const conversationId = (await openDirect(stack.core, bot.id)).id;
      await warmEnhancedCache(stack.core);
      await importAndApprove(stack.core, repo, bot.id);

      const list = await waitFor(
        async () => {
          const result = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
            skills: SkillEntry[];
          };
          return result.skills.length === 1 ? result.skills : null;
        },
        { label: 'imported skill listed' },
      );
      expect(list[0]!.status).toBe('active');
      expect(list[0]!.compatibility).toBe('compatible');
      expect(list[0]!.enhancedRequired).toBe(true);

      // 路由谓词：该 Bot 的 active 技能要求增强沙箱。
      const sandboxStatus = (await stack.core.rpc.call('sandbox.status', { probe: true })) as {
        enhanced?: { backend: string; available: boolean } | null;
      };
      expect(sandboxStatus.enhanced).toMatchObject({ backend: 'lima', available: true });

      // 一次响应 loop：模型调 bash → 网关路由到增强后端（stub 的 stdout 进工具结果）。
      // D75 W2: commands run in tasks (a turn has no bash).
      stack.llm.script(
        'mock-main',
        viaTask({
          taskSteps: [
            step().replyToolCall('bash', { command: 'echo routed-check' }),
            step().replyText('完成'),
          ],
          relay: '好了',
        }),
      );
      await sendDrafts(stack.core, conversationId, [{ text: '跑一下命令' }]);
      await waitFor(
        async () => (stub.execs.length > 0 ? stub.execs : null),
        { label: 'enhanced backend received the exec' },
      );
      expect(stub.execs[0]!.command).toBe('echo routed-check');
    } finally {
      await repo.cleanup();
      await stack.cleanup();
    }
  }, 60_000);

  it('后端事后消失：既有 active 行的判定翻转为 incompatible（fail-closed，不进提示词）', async () => {
    const stub = new StubEnhancedBackend(true);
    const stack = await createTestStack({ enhancedSandbox: stub });
    const repo = await createSkillRepo(enhancedSkillFiles('vanishing', '增强沙箱消失用技能'));
    try {
      const bot = await makeBot(stack.core, '阿van');
      await warmEnhancedCache(stack.core);
      await importAndApprove(stack.core, repo, bot.id);
      const active = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
        skills: SkillEntry[];
      };
      expect(active.skills[0]!.status).toBe('active');

      // 增强后端被卸载（stub 翻转 + 缓存刷新）。
      stub.available = false;
      await warmEnhancedCache(stack.core);

      const list = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
        skills: SkillEntry[];
      };
      // 判定实时翻转（存储的 scan_json 不变）。
      expect(list.skills[0]!.compatibility).toBe('incompatible');
      expect(list.skills[0]!.enhancedInstallHint).toContain('增强沙箱');
      // disable 后无法重新启用。
      await stack.core.rpc.call('skills.disable', { botId: bot.id, name: 'vanishing' });
      await expect(
        stack.core.rpc.call('skills.enable', { botId: bot.id, name: 'vanishing' }),
      ).rejects.toThrowError(/增强沙箱/);
    } finally {
      await repo.cleanup();
      await stack.cleanup();
    }
  }, 60_000);
});

afterAll(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});
