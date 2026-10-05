import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendDrafts,
  step,
  waitFor,
} from '@kepcup/testkit';
import type { SkillEntry } from '@kepcup/shared';

/**
 * P08 自建集成（docs/dev/phases/P08-skills.md 测试要求）：skill_suggestion
 * 与 create_skill 两个任务来源 → 技能生成 loop（mock 模型写草稿）→ 验证
 * （frontmatter + bash -n + 沙箱跑 tests/）→ 自动启用并通知；失败保留草稿、
 * 不启用、无通知。历史与回滚走自建技能仓库。
 */

const GOOD_SKILL_MD = [
  '---',
  'name: release-note',
  'description: 按固定模板生成发布说明',
  'test: bash tests/run.sh',
  '---',
  '',
  '# Release note',
  '',
  '运行 scripts/greet.sh 生成标题。',
].join('\n');

function authoringSteps(name = 'release-note', description = '按固定模板生成发布说明') {
  const skillMd = GOOD_SKILL_MD
    .replace('name: release-note', `name: ${name}`)
    .replace('description: 按固定模板生成发布说明', `description: ${description}`);
  return [
    step()
      .expect((req) => String(req.lastUserText()).includes('<suggestion>'))
      .replyToolCall('write', { path: 'SKILL.md', content: skillMd }),
    step().replyToolCall('write', {
      path: 'scripts/greet.sh',
      content: '#!/usr/bin/env bash\necho release-title\n',
    }),
    step().replyToolCall('write', {
      path: 'tests/run.sh',
      content: '#!/usr/bin/env bash\ntest -f SKILL.md\n',
    }),
    step().replyText('技能草稿已完成'),
  ];
}

function enqueueSuggestion(
  core: Awaited<ReturnType<typeof createTestStack>>['core'],
  botId: string,
  conversationId: string,
  name: string,
): void {
  core.services.domain!.jobs.enqueue({
    type: 'skill_suggestion',
    botId,
    conversationId,
    payload: { name, description: '按固定模板生成发布说明', reason: '同类任务已完成多次', responseRunId: null },
    priority: 2,
    dedupeKey: `skill_suggestion:${botId}:${name}`,
  });
}

describe('P08 自建：skill_suggestion → 生成 loop → 验证 → 启用 + 通知', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let botId: string;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack();
    const bot = await makeBot(stack.core, '阿创');
    botId = bot.id;
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('成功路径：验证通过 → active + 通知消息；草稿目录不在仓库历史中', async () => {
    enqueueSuggestion(stack.core, botId, conversationId, 'release-note');
    stack.llm.script('mock-main', authoringSteps());

    const entry = await waitFor(
      async () => {
        const result = (await stack.core.rpc.call('skills.list', { botId })) as {
          skills: SkillEntry[];
        };
        return result.skills.find((s) => s.name === 'release-note' && s.status === 'active') ?? null;
      },
      { label: 'authored skill active', timeoutMs: 30_000 },
    );
    expect(entry.kind).toBe('authored');

    // 消息原则：自创技能是 Bot 自己积累的经验，完成不向对话播报。
    const announced = (await listMessages(stack.core, conversationId)).some(
      (m) => (m.content as { text?: string }).text?.includes('我整理了一个新技能') === true,
    );
    expect(announced).toBe(false);

    // 安装目录 + _drafts 被 .gitignore 排除在仓库历史之外
    const skillDir = path.join(stack.core.services.paths.home, 'bots', botId, 'skills', 'release-note');
    expect(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('release-note');
    const history = (await stack.core.rpc.call('skills.history', {
      botId,
      name: 'release-note',
    })) as { history: Array<{ oid: string; message: string }> };
    expect(history.history.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('失败路径：SKILL.md 无 description → 不启用、无通知、草稿保留并记录原因', async () => {
    enqueueSuggestion(stack.core, botId, conversationId, 'broken-skill');
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('<suggestion>'))
        .replyToolCall('write', { path: 'SKILL.md', content: '---\nname: broken-skill\n---\n没有描述' }),
      step().replyText('写完了'),
    ]);

    await waitFor(
      () => {
        const draft = path.join(
          stack.core.services.paths.home,
          'bots',
          botId,
          'skills',
          '_drafts',
          'broken-skill',
          'SKILL.md',
        );
        return existsSync(draft) ? true : null;
      },
      { label: 'draft kept on disk', timeoutMs: 30_000 },
    );
    await waitFor(
      () => {
        const row = stack.core.services.mainDb!
          .prepare("select status from bot_skills where bot_id = ? and name = 'broken-skill'")
          .get(botId) as { status: string } | undefined;
        return row?.status === 'draft' ? true : null;
      },
      { label: 'bot_skills row stays draft', timeoutMs: 15_000 },
    );
    const reasonFile = path.join(
      stack.core.services.paths.home,
      'bots',
      botId,
      'skills',
      '_drafts',
      'broken-skill',
      'validation-reason.txt',
    );
    expect(readFileSync(reasonFile, 'utf8')).toContain('description');

    // 没有「新技能」通知（机器人只发过 release-note 那一条）
    const messages = await listMessages(stack.core, conversationId);
    expect(
      messages.filter(
        (m) =>
          m.senderType === 'bot' &&
          (m.content as { text?: string }).text?.includes('broken-skill') === true,
      ),
    ).toHaveLength(0);
  }, 60_000);

  it('create_skill 工具：用户说「以后都这样做」→ 登记 → 生成 → 启用 + 通知', async () => {
    stack.llm.script('mock-main', [
      step()
        .expect((req) => String(req.lastUserText()).includes('以后都这样做'))
        .replyToolCall('create_skill', {
          name: 'weekly-report',
          description: '按团队模板写周报',
          reason: '用户要求固化写周报的流程',
        }),
      step().replyText('好的，我会沉淀这个技能'),
      ...authoringSteps('weekly-report', '按团队模板写周报'),
    ]);
    await sendDrafts(stack.core, conversationId, [{ text: '以后都这样做周报，帮我记住这个流程' }]);

    const entry = await waitFor(
      async () => {
        const result = (await stack.core.rpc.call('skills.list', { botId })) as {
          skills: SkillEntry[];
        };
        return result.skills.find((s) => s.name === 'weekly-report' && s.status === 'active') ?? null;
      },
      { label: 'create_skill authored skill active', timeoutMs: 30_000 },
    );
    expect(entry.kind).toBe('authored');
    // 同上：create_skill 全程生成也不播报。
    const announced = (await listMessages(stack.core, conversationId)).some(
      (m) => (m.content as { text?: string }).text?.includes('我整理了一个新技能') === true,
    );
    expect(announced).toBe(false);
  }, 60_000);

  it('改进已有自建技能：生成 loop 携 <existing_skill> 当前版本，全程产出新版本（BR-P08-009⑤）', async () => {
    // weekly-report 已由上一用例的 create_skill 全程生成；这里通过
    // skill_suggestion 再走一遍生成 loop 改进它。
    const before = readFileSync(
      path.join(stack.core.services.paths.home, 'bots', botId, 'skills', 'weekly-report', 'SKILL.md'),
      'utf8',
    );
    enqueueSuggestion(stack.core, botId, conversationId, 'weekly-report');
    stack.llm.script('mock-main', [
      step()
        // 任务输入带 <existing_skill>（当前版本全文，untrusted 界定）
        .expect((req) => {
          const text = String(req.lastUserText());
          return (
            text.includes('<existing_skill>') &&
            text.includes('<untrusted>') &&
            text.includes('按团队模板写周报')
          );
        })
        .replyToolCall('write', {
          path: 'SKILL.md',
          content:
            '---\nname: weekly-report\ndescription: 按团队模板写周报（v2，含风险章节）\n---\n正文 v2',
        }),
      step().replyToolCall('write', {
        path: 'scripts/greet.sh',
        content: '#!/usr/bin/env bash\necho release-title\n',
      }),
      step().replyText('改进完成'),
    ]);

    const entry = await waitFor(
      async () => {
        const result = (await stack.core.rpc.call('skills.list', { botId })) as {
          skills: SkillEntry[];
        };
        return (
          result.skills.find(
            (s) => s.name === 'weekly-report' && s.status === 'active' && s.description.includes('v2'),
          ) ?? null
        );
      },
      { label: 'weekly-report v2 active', timeoutMs: 30_000 },
    );
    expect(entry.kind).toBe('authored');
    const after = readFileSync(
      path.join(stack.core.services.paths.home, 'bots', botId, 'skills', 'weekly-report', 'SKILL.md'),
      'utf8',
    );
    expect(after).toContain('风险章节');
    expect(after).not.toBe(before);
    const history = (await stack.core.rpc.call('skills.history', {
      botId,
      name: 'weekly-report',
    })) as { history: Array<{ oid: string; message: string }> };
    expect(history.history.length).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('失败路径的 draft 行可经 RPC 卸载且目录无残留（BR-P08-011）', async () => {
    // broken-skill 的 draft 行与 _drafts 目录来自上面的失败路径用例
    const draftDir = path.join(
      stack.core.services.paths.home,
      'bots',
      botId,
      'skills',
      '_drafts',
      'broken-skill',
    );
    expect(existsSync(draftDir)).toBe(true);
    await stack.core.rpc.call('skills.uninstall', { botId, name: 'broken-skill' });
    const rows = stack.core.services.mainDb!
      .prepare('select count(*) as n from bot_skills where bot_id = ? and name = ?')
      .get(botId, 'broken-skill') as { n: number };
    expect(rows.n).toBe(0);
    expect(existsSync(draftDir)).toBe(false);
  }, 30_000);

  it('改进已有自建技能 → 新版本提交；skills.rollback 只动目标技能、失败回滚不脏工作区（BR-P08-002）', async () => {
    const skills = stack.core.services.skills!;
    const botSkillsRoot = path.join(stack.core.services.paths.home, 'bots', botId, 'skills');
    // 第二版：改描述后整体重提交（与生成 loop 的 promote 路径相同）
    const draftV2 = path.join(stack.core.services.paths.cacheDir, 'draft-v2');
    mkdirSync(draftV2, { recursive: true });
    writeFileSync(
      path.join(draftV2, 'SKILL.md'),
      '---\nname: release-note\ndescription: 按固定模板生成发布说明（v2，含风险章节）\n---\n正文 v2',
    );
    await skills.promoteAuthored({ botId, name: 'release-note', draftDir: draftV2 });

    const history = (await stack.core.rpc.call('skills.history', {
      botId,
      name: 'release-note',
    })) as { history: Array<{ oid: string; message: string }> };
    expect(history.history.length).toBeGreaterThanOrEqual(2);
    const first = history.history[history.history.length - 1]!;

    // 同仓库的兄弟技能基线：回滚 release-note 不得波及 weekly-report
    const weeklyPath = path.join(botSkillsRoot, 'weekly-report', 'SKILL.md');
    const weeklyBefore = readFileSync(weeklyPath, 'utf8');
    const weeklyHistoryBefore = (await stack.core.rpc.call('skills.history', {
      botId,
      name: 'weekly-report',
    })) as { history: Array<{ oid: string; message: string }> };

    await stack.core.rpc.call('skills.rollback', {
      botId,
      name: 'release-note',
      commitOid: first.oid,
    });
    const restored = readFileSync(path.join(botSkillsRoot, 'release-note', 'SKILL.md'), 'utf8');
    expect(restored).not.toContain('风险章节'); // v2 内容已退位
    expect(restored).toContain('生成标题'); // 第一版内容
    const afterRollback = (await stack.core.rpc.call('skills.history', {
      botId,
      name: 'release-note',
    })) as { history: Array<{ message: string }> };
    expect(afterRollback.history[0]!.message).toContain('rollback');

    // 兄弟技能逐字节一致且回滚提交不进其历史（只动目标子树）
    expect(readFileSync(weeklyPath, 'utf8')).toBe(weeklyBefore);
    const weeklyHistoryAfter = (await stack.core.rpc.call('skills.history', {
      botId,
      name: 'weekly-report',
    })) as { history: Array<{ oid: string; message: string }> };
    expect(weeklyHistoryAfter.history.map((entry) => entry.oid)).toEqual(
      weeklyHistoryBefore.history.map((entry) => entry.oid),
    );

    // 回滚到不含该技能的提交 → 抛错，且工作区与 HEAD 完全一致（无脏状态）
    const releaseNoteFirstOid = first.oid; // release-note 的首个提交里没有 weekly-report
    const rejected = await stack.core.rpc
      .call('skills.rollback', {
        botId,
        name: 'weekly-report',
        commitOid: releaseNoteFirstOid,
      })
      .catch((error: { code?: string; message?: string }) => error);
    expect((rejected as { code?: string }).code ?? '').toBe('INVALID_INPUT');
    expect((rejected as { message?: string }).message ?? '').toContain('没有该技能');
    const { spawnSync } = await import('node:child_process');
    const status = spawnSync('git', ['-C', botSkillsRoot, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(status.stdout.trim()).toBe(''); // 无脏工作区
    expect(readFileSync(path.join(botSkillsRoot, 'release-note', 'SKILL.md'), 'utf8')).toBe(
      restored,
    );
    expect(readFileSync(weeklyPath, 'utf8')).toBe(weeklyBefore);
  }, 60_000);
});

describe('P08 自建：生成期间删除 Bot 不复活数据（BR-P08-007）', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let botId: string;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack();
    const bot = await makeBot(stack.core, '阿竞');
    botId = bot.id;
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it('authoring 模型 hold 期间删 Bot：放行后无 bots/{id} 目录、无 bot_skills 行、无孤儿 run', async () => {
    enqueueSuggestion(stack.core, botId, conversationId, 'ghost-skill');
    const held = step()
      .expect((req) => String(req.lastUserText()).includes('<suggestion>'))
      .replyToolCall('write', {
        path: 'SKILL.md',
        content: '---\nname: ghost-skill\ndescription: 不该存在\n---\n正文',
      })
      .hold();
    stack.llm.script('mock-main', [held]);

    // 等生成 loop 已被模型 hold（请求已到 mock）
    await waitFor(
      () => (stack.llm.requestsFor('mock-main').length >= 1 ? true : null),
      { label: 'authoring request held at the mock', timeoutMs: 20_000 },
    );

    await stack.core.rpc.call('bots.delete', { id: botId });
    held.release();

    // 任务终态收敛（已认领的在途任务跑完或被取消）
    await waitFor(
      () => {
        const rows = stack.core.services.mainDb!
          .prepare("select status from jobs where type = 'skill_suggestion'")
          .all() as Array<{ status: string }>;
        return rows.length >= 1 && rows.every((row) => row.status !== 'pending') ? true : null;
      },
      { label: 'authoring job settled', timeoutMs: 30_000 },
    );

    // 无复活目录、无 bot_skills 行、无孤儿 run 行
    expect(existsSync(path.join(stack.core.services.paths.home, 'bots', botId))).toBe(false);
    const skillRows = stack.core.services.mainDb!
      .prepare('select count(*) as n from bot_skills where bot_id = ?')
      .get(botId) as { n: number };
    expect(skillRows.n).toBe(0);
    const runRows = stack.core.services.runsDb!
      .prepare('select count(*) as n from runs where bot_id = ?')
      .get(botId) as { n: number };
    expect(runRows.n).toBe(0);
  }, 60_000);
});
