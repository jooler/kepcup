import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestStack, makeBot } from '@kepcup/testkit';
import type { SkillEntry, SkillPresetInfo } from '@kepcup/shared';

/**
 * 技能市场集成（公共作用域）：夹具预置目录经 KEPCUP_PRESET_SKILLS 注入 →
 * skills.presets.list（全局安装态，无入参）→ skills.presets.install（点「添加」
 * 即装，无审批卡片）→ 安装一次，两个 Bot 的 skills.list 都可见且 scope=public。
 */

const root = mkdtempSync(path.join(tmpdir(), 'skill-presets-it-'));
let stack: Awaited<ReturnType<typeof createTestStack>>;
let botA: string;
let botB: string;

function makePresetDir(): string {
  const presetDir = path.join(root, 'presets');
  mkdirSync(path.join(presetDir, 'preset-demo'), { recursive: true });
  writeFileSync(
    path.join(presetDir, 'catalog.json'),
    JSON.stringify({
      version: 1,
      presets: [
        {
          id: 'preset-demo',
          dir: 'preset-demo',
          section: 'starter',
          displayName: '演示技能',
          summary: '集成测试夹具',
          icon: 'puzzle',
          version: '1.0.0',
          tryIt: '试试我',
        },
      ],
    }),
  );
  writeFileSync(
    path.join(presetDir, 'preset-demo', 'SKILL.md'),
    '---\nname: preset-demo\ndescription: 预置演示技能：集成测试夹具\n---\n正文',
  );
  return presetDir;
}

beforeAll(async () => {
  stack = await createTestStack({ env: { KEPCUP_PRESET_SKILLS: makePresetDir() } });
  botA = (await makeBot(stack.core, '市场甲')).id;
  botB = (await makeBot(stack.core, '市场乙')).id;
});

afterAll(async () => {
  await stack.cleanup();
  rmSync(root, { recursive: true, force: true });
});

describe('P08 技能市场：预置目录 → 公共技能 → 全体 Bot 可见', () => {
  it('list（无入参）：未安装状态', async () => {
    const result = (await stack.core.rpc.call('skills.presets.list', undefined)) as {
      presets: SkillPresetInfo[];
    };
    expect(result.presets).toHaveLength(1);
    expect(result.presets[0]).toEqual(
      expect.objectContaining({
        id: 'preset-demo',
        skillName: 'preset-demo',
        displayName: '演示技能',
        section: 'starter',
        installed: false,
        upToDate: false,
        foreign: false,
      }),
    );
  });

  it('install：一次安装，两个 Bot 的 skills.list 都出现（scope=public, active）', async () => {
    const result = (await stack.core.rpc.call('skills.presets.install', {
      presetId: 'preset-demo',
    })) as { presets: SkillPresetInfo[] };
    expect(result.presets[0]).toEqual(
      expect.objectContaining({ id: 'preset-demo', installed: true, upToDate: true }),
    );

    for (const botId of [botA, botB]) {
      const list = (await stack.core.rpc.call('skills.list', { botId })) as {
        skills: SkillEntry[];
      };
      const entry = list.skills.find((skill) => skill.name === 'preset-demo');
      expect(entry, `${botId} 应看到公共技能`).toBeDefined();
      expect(entry!.scope).toBe('public');
      expect(entry!.status).toBe('active');
      expect(entry!.kind).toBe('imported');
      expect(entry!.sourceUrl).toBe('preset://preset-demo');
    }
  });

  it('从单个 Bot 面板卸载公共技能 → 全体消失', async () => {
    await stack.core.rpc.call('skills.uninstall', { botId: botA, name: 'preset-demo' });
    for (const botId of [botA, botB]) {
      const list = (await stack.core.rpc.call('skills.list', { botId })) as {
        skills: SkillEntry[];
      };
      expect(list.skills.map((skill) => skill.name)).not.toContain('preset-demo');
    }
    const presets = (await stack.core.rpc.call('skills.presets.list', undefined)) as {
      presets: SkillPresetInfo[];
    };
    expect(presets.presets[0]).toEqual(expect.objectContaining({ installed: false }));
  });

  it('未知 presetId 报错', async () => {
    let code: string | undefined;
    try {
      await stack.core.rpc.call('skills.presets.install', { presetId: 'ghost' });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('NOT_FOUND');
  });
});
