import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSkillRepo,
  createTestStack,
  listMessages,
  makeBot,
  openDirect,
  sendDrafts,
  skillFiles,
  step,
  viaTask,
  waitFor,
} from '@kepcup/testkit';
import type { SkillRepoFixture } from '@kepcup/testkit';
import type { Run, RunStep, SkillEntry } from '@kepcup/shared';
import type { CoreHarness } from '@kepcup/core';

/**
 * 等待「更新的」响应 run 到终态（踩坑清单：waitForRun 会被同状态旧 run 提前
 * 满足——ULID 字典序 = 时间序，这里按 id 过滤）。
 */
async function waitForNewRun(
  core: CoreHarness,
  conversationId: string,
  afterRunId: string | null,
  loopType: Run['loopType'] = 'turn',
): Promise<Run> {
  return waitFor(
    async () => {
      const result = (await core.rpc.call('runs.list', { conversationId, limit: 50 })) as {
        runs: Run[];
      };
      const found = result.runs.find(
        (run) =>
          run.loopType === loopType &&
          run.status === 'completed' &&
          (afterRunId === null || run.id > afterRunId),
      );
      return found ?? null;
    },
    { label: 'new completed response run' },
  );
}

async function latestResponseRunId(
  core: CoreHarness,
  conversationId: string,
  loopType: Run['loopType'] = 'turn',
): Promise<string | null> {
  const result = (await core.rpc.call('runs.list', { conversationId, limit: 50 })) as {
    runs: Run[];
  };
  const ids = result.runs
    .filter((r) => r.loopType === loopType)
    .map((r) => r.id)
    .sort();
  return ids.at(-1) ?? null;
}

/**
 * P08 导入集成（docs/dev/phases/P08-skills.md 测试要求）：本地 git 夹具仓库
 * （系统 git 创建，绝不触网）→ skills.import → skill_import 审批 → 安装 →
 * 下一次执行的提示词出现技能描述 → 模型读取 SKILL.md 并在沙箱中执行脚本。
 */
describe('P08 Skills：git 导入 → 审批 → 安装 → 加载 → 沙箱执行', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let repo: SkillRepoFixture;
  let botId: string;
  let conversationId: string;

  beforeAll(async () => {
    stack = await createTestStack();
    repo = await createSkillRepo(
      skillFiles('deploy-check', '部署前检查清单技能：执行部署前先按步骤自查'),
    );
    const bot = await makeBot(stack.core, '阿技');
    botId = bot.id;
    conversationId = (await openDirect(stack.core, bot.id)).id;
  });

  afterAll(async () => {
    await repo.cleanup();
    await stack.cleanup();
  });

  it('导入 → 审批卡片（扫描结果）→ 批准 → 库与引用落位', async () => {
    const result = (await stack.core.rpc.call('skills.import', {
      botId,
      sourceUrl: repo.repoDir,
    })) as { status: string; approvalId?: string };
    expect(result.status).toBe('submitted');
    const approvalId = result.approvalId!;

    // 卡片带着扫描结果（describe 文案进对话上下文，折叠文案）
    const approvals = (await stack.core.rpc.call('approvals.list', { conversationId })) as {
      approvals: Array<{ id: string; kind: string; status: string }>;
    };
    const card = approvals.approvals.find((a) => a.id === approvalId);
    expect(card?.kind).toBe('skill_import');
    expect(card?.status).toBe('pending');

    await stack.core.rpc.call('approvals.decide', { id: approvalId, approve: true });

    const list = await waitFor(
      async () => {
        const result = (await stack.core.rpc.call('skills.list', { botId })) as {
          skills: SkillEntry[];
        };
        return result.skills.length === 1 ? result.skills : null;
      },
      { label: 'installed skill listed' },
    );
    expect(list[0]!.name).toBe('deploy-check');
    expect(list[0]!.status).toBe('active');
    expect(list[0]!.kind).toBe('imported');
    expect(list[0]!.description).toContain('部署前检查清单');
    expect(list[0]!.commitOid).toBe(repo.commitOid());

    // 库目录内容锁定：hash 目录存在，仓库 .git 不在里面
    const relPath = list[0]!.relPath!;
    const libDir = path.join(stack.core.services.paths.home, relPath);
    expect(existsSync(path.join(libDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(libDir, '.git'))).toBe(false);
  }, 60_000);

  it('下一次执行：提示词出现技能描述；模型读 SKILL.md 并沙箱执行脚本', async () => {
    const list = (await stack.core.rpc.call('skills.list', { botId })) as {
      skills: SkillEntry[];
    };
    const skillDir = path.join(stack.core.services.paths.home, list.skills[0]!.relPath!);

    // D75 W2: running the skill's script is a task's work (a turn has no bash).
    stack.llm.script(
      'mock-main',
      viaTask({
        instruction: '按技能流程做一次检查',
        writes: false,
        taskSteps: [
          step()
            .expect((req) => String(req.lastUserText()).includes('技能'))
            .replyToolCall('read', { path: path.join(skillDir, 'SKILL.md') }),
          step().replyToolCall('bash', {
            command: `bash ${path.join(skillDir, 'scripts', 'greet.sh')}`,
          }),
          step().replyText('已按技能完成检查'),
        ],
        relay: 'SKILL-RELAY-1',
      }),
    );
    const beforeRunId = await latestResponseRunId(stack.core, conversationId, 'task');
    await sendDrafts(stack.core, conversationId, [{ text: '按技能流程做一次检查' }]);
    const run = await waitForNewRun(stack.core, conversationId, beforeRunId, 'task');
    await waitFor(
      async () =>
        (await listMessages(stack.core, conversationId)).some(
          (m) => 'text' in m.content && m.content.text === 'SKILL-RELAY-1',
        )
          ? true
          : null,
      { label: 'relay 1' },
    );

    // 技能描述进入系统提示词（发给模型的请求体，含 system 段）
    expect(stack.llm.requestBodiesContain('<skills>')).toBe(true);
    expect(stack.llm.requestBodiesContain('部署前检查清单技能')).toBe(true);
    expect(stack.llm.requestBodiesContain('deploy-check')).toBe(true);

    // 模型读取了 SKILL.md（read 工具结果包含正文）
    const steps = (await stack.core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: RunStep[];
    };
    const readResult = steps.steps.find(
      (s) => s.type === 'tool_result' && (s.payload as { toolName?: string }).toolName === 'read',
    );
    expect(readResult).toBeDefined();
    expect((readResult!.payload as { ok: boolean }).ok).toBe(true);
    const bashResult = steps.steps.find(
      (s) => s.type === 'tool_result' && (s.payload as { toolName?: string }).toolName === 'bash',
    );
    expect(bashResult).toBeDefined();
    expect((bashResult!.payload as { ok: boolean }).ok).toBe(true);
    expect((bashResult!.payload as { content: string }).content).toContain('hello-from-skill');
  }, 60_000);

  it('沙箱内写技能目录失败（只读）', async () => {
    const list = (await stack.core.rpc.call('skills.list', { botId })) as {
      skills: SkillEntry[];
    };
    const skillDir = path.join(stack.core.services.paths.home, list.skills[0]!.relPath!);
    const beforeRunId = await latestResponseRunId(stack.core, conversationId, 'task');
    // D75 W2: a write task (a turn has no bash at all).
    stack.llm.script(
      'mock-main',
      viaTask({
        taskSteps: [
          step().replyToolCall('bash', {
            command: `echo hacked > ${path.join(skillDir, 'attack.txt')}`,
          }),
          step().replyText('好的'),
        ],
        relay: 'SKILL-RELAY-2',
      }),
    );
    await sendDrafts(stack.core, conversationId, [{ text: '试试写入技能目录' }]);
    const run = await waitForNewRun(stack.core, conversationId, beforeRunId, 'task');
    await waitFor(
      async () =>
        (await listMessages(stack.core, conversationId)).some(
          (m) => 'text' in m.content && m.content.text === 'SKILL-RELAY-2',
        )
          ? true
          : null,
      { label: 'relay 2' },
    );
    const steps = (await stack.core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: RunStep[];
    };
    const bashResult = steps.steps.find(
      (s) => s.type === 'tool_result' && (s.payload as { toolName?: string }).toolName === 'bash',
    );
    expect(bashResult).toBeDefined();
    // 沙箱拦截：命令失败（违规或非零退出）
    expect((bashResult!.payload as { ok: boolean }).ok).toBe(false);
    expect(existsSync(path.join(skillDir, 'attack.txt'))).toBe(false);
  }, 60_000);
});

describe('P08 Skills：拒绝导入 / 多 Bot 共享 / 引用回收', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let repo: SkillRepoFixture;

  beforeAll(async () => {
    stack = await createTestStack();
    repo = await createSkillRepo(skillFiles('gc-skill', '用于共享与回收验证的技能'));
  });

  afterAll(async () => {
    await repo.cleanup();
    await stack.cleanup();
  });

  it('拒绝导入 → 技能库无记录，暂存目录被清理', async () => {
    const bot = await makeBot(stack.core, '阿拒');
    const conversationId = (await openDirect(stack.core, bot.id)).id;
    const result = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.repoDir,
    })) as { status: string; approvalId: string };
    await stack.core.rpc.call('approvals.decide', { id: result.approvalId, approve: false });

    await waitFor(
      () => {
        const rows = stack.core.services
          .mainDb!.prepare('select count(*) as n from skill_library')
          .get() as { n: number };
        return rows.n === 0 ? true : null;
      },
      { label: 'library stays empty after denial' },
    );
    const list = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
      skills: SkillEntry[];
    };
    expect(list.skills).toHaveLength(0);
    expect(existsSync(path.join(stack.core.services.paths.home, 'skills-library'))).toBe(false);
    expect(
      (
        (await stack.core.rpc.call('approvals.list', { conversationId })) as {
          approvals: Array<{ id: string; status: string }>;
        }
      ).approvals.find((a) => a.id === result.approvalId)?.status,
    ).toBe('denied');
  }, 60_000);

  it('两个 Bot 安装同一版本 → 库中一份；卸载一个仍在；都卸载后回收', async () => {
    const botA = await makeBot(stack.core, '阿甲');
    const botB = await makeBot(stack.core, '阿乙');

    for (const bot of [botA, botB]) {
      const result = (await stack.core.rpc.call('skills.import', {
        botId: bot.id,
        sourceUrl: repo.repoDir,
      })) as { status: string; approvalId: string };
      expect(result.status).toBe('submitted');
      await stack.core.rpc.call('approvals.decide', { id: result.approvalId, approve: true });
    }

    const libraryRows = stack.core.services
      .mainDb!.prepare('select count(*) as n from skill_library')
      .get() as { n: number };
    expect(libraryRows.n).toBe(1); // 内容寻址：同一版本只有一份
    const relPath = (
      (await stack.core.rpc.call('skills.list', { botId: botA.id })) as {
        skills: SkillEntry[];
      }
    ).skills[0]!.relPath!;
    const libDir = path.join(stack.core.services.paths.home, relPath);
    expect(existsSync(libDir)).toBe(true);

    await stack.core.rpc.call('skills.uninstall', { botId: botA.id, name: 'gc-skill' });
    expect(existsSync(libDir)).toBe(true); // botB 仍引用
    expect(
      ((await stack.core.rpc.call('skills.list', { botId: botB.id })) as { skills: SkillEntry[] })
        .skills,
    ).toHaveLength(1);

    await stack.core.rpc.call('skills.uninstall', { botId: botB.id, name: 'gc-skill' });
    expect(
      stack.core.services.mainDb!.prepare('select count(*) as n from skill_library').get(),
    ).toEqual({ n: 0 });
    expect(existsSync(libDir)).toBe(false); // 目录回收
  }, 90_000);

  it('删除 Bot：bot_skills 行删除、仅其引用的库版本被回收', async () => {
    const botA = await makeBot(stack.core, '阿删');
    const botB = await makeBot(stack.core, '阿留');
    for (const bot of [botA, botB]) {
      const result = (await stack.core.rpc.call('skills.import', {
        botId: bot.id,
        sourceUrl: repo.repoDir,
      })) as { status: string; approvalId: string };
      await stack.core.rpc.call('approvals.decide', { id: result.approvalId, approve: true });
    }
    const relPath = (
      (await stack.core.rpc.call('skills.list', { botId: botA.id })) as {
        skills: SkillEntry[];
      }
    ).skills[0]!.relPath!;

    await stack.core.rpc.call('bots.delete', { id: botA.id });
    await waitFor(
      () => {
        const rows = stack.core.services
          .mainDb!.prepare('select count(*) as n from bot_skills where bot_id = ?')
          .get(botA.id) as { n: number };
        return rows.n === 0 ? true : null;
      },
      { label: 'bot_skills rows removed' },
    );
    // botB 仍引用 → 库版本保留
    expect(existsSync(path.join(stack.core.services.paths.home, relPath))).toBe(true);
    expect(
      ((await stack.core.rpc.call('skills.list', { botId: botB.id })) as { skills: SkillEntry[] })
        .skills,
    ).toHaveLength(1);
  }, 90_000);

  it('删除 Bot：其自建技能目录随 bots/{id} 删除（无引用库版本不误删他人）', async () => {
    const bot = await makeBot(stack.core, '阿自');
    // 直接在 registry 层放置一个 authored 技能（生成 loop 的完整路径在
    // skills-authoring.test.ts 覆盖）；这里验证删除级联的目录部分。
    const skills = stack.core.services.skills!;
    const draft = path.join(stack.core.services.paths.cacheDir, 'draft-del');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(draft, { recursive: true });
    writeFileSync(
      path.join(draft, 'SKILL.md'),
      '---\nname: del-authored\ndescription: d\n---\n正文',
    );
    await skills.promoteAuthored({ botId: bot.id, name: 'del-authored', draftDir: draft });
    skills.activateAuthored(bot.id, 'del-authored');
    const authoredDir = path.join(
      stack.core.services.paths.home,
      'bots',
      bot.id,
      'skills',
      'del-authored',
    );
    expect(existsSync(authoredDir)).toBe(true);

    await stack.core.rpc.call('bots.delete', { id: bot.id });
    await waitFor(
      () => (existsSync(path.join(stack.core.services.paths.home, 'bots', bot.id)) ? null : true),
      { label: 'bot directory removed' },
    );
    expect(existsSync(authoredDir)).toBe(false);
  }, 60_000);
});

describe('P08 Skills：多技能仓库列出候选；ref 锁定', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let repo: SkillRepoFixture;

  beforeAll(async () => {
    stack = await createTestStack();
    repo = await createSkillRepo({
      'one/SKILL.md': '---\nname: one\ndescription: 第一个技能\n---\n正文一',
      'two/SKILL.md': '---\nname: two\ndescription: 第二个技能\n---\n正文二',
    });
  });

  afterAll(async () => {
    await repo.cleanup();
    await stack.cleanup();
  });

  it('多技能仓库返回候选列表；指定子目录后只导入该技能', async () => {
    const bot = await makeBot(stack.core, '阿多');
    const first = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.repoDir,
    })) as { status: string; candidates?: Array<{ name: string; subdirectory: string }> };
    expect(first.status).toBe('candidates');
    expect(first.candidates!.map((c) => c.name).sort()).toEqual(['one', 'two']);

    const second = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.repoDir,
      subdirectory: 'two',
    })) as { status: string; approvalId: string };
    expect(second.status).toBe('submitted');
    await stack.core.rpc.call('approvals.decide', { id: second.approvalId, approve: true });
    const list = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
      skills: SkillEntry[];
    };
    expect(list.skills.map((s) => s.name)).toEqual(['two']);
  }, 60_000);

  it('ref 指定分支/标签：锁定对应提交而非默认分支 tip；不存在的 ref 报错（BR-P08-001）', async () => {
    const { spawnSync } = await import('node:child_process');
    const oidA = repo.commitOid(); // 打标签时的提交
    spawnSync('git', ['-C', repo.repoDir, 'tag', 'v1']);
    spawnSync('git', ['-C', repo.repoDir, 'tag', '-a', 'ann1', '-m', 'annotated', oidA]);
    // 标签之后仓库前进到 B：修复前 ref 导入会记下 B（默认分支 tip）
    repo.commitFiles({ 'one/CHANGELOG.md': '# v1 之后的新提交' }, 'commit B');
    expect(repo.commitOid()).not.toBe(oidA);

    const bot = await makeBot(stack.core, '阿锁');
    const bad = await stack.core.rpc
      .call('skills.import', {
        botId: bot.id,
        sourceUrl: repo.repoDir,
        ref: 'no-such-branch',
      })
      .catch((error: { code?: string }) => error);
    expect((bad as { code?: string }).code ?? '').toBe('SKILL_IMPORT_FAILED');

    // 轻量标签：锁定 A 而不是 tip B
    const ok = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.fileUrl,
      ref: 'v1',
      subdirectory: 'one',
    })) as { status: string; approvalId: string };
    await stack.core.rpc.call('approvals.decide', { id: ok.approvalId, approve: true });
    const list = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
      skills: SkillEntry[];
    };
    expect(list.skills[0]!.commitOid).toBe(oidA);
    expect(list.skills[0]!.commitOid).not.toBe(repo.commitOid());

    // 附注标签：剥离到所指向的提交（而非 tag 对象）
    const okAnn = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.fileUrl,
      ref: 'ann1',
      subdirectory: 'two',
    })) as { status: string; approvalId: string };
    await stack.core.rpc.call('approvals.decide', { id: okAnn.approvalId, approve: true });
    const listAfter = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
      skills: SkillEntry[];
    };
    const two = listAfter.skills.find((s) => s.name === 'two');
    expect(two?.commitOid).toBe(oidA);
  }, 60_000);
});

describe('P08 Skills：停用后技能目录不可读（BR-P08-003）', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let repo: SkillRepoFixture;
  let botId: string;
  let conversationId: string;
  let skillDir: string;

  beforeAll(async () => {
    stack = await createTestStack();
    repo = await createSkillRepo(skillFiles('toggle-read', '启停可读性验证技能'));
    const bot = await makeBot(stack.core, '阿启');
    botId = bot.id;
    conversationId = (await openDirect(stack.core, bot.id)).id;
    const result = (await stack.core.rpc.call('skills.import', {
      botId,
      sourceUrl: repo.repoDir,
    })) as { status: string; approvalId: string };
    await stack.core.rpc.call('approvals.decide', { id: result.approvalId, approve: true });
    await waitFor(
      async () => {
        const list = (await stack.core.rpc.call('skills.list', { botId })) as {
          skills: SkillEntry[];
        };
        skillDir = path.join(stack.core.services.paths.home, list.skills[0]?.relPath ?? 'x');
        return list.skills.length === 1 ? true : null;
      },
      { label: 'toggle-read installed' },
    );
  });

  afterAll(async () => {
    await repo.cleanup();
    await stack.cleanup();
  });

  async function runReadTurn(): Promise<{ ok: boolean }> {
    const beforeRunId = await latestResponseRunId(stack.core, conversationId);
    stack.llm.script('mock-main', [
      step().replyToolCall('read', { path: path.join(skillDir, 'SKILL.md') }),
      step().replyText('读完了'),
    ]);
    await sendDrafts(stack.core, conversationId, [{ text: '读一下技能文件' }]);
    const run = await waitForNewRun(stack.core, conversationId, beforeRunId);
    const steps = (await stack.core.rpc.call('runs.steps', { runId: run.id })) as {
      steps: RunStep[];
    };
    const readResult = steps.steps.find(
      (s) => s.type === 'tool_result' && (s.payload as { toolName?: string }).toolName === 'read',
    );
    expect(readResult).toBeDefined();
    return readResult!.payload as { ok: boolean };
  }

  it('停用后模型对库目录 read 失败；启用后恢复', async () => {
    expect((await runReadTurn()).ok).toBe(true); // active 时可读

    await stack.core.rpc.call('skills.disable', { botId, name: 'toggle-read' });
    expect((await runReadTurn()).ok).toBe(false); // 停用后数据目录拒绝

    // 停用期间该次请求的系统提示词不含技能段。只检查 system 消息：
    // 续接回放段（D56）引用上一轮的工具输出，历史内容里可能带技能描述。
    const lastSystem = stack.llm
      .requestsFor('mock-main')
      .at(-1)
      ?.body.messages.find((m) => m.role === 'system');
    expect(JSON.stringify(lastSystem ?? {})).not.toContain('启停可读性验证技能');

    await stack.core.rpc.call('skills.enable', { botId, name: 'toggle-read' });
    expect((await runReadTurn()).ok).toBe(true); // 重新启用后恢复
  }, 90_000);
});

describe('P08 Skills：批准后落位失败如实呈现（BR-P08-004）', () => {
  let stack: Awaited<ReturnType<typeof createTestStack>>;
  let repo: SkillRepoFixture;

  beforeAll(async () => {
    stack = await createTestStack();
    repo = await createSkillRepo(skillFiles('conflict-check', '第一版：同名冲突前的内容'));
  });

  afterAll(async () => {
    await repo.cleanup();
    await stack.cleanup();
  });

  it('同名冲突时批准 → 卡片终态 failed（用户可见面）、对话无失败播报、库内容未被动', async () => {
    const bot = await makeBot(stack.core, '阿冲');
    const conversationId = (await openDirect(stack.core, bot.id)).id;

    const first = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.repoDir,
    })) as { status: string; approvalId: string };
    await stack.core.rpc.call('approvals.decide', { id: first.approvalId, approve: true });
    await waitFor(
      async () => {
        const list = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
          skills: SkillEntry[];
        };
        return list.skills.length === 1 ? true : null;
      },
      { label: 'first version installed' },
    );
    const firstCommit = (
      (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
        skills: SkillEntry[];
      }
    ).skills[0]!.commitOid;

    // 第二版：同名（frontmatter name 不变）、不同内容 → installImported 冲突
    repo.commitFiles({ 'conflict-check/extra.md': '第二版新增内容' }, 'v2');
    const second = (await stack.core.rpc.call('skills.import', {
      botId: bot.id,
      sourceUrl: repo.repoDir,
    })) as { status: string; approvalId: string };
    await stack.core.rpc.call('approvals.decide', { id: second.approvalId, approve: true });

    // 卡片终态 failed（不再是 approved）
    await waitFor(
      async () => {
        const approvals = (await stack.core.rpc.call('approvals.list', { conversationId })) as {
          approvals: Array<{ id: string; status: string }>;
        };
        return approvals.approvals.find((a) => a.id === second.approvalId)?.status === 'failed'
          ? true
          : null;
      },
      { label: 'approval marked failed' },
    );

    // 库与引用仍是第一版
    const list = (await stack.core.rpc.call('skills.list', { botId: bot.id })) as {
      skills: SkillEntry[];
    };
    expect(list.skills).toHaveLength(1);
    expect(list.skills[0]!.commitOid).toBe(firstCommit);

    // 技能是 Bot 自己的能力（消息原则）：落位失败不再向对话写系统说明，
    // 卡片终态 failed 就是用户可见的失败呈现。
    const messages = await listMessages(stack.core, conversationId);
    expect(
      messages.some(
        (m) =>
          m.senderType === 'system' &&
          (m.content as { event?: string }).event === 'skill_import_failed',
      ),
    ).toBe(false);
  }, 60_000);
});
