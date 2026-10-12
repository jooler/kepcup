import { afterEach, describe, expect, it } from 'vitest';
import type { Run } from '@kepcup/shared';
import {
  createTestStack,
  listAllMessages,
  makeBot,
  openDirect,
  step,
  waitFor,
  type MockChatRequest,
  type TestStack,
} from '@kepcup/testkit';
import type { RunIdentity } from '../../src/agent/types.js';
import { WIDGET_TEMPLATES } from '../../src/widgets/templates/index.js';

/**
 * D87 制作 loop 端到端（真实 core + 脚本化模型）：任务调 widget_craft → 制作 loop 的 SPEC /
 * BUILD 阶段各是一条 `widget_authoring` 子 run（parent_run_id = 任务）→ 宿主 GATE → 交付
 * 发卡。验收证据是 run_steps：任务 run 里只有 widget_craft 的参数与 ≤1500 字的回执，没有
 * HTML / 检查报告；HTML 只出现在阶段 run 的步骤里。工具面：任务有 widget_craft /
 * widget_publish，没有 widget_create / widget_update；对话轮一个都没有。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

const GOOD = WIDGET_TEMPLATES.find((t) => t.name === 'blank')!.html;
const MARKER = 'CRAFT-E2E';
const ACCEPTANCE = JSON.stringify([
  {
    id: 'click',
    desc: '点击后计数',
    must: true,
    steps: [{ click: '#action' }],
    expect: [{ selector: '#status', textContains: '1' }],
  },
  { id: 'nobad', desc: '无坏文本', must: true, expect: [{ noBadText: true }] },
]);

const body = (req: MockChatRequest): string => JSON.stringify(req.body);
const isStage = (stage: string) => (req: MockChatRequest) =>
  req.lastUserText().includes(`<stage>${stage}</stage>`);
const isTask = (req: MockChatRequest): boolean =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes(MARKER);
const toolNames = (req: MockChatRequest): string[] =>
  ((req.body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
    (t) => t.function?.name ?? '',
  );

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_d87', botId, conversationId, loopType: 'turn' };
}

describe('widget_craft end to end (D87)', () => {
  it('任务只拿回执；阶段 run 落库且挂在任务下；交付的卡片带自检状态', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '小组件');
    const conv = await openDirect(stack.core, bot.id);

    stack.llm.script('mock-main', [
      step()
        .expect(isTask)
        .replyToolCall('widget_craft', {
          brief: '做个点击计数器，刷新后计数还在',
          title: '计数器',
          acceptance: ['刷新后计数还在'],
        }),
      step()
        .expect(isStage('SPEC'))
        .replyToolCall('write', { path: 'spec.md', content: '> 点击计数器\n# 规格\n' }),
      step()
        .expect(isStage('SPEC'))
        .replyToolCall('write', { path: 'acceptance.json', content: ACCEPTANCE }),
      step().expect(isStage('SPEC')).replyToolCall('stage_done', { summary: '规格已写' }),
      step().expect(isStage('BUILD')).replyToolCall('write', { path: 'index.html', content: GOOD }),
      step().expect(isStage('BUILD')).replyToolCall('stage_done', { summary: '已写' }),
      step()
        .expect((req) => isTask(req) && body(req).includes('已交付'))
        .replyText('组件「计数器」做好了，点卡片上的「加载」就能用。'),
      // 任务结束后的唤醒轮（说什么都行）。
      step()
        .expect(
          (req) =>
            !req.lastUserText().includes('<stage>') && !req.lastUserText().includes('<task_brief'),
        )
        .replyText('好的'),
    ]);

    const taskId = stack.core.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
      title: '做组件',
      instruction: `做一个计数器组件 ${MARKER}`,
      sourceMessageIds: [],
      writes: false,
    }).taskId;
    const runs = stack.core.services.domain!.runs;
    await waitFor(
      () => {
        const run = runs.get(taskId);
        return run !== null && run.status === 'completed' ? run : null;
      },
      { label: 'task completed', timeoutMs: 30_000 },
    );

    // 阶段 run：两条（SPEC、BUILD），挂在任务下、已完成、不产生对话消息。
    const stageRuns: Run[] = runs
      .listByConversation(conv.id, 100)
      .filter((r) => r.loopType === 'widget_authoring');
    expect(stageRuns).toHaveLength(2);
    for (const run of stageRuns) {
      expect(run.parentRunId).toBe(taskId);
      expect(run.status).toBe('completed');
    }

    // 上下文隔离：任务 run 的步骤里只有 widget_craft 的参数与回执，没有 HTML。
    const taskSteps = JSON.stringify(runs.stepsFor(taskId));
    expect(taskSteps).toContain('widget_craft');
    expect(taskSteps).not.toMatch(/<!DOCTYPE|<script|<html|kepcup\.storage/i);
    const receipt = runs
      .stepsFor(taskId)
      .find((s) => s.type === 'tool_result' && s.payload['toolName'] === 'widget_craft');
    const receiptText = String(receipt?.payload['content'] ?? '');
    expect(receiptText).toContain('v1 已交付');
    expect(receiptText.length).toBeLessThanOrEqual(1_500);
    // HTML 只在阶段 run 的步骤里。
    const stageSteps = stageRuns.map((run) => JSON.stringify(runs.stepsFor(run.id))).join('\n');
    expect(stageSteps).toContain('kepcup.storage');

    // 交付：卡片带自检状态（无 S2 → unverified），版本行落了检查摘要。
    const messages = await listAllMessages(stack.core, conv.id);
    const card = messages.find(
      (m) => m.kind === 'card' && (m.content as { cardType?: string }).cardType === 'bot_widget',
    );
    expect(card).toBeDefined();
    const widget = (
      card!.content as unknown as { widget: { widgetId: string; checkStatus: string } }
    ).widget;
    expect(widget.checkStatus).toBe('unverified');
    const version = stack.core.services
      .mainDb!.prepare(
        'select check_status, check_summary_json from widget_versions where widget_id = ?',
      )
      .get(widget.widgetId) as { check_status: string; check_summary_json: string };
    expect(version.check_status).toBe('unverified');
    expect(JSON.parse(version.check_summary_json)).toMatchObject({
      gateRounds: 1,
      previewed: false,
    });

    // 工具面：任务有 widget_craft / widget_publish，没有 widget_create / widget_update；对话轮都没有。
    const requests = stack.llm.requestsFor('mock-main');
    const taskTools = toolNames(requests.find(isTask)!);
    expect(taskTools).toEqual(expect.arrayContaining(['widget_craft', 'widget_publish']));
    expect(taskTools).not.toContain('widget_create');
    expect(taskTools).not.toContain('widget_update');
    const turn = requests.find(
      (req) =>
        !req.lastUserText().includes('<stage>') && !req.lastUserText().includes('<task_brief'),
    );
    if (turn !== undefined) {
      expect(toolNames(turn)).not.toContain('widget_craft');
      expect(toolNames(turn)).not.toContain('widget_create');
    }
    // 阶段 run 的工具面只有草稿目录工具。
    const buildTools = toolNames(requests.find(isStage('BUILD'))!);
    expect(buildTools.sort()).toEqual(
      ['edit', 'ls', 'read', 'stage_done', 'widget_check', 'widget_template', 'write'].sort(),
    );
  });
});
