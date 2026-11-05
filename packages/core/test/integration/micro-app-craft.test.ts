import { afterEach, describe, expect, it } from 'vitest';
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

/**
 * D112 P3 制作端到端（真实 core + 脚本化模型）：`widget_craft` 带 `micro_app:true` →
 * SPEC（能力清单 / 联网用途 / 降级 / 成本进 spec.md）→ BUILD 用包模板（micro-app.json +
 * fixtures 一并写入）→ 宿主 GATE（清单 / 包 / 能力面扫描）→ REVIEW → 交付：版本行落
 * 清单（manifest_json 非空）、回执带包摘要。BUILD 工具面带 `micro_app_sdk_inspect`。
 */

const stacks: TestStack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.llm.releaseAll();
    await stack.cleanup();
  }
});

const SPEC = [
  '> 英语口语陪练',
  '## 能力清单与理由',
  '- storage.kv：保存练习进度（session:turns）',
  '- ai.chat：老师回复',
  '- media.listen：听小朋友说话',
  '- media.speak：播报回复',
  '- context.update：练习结束同步「完成了 N 轮」',
  '## 联网用途',
  '- 不需要联网：net.mode=none（面向儿童，主动收紧）',
  '## 降级路径',
  '- 麦克风被拒 → 键盘输入框（页面里有 <input>）',
  '## 成本',
  '- 每轮约 400 token（短回复 × 轮数）',
].join('\n');

const ACCEPTANCE = JSON.stringify([
  { id: 'title', desc: '标题可见', must: true, steps: [], expect: [{ selector: '#title', textContains: 'English' }] },
]);

const body = (req: MockChatRequest): string => JSON.stringify(req.body);
const isStage = (stage: string) => (req: MockChatRequest) =>
  req.lastUserText().includes(`<stage>${stage}</stage>`);
const isTask = (req: MockChatRequest): boolean =>
  req.lastUserText().includes('<task_brief') && req.lastUserText().includes('CRAFT-MICRO');
const toolNames = (req: MockChatRequest): string[] =>
  ((req.body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
    (t) => t.function?.name ?? '',
  );

function turnIdentity(botId: string, conversationId: string): RunIdentity {
  return { runId: 'run_turn_d112_p3', botId, conversationId, loopType: 'turn' };
}

describe('widget_craft micro-app end to end (D112 P3)', () => {
  it('微应用经包模板整轮交付：清单落库、BUILD 带 inspect 工具、GATE 无 app.* 阻断', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '语音角');
    const conv = await openDirect(stack.core, bot.id);

    stack.llm.script('mock-main', [
      step()
        .expect(isTask)
        .replyToolCall('widget_craft', {
          brief: '做一个英语口语陪练微应用 CRAFT-MICRO：虚拟老师打招呼，小朋友说话或打字练习',
          title: '口语陪练',
          micro_app: true,
        }),
      step()
        .expect(isStage('SPEC'))
        .replyToolCall('write', { path: 'spec.md', content: SPEC }),
      step()
        .expect(isStage('SPEC'))
        .replyToolCall('write', { path: 'acceptance.json', content: ACCEPTANCE }),
      step().expect(isStage('SPEC')).replyToolCall('stage_done', { summary: '规格已写' }),
      step()
        .expect(isStage('BUILD'))
        .replyToolCall('widget_template', { name: 'micro-voice-tutor' }),
      step().expect(isStage('BUILD')).replyToolCall('stage_done', { summary: '模板已填' }),
      // GATE 的警告（如宿主媒体未配置）会触发一轮 FIX（设计 32 §6：警告最多修一次）。
      step().expect(isStage('FIX')).replyToolCall('stage_done', { summary: '警告已确认无需改动' }),
      step()
        .expect(isStage('REVIEW'))
        .replyToolCall('submit_review', { verdict: 'pass', findings: [] }),
      step()
        .expect((req) => isTask(req) && body(req).includes('已交付'))
        .replyText('口语陪练做好了'),
      step()
        .expect(
          (req) =>
            !req.lastUserText().includes('<stage>') && !req.lastUserText().includes('<task_brief'),
        )
        .replyText('好的'),
    ]);

    const taskId = stack.core.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
      title: '做口语陪练',
      instruction: '做一个口语陪练微应用 CRAFT-MICRO',
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

    // BUILD 阶段的工具面：微应用草稿带 micro_app_sdk_inspect（与 template / write 并存）。：微应用草稿带 micro_app_sdk_inspect（与 template / write 并存）。
    const buildTools = toolNames(stack.llm.requestsFor('mock-main').find(isStage('BUILD'))!);
    expect(buildTools).toContain('micro_app_sdk_inspect');
    expect(buildTools).toContain('widget_template');

    // 交付：卡片发出；版本行落了清单（micro-app.json）与包摘要（回执）。
    const messages = await listAllMessages(stack.core, conv.id);
    const card = messages.find(
      (message) => message.kind === 'card' && (message.content as { cardType?: string }).cardType === 'bot_widget',
    );
    expect(card).toBeDefined();
    const widget = (card!.content as unknown as { widget: { widgetId: string; microApp?: unknown } }).widget;
    expect(widget.microApp).toBeDefined();
    const version = stack.core.services
      .mainDb!.prepare(
        'select manifest_json, bundle_sha256, check_status, check_summary_json from widget_versions where widget_id = ?',
      )
      .get(widget.widgetId) as {
      manifest_json: string;
      bundle_sha256: string;
      check_status: string;
      check_summary_json: string;
    };
    expect(JSON.parse(version.manifest_json)).toMatchObject({
      spec: 'kepcup-micro-app/1',
      slug: 'voice-tutor',
    });
    expect(version.bundle_sha256).not.toBe('');
    expect(version.check_status).toBe('unverified'); // 无预览宿主 → unverified（如实上卡）
    const summary = JSON.parse(version.check_summary_json) as { knownIssues: string[] };
    // GATE 的微应用扫描没有错误级问题（模板能力面齐全 + spec 四要素齐）。
    expect(summary.knownIssues.join('\n')).not.toMatch(/app\.(manifest-invalid|bundle-invalid|permission-undeclared|fallback-missing|cost-estimate-missing)/);

    // 回执：草稿删除、tasks 上下文里没有 HTML。
    expect(JSON.stringify(runs.stepsFor(taskId))).not.toMatch(/<!DOCTYPE|<script/i);
  }, 60_000);

  it('micro_app_sdk_inspect 按名取契约；未知名给可用方法列表', async () => {
    const stack = await createTestStack();
    stacks.push(stack);
    const bot = await makeBot(stack.core, '语音角二');
    const conv = await openDirect(stack.core, bot.id);
    const inspectResults: string[] = [];
    stack.llm.script('mock-main', [
      step()
        .expect(isTask)
        .replyToolCall('widget_craft', { brief: '口语陪练 CRAFT-MICRO', title: '口语陪练二', micro_app: true }),
      step()
        .expect(isStage('SPEC'))
        .replyToolCall('micro_app_sdk_inspect', { method: 'media.listen' }),
      step()
        .expect(isStage('SPEC'))
        .replyToolCall('micro_app_sdk_inspect', { method: 'nope.nope' }),
      step().expect(isStage('SPEC')).replyToolCall('stage_done', { summary: '查完了' }),
    ]);
    const taskId = stack.core.services.orchestrator!.tasks.start(turnIdentity(bot.id, conv.id), {
      title: '查契约',
      instruction: '查一下语音契约 CRAFT-MICRO',
      sourceMessageIds: [],
      writes: false,
    }).taskId;
    const runs = stack.core.services.domain!.runs;
    await waitFor(
      () => {
        const run = runs.get(taskId);
        return run !== null && ['completed', 'failed', 'cancelled'].includes(run.status) ? run : null;
      },
      { label: 'task settled', timeoutMs: 30_000 },
    );
    for (const run of runs.listByConversation(conv.id, 100).filter((r) => r.loopType === 'widget_authoring')) {
      for (const entry of runs.stepsFor(run.id)) {
        if (entry.type === 'tool_result' && entry.payload['toolName'] === 'micro_app_sdk_inspect') {
          inspectResults.push(String(entry.payload['content']));
        }
      }
    }
    expect(inspectResults[0]).toContain('media.listen');
    expect(inspectResults[1]).toContain('nope.nope');
    expect(inspectResults[1]).toContain('ai.chat');
  }, 60_000);
});
