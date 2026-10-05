import { describe, expect, it } from 'vitest';
import { buildSkillTools } from '../../src/tools/skill-tools.js';
import type { SkillInstallFacade } from '../../src/tools/skill-tools.js';
import type { PreparedImport } from '../../src/skills/library.js';
import type { RunIdentity, ToolContext } from '../../src/agent/types.js';

/**
 * install_skill（docs/design/22-file-skill-routing.md，D63）：参数校验、
 * 预置路径（幂等 / 审批批准 / 拒绝降级）、外部仓库路径（批准导入 / 拒绝丢弃）。
 */

const identity: RunIdentity = {
  runId: 'run_1',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'response',
};

const ctx = (signal = new AbortController().signal): ToolContext => ({
  identity,
  signal,
  terminate: () => {},
  progress: () => {},
});

const PRESET_PAYLOAD = {
  presetId: 'mineru',
  name: 'mineru',
  displayName: 'MinerU',
  summary: '文档解析',
  version: '1.0.0',
  missingDeps: [],
  installed: false,
};

function preparedFixture(): PreparedImport {
  return {
    status: 'ready',
    stagingDir: '/tmp/staging',
    skillDir: '/tmp/staging/skill',
    scan: {
      name: 'remote-skill',
      description: '外部技能',
      files: [],
      declaredPermissions: { network: false, credentials: false, notes: [] },
      runtimeDeps: [],
      compatibility: 'compatible',
      compatibilityReasons: [],
      risks: [],
      sandboxDeclaration: null,
    },
    contentHash: 'hash',
    commitOid: 'oid',
    reuseExisting: false,
    payload: {
      sourceUrl: 'https://github.com/x/y',
      ref: '',
      subdirectory: '',
      commitOid: 'oid',
      name: 'remote-skill',
      description: '外部技能',
      scan: {
        name: 'remote-skill',
        description: '外部技能',
        files: [],
        declaredPermissions: { network: false, credentials: false, notes: [] },
        runtimeDeps: [],
        compatibility: 'compatible',
        compatibilityReasons: [],
        risks: [],
        sandboxDeclaration: null,
      },
      missingDeps: [],
    },
    sourceUrl: 'https://github.com/x/y',
    botId: identity.botId!,
    conversationId: identity.conversationId!,
  } as unknown as PreparedImport;
}

function facade(overrides: {
  decision?: 'approved' | 'denied' | 'cancelled';
  installed?: boolean;
  prepareError?: Error;
}): { facade: SkillInstallFacade; calls: Record<string, number> } {
  const calls: Record<string, number> = { request: 0, install: 0, commit: 0, discard: 0 };
  const facadeImpl: SkillInstallFacade = {
    describePreset: (presetId) => ({
      ...PRESET_PAYLOAD,
      presetId,
      installed: overrides.installed ?? false,
    }),
    installPreset: () => {
      calls.install += 1;
      return { skillPath: '/library/mineru@hash/SKILL.md' };
    },
    prepareFromUrl: async () => {
      if (overrides.prepareError !== undefined) throw overrides.prepareError;
      return preparedFixture();
    },
    commitImport: () => {
      calls.commit += 1;
    },
    discardImport: () => {
      calls.discard += 1;
    },
    requestApproval: async () => {
      calls.request += 1;
      return { decision: overrides.decision ?? 'approved', approvalId: 'apr_1' };
    },
    failApproval: () => {},
  };
  return { facade: facadeImpl, calls };
}

function installTool(facadeImpl: SkillInstallFacade) {
  const tools = buildSkillTools({ identity, skills: facadeImpl });
  return tools.find((tool) => tool.name === 'install_skill')!;
}

describe('install_skill', () => {
  it('preset_id 与 source_url 必须二选一', async () => {
    const { facade: impl } = facade({});
    const tool = installTool(impl);
    const neither = await tool.execute({ reason: 'r' }, ctx());
    expect(neither.errorCode).toBe('INVALID_INPUT');
    const both = await tool.execute({ preset_id: 'a', source_url: 'b', reason: 'r' }, ctx());
    expect(both.errorCode).toBe('INVALID_INPUT');
  });

  it('预置已安装：幂等返回位置，不再发起审批', async () => {
    const { facade: impl, calls } = facade({ installed: true });
    const tool = installTool(impl);
    const result = await tool.execute({ preset_id: 'mineru', reason: 'r' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('已经安装');
    expect(calls.request).toBe(0);
  });

  it('预置路径：批准 → 安装为公共技能并返回 SKILL.md 位置', async () => {
    const { facade: impl, calls } = facade({ decision: 'approved' });
    const tool = installTool(impl);
    const result = await tool.execute({ preset_id: 'mineru', reason: 'r' }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('/library/mineru@hash/SKILL.md');
    expect(calls.request).toBe(1);
    expect(calls.install).toBe(1);
  });

  it('预置路径：拒绝 → APPROVAL_DENIED，不安装', async () => {
    const { facade: impl, calls } = facade({ decision: 'denied' });
    const tool = installTool(impl);
    const result = await tool.execute({ preset_id: 'mineru', reason: 'r' }, ctx());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('APPROVAL_DENIED');
    expect(calls.install).toBe(0);
  });

  it('外部仓库路径：批准 → commit 落位；拒绝 → 丢弃 staging', async () => {
    const approved = facade({ decision: 'approved' });
    const ok = await installTool(approved.facade).execute(
      { source_url: 'https://github.com/x/y', reason: 'r' },
      ctx(),
    );
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain('remote-skill');
    expect(approved.calls.commit).toBe(1);
    expect(approved.calls.discard).toBe(0);

    const denied = facade({ decision: 'denied' });
    const rejected = await installTool(denied.facade).execute(
      { source_url: 'https://github.com/x/y', reason: 'r' },
      ctx(),
    );
    expect(rejected.errorCode).toBe('APPROVAL_DENIED');
    expect(denied.calls.commit).toBe(0);
    expect(denied.calls.discard).toBe(1);
  });

  it('外部仓库 prepare 失败：错误文本回到模型', async () => {
    const { facade: impl } = facade({
      prepareError: new Error('仓库中未找到技能目录'),
    });
    const result = await installTool(impl).execute(
      { source_url: 'https://github.com/x/y', reason: 'r' },
      ctx(),
    );
    expect(result.ok).toBe(false);
    expect(result.content).toContain('仓库中未找到技能目录');
  });
});
