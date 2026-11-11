import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Message, RunStep } from '@kepcup/shared';
import {
  approvalConversationIdOf,
  buildTaskRunTimeline,
  formatCompactTokens,
  formatElapsed,
  formatToolArgs,
  groupTaskRunEntries,
  latestPlan,
  peerMessageOf,
  pendingTaskQuestionOf,
  resultPreview,
  steerDisplayText,
  taskElapsedMs,
  taskRunUsageParts,
  toolCallSummary,
  toolCommandText,
  toolRowDisplay,
} from './task-run-view';

/** 任务执行过程页的 run_steps 展示逻辑（docs/design/42-task-run-view.md）。 */

function step(seq: number, type: RunStep['type'], payload: unknown): RunStep {
  return { id: `s${seq}`, runId: 'run_task', seq, type, payload, createdAt: seq };
}

let messageSeq = 0;

function systemEvent(
  content: { event: string; text: string; options?: string[]; answer?: string },
  taskId: string | null = null,
): Message {
  messageSeq += 1;
  return {
    id: `m${messageSeq}`,
    conversationId: 'conv1',
    seq: messageSeq,
    senderType: 'system',
    senderBotId: null,
    kind: 'system_event',
    content,
    replyTo: null,
    mentions: [],
    batchId: null,
    runId: null,
    status: 'normal',
    editedAt: null,
    createdAt: messageSeq,
    attachments: [],
    ownerBotId: null,
    taskId,
  };
}

describe('buildTaskRunTimeline', () => {
  it('keeps assistant prose and drops empty assistant / request steps', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'request', { messages: [] }),
      step(1, 'assistant', { text: '我先看一下目录。', stopReason: 'toolUse' }),
      step(2, 'assistant', { text: '', stopReason: 'toolUse' }),
      step(3, 'assistant', { text: '完成了。', stopReason: 'stop' }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['assistant', 'assistant']);
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: '我先看一下目录。' });
  });

  it('keeps thinking-only turns and the reasoning text of each assistant turn', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'assistant', { text: '', thinking: '先确认目录结构', stopReason: 'toolUse' }),
      step(1, 'assistant', { text: '看完了。', thinking: '可以总结了', stopReason: 'stop' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'assistant',
      text: '',
      thinking: '先确认目录结构',
    });
    expect(entries[1]).toMatchObject({ text: '看完了。', thinking: '可以总结了' });
  });

  it('groups consecutive tool calls and splits groups at other entries', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'assistant', { text: '开始', stopReason: 'toolUse' }),
      step(1, 'tool_call', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
      step(2, 'tool_call', { toolCallId: 'c2', toolName: 'read', args: { path: 'a.ts' } }),
      step(3, 'steer', { text: '先看 README' }),
      step(4, 'tool_call', { toolCallId: 'c3', toolName: 'bash', args: { command: 'cat README' } }),
    ]);
    const grouped = groupTaskRunEntries(entries);
    expect(grouped.map((entry) => entry.kind)).toEqual([
      'assistant',
      'toolGroup',
      'steer',
      'toolGroup',
    ]);
    const first = grouped[1]!;
    expect(first.kind).toBe('toolGroup');
    if (first.kind === 'toolGroup') {
      expect(first.tools.map((tool) => tool.toolCallId)).toEqual(['c1', 'c2']);
      expect(first.id).toBe('group-s1');
    }
  });

  it('pairs a tool_result with its tool_call and keeps the call order', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'assistant', { text: '开始', stopReason: 'toolUse' }),
      step(1, 'tool_call', {
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pnpm test' },
      }),
      step(2, 'tool_call', { toolCallId: 'c2', toolName: 'read', args: { path: 'src/a.ts' } }),
      step(3, 'tool_result', {
        toolCallId: 'c1',
        toolName: 'bash',
        ok: true,
        content: 'all green',
      }),
      step(4, 'tool_result', {
        toolCallId: 'c2',
        toolName: 'read',
        ok: false,
        content: 'not found',
        errorCode: 'ENOENT',
      }),
    ]);
    const tools = entries.filter((entry) => entry.kind === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({
      kind: 'tool',
      name: 'bash',
      result: { ok: true, content: 'all green' },
    });
    expect(tools[1]).toMatchObject({
      name: 'read',
      result: { ok: false, content: 'not found', errorCode: 'ENOENT' },
    });
  });

  it('keeps progress, steer and system entries in sequence order', () => {
    const entries = buildTaskRunTimeline([
      step(2, 'progress', { text: '计划 1/2：运行测试' }),
      step(0, 'steer', { text: '先看 README' }),
      step(1, 'system', { text: '模型重连' }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['steer', 'system', 'progress']);
  });

  it('drops auto tool progress so consecutive tool calls share one group', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'tool_call', { toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } }),
      step(1, 'progress', { text: '正在执行命令 ls' }),
      step(2, 'tool_call', { toolCallId: 'c2', toolName: 'bash', args: { command: 'cat a' } }),
      step(3, 'progress', { text: '正在编辑 /tmp/a' }),
      step(4, 'progress', { text: '计划 2/3：收尾' }),
      step(5, 'tool_call', { toolCallId: 'c3', toolName: 'bash', args: { command: 'rm a' } }),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(['tool', 'tool', 'progress', 'tool']);
    const grouped = groupTaskRunEntries(entries);
    expect(grouped.map((entry) => entry.kind)).toEqual(['toolGroup', 'progress', 'toolGroup']);
    const first = grouped[0]!;
    if (first.kind === 'toolGroup') expect(first.tools).toHaveLength(2);
  });

  it('keeps an orphan tool_result visible', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'tool_result', { toolCallId: 'lost', toolName: 'bash', ok: true, content: 'ok' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'tool', name: 'bash', result: { ok: true } });
  });

  it('steer entries show the instruction inside <task_inject>, not the LLM framing', () => {
    const entries = buildTaskRunTimeline([
      step(0, 'steer', {
        text: [
          '<task_inject>',
          '我在操作当前设备，你可以忽略我的操作',
          '</task_inject>',
          '对话中的你追加了新的指令：据此调整当前的工作。',
        ].join('\n'),
      }),
      step(1, 'steer', { text: '先看 README' }),
    ]);
    expect(entries[0]).toMatchObject({
      kind: 'steer',
      text: '我在操作当前设备，你可以忽略我的操作',
    });
    // 没有包裹的旧数据 / 纯文本 steer 原样显示。
    expect(entries[1]).toMatchObject({ kind: 'steer', text: '先看 README' });
  });

  it('详情页按分组渲染工具卡并展示思考（源码契约锁接线）', () => {
    const source = readFileSync(new URL('./TaskRunView.svelte', import.meta.url), 'utf8');
    expect(source).toContain("import TaskRunToolGroup from './TaskRunToolGroup.svelte';");
    expect(source).toContain('const renderEntries = $derived(groupTaskRunEntries(entries));');
    expect(source).toContain('data-testid="task-run-thinking"');
    expect(source).toContain('<TaskRunToolGroup tools={entry.tools} {active} />');
  });
});

describe('steerDisplayText', () => {
  it('unwraps <task_inject> and hides the tags and trailing note', () => {
    const text = [
      '<task_inject>',
      '我在操作当前设备，你可以忽略我的操作',
      '</task_inject>',
      '对话中的你追加了新的指令：据此调整当前的工作。',
    ].join('\n');
    expect(steerDisplayText(text)).toBe('我在操作当前设备，你可以忽略我的操作');
  });

  it('keeps the multi-line inner content (instruction plus source message lines)', () => {
    const text = [
      '<task_inject>',
      '据此调整当前的工作',
      '<source_messages>',
      '[12:03] 用户：脚本跑完了吗',
      '</source_messages>',
      '</task_inject>',
      '对话中的你追加了新的指令：据此调整当前的工作。',
    ].join('\n');
    expect(steerDisplayText(text)).toBe(
      ['据此调整当前的工作', '<source_messages>', '[12:03] 用户：脚本跑完了吗', '</source_messages>'].join(
        '\n',
      ),
    );
  });

  it('shows plain steer texts as-is', () => {
    expect(steerDisplayText('先看 README')).toBe('先看 README');
    expect(steerDisplayText('  换成 pnpm test  ')).toBe('换成 pnpm test');
  });
});

describe('latestPlan', () => {
  const plan = (entries: Array<{ step: string; status: string }>, explanation = '') => ({
    explanation,
    plan: entries,
  });

  it('returns the last valid update_plan call', () => {
    const steps = [
      step(0, 'tool_call', {
        toolCallId: 'c1',
        toolName: 'update_plan',
        args: plan([
          { step: '检查项目', status: 'in_progress' },
          { step: '运行测试', status: 'pending' },
        ]),
      }),
      step(1, 'tool_call', {
        toolCallId: 'c2',
        toolName: 'update_plan',
        args: plan(
          [
            { step: '检查项目', status: 'completed' },
            { step: '运行测试', status: 'in_progress' },
          ],
          '检查完成',
        ),
      }),
      step(2, 'tool_call', { toolCallId: 'c3', toolName: 'read', args: { path: 'a.ts' } }),
    ];
    expect(latestPlan(steps)).toMatchObject({
      explanation: '检查完成',
      updatedAt: 1,
      plan: [
        { step: '检查项目', status: 'completed' },
        { step: '运行测试', status: 'in_progress' },
      ],
    });
  });

  it('skips invalid plans and returns null when there is none', () => {
    expect(latestPlan([])).toBeNull();
    expect(
      latestPlan([
        step(0, 'tool_call', {
          toolCallId: 'bad',
          toolName: 'update_plan',
          args: { plan: [{ step: 'x', status: 'done' }] },
        }),
      ]),
    ).toBeNull();

    const valid = step(0, 'tool_call', {
      toolCallId: 'good',
      toolName: 'update_plan',
      args: plan([{ step: '检查', status: 'pending' }]),
    });
    const invalidLater = step(1, 'tool_call', {
      toolCallId: 'bad',
      toolName: 'update_plan',
      args: { plan: [] },
    });
    expect(latestPlan([valid, invalidLater])).toMatchObject({
      plan: [{ step: '检查', status: 'pending' }],
    });
  });
});

describe('toolCallSummary', () => {
  it('uses the command for bash', () => {
    expect(toolCallSummary({ name: 'bash', title: null, args: { command: 'pnpm test' } })).toBe(
      'pnpm test',
    );
  });

  it('prefers an external agent title', () => {
    expect(
      toolCallSummary({ name: 'Read', title: 'Reading src/a.ts', args: { path: 'src/a.ts' } }),
    ).toBe('Reading src/a.ts');
  });

  it('falls back to the first string argument', () => {
    expect(toolCallSummary({ name: 'custom_tool', title: null, args: { query: 'hello' } })).toBe(
      'hello',
    );
  });
});

describe('formatting helpers', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });

  it('counts from start once running, and stops at the end', () => {
    expect(taskElapsedMs({ createdAt: 100, startedAt: 200, endedAt: null }, 1_200)).toBe(1_000);
    expect(taskElapsedMs({ createdAt: 100, startedAt: 200, endedAt: 900 }, 5_000)).toBe(700);
  });

  it('renders JSON args and a one-line result preview', () => {
    expect(formatToolArgs({ path: 'a.ts' })).toContain('"path": "a.ts"');
    expect(resultPreview('\n\nfirst line\nsecond line')).toBe('first line');
    expect(resultPreview('')).toBe('');
  });

  it('shows the raw shell command, and falls back to formatted args', () => {
    expect(toolCommandText({ name: 'bash', args: { command: ' pnpm test ' } })).toBe('pnpm test');
    expect(toolCommandText({ name: 'powershell', args: { cmd: 'dir' } })).toBe('dir');
    expect(toolCommandText({ name: 'read', args: { path: 'a.ts' } })).toContain('"path": "a.ts"');
  });
});

describe('toolRowDisplay', () => {
  const tool = (
    name: string,
    args: unknown,
    extra: {
      title?: string;
      result?: { ok: boolean; content: string; diffStats?: { added: number; removed: number } };
    } = {},
  ) => ({
    kind: 'tool' as const,
    id: 's1',
    toolCallId: 'c1',
    name,
    title: extra.title ?? null,
    args,
    result: extra.result ?? null,
  });

  it('maps built-in tools to a verb + target', () => {
    expect(toolRowDisplay(tool('bash', { command: 'pnpm test' }))).toMatchObject({
      actionKey: 'task.run.action.run',
      target: 'pnpm test',
      mono: true,
      added: null,
      removed: null,
    });
    expect(toolRowDisplay(tool('read', { path: 'src/a.ts' }))).toMatchObject({
      actionKey: 'task.run.action.read',
      target: 'src/a.ts',
      mono: false,
    });
    expect(toolRowDisplay(tool('read', { path: 'src/a.ts', offset: 50, limit: 50 }))).toMatchObject(
      {
        target: 'src/a.ts (50-99)',
      },
    );
    expect(toolRowDisplay(tool('ls', {}))).toMatchObject({
      actionKey: 'task.run.action.ls',
      target: '.',
    });
    expect(
      toolRowDisplay(tool('grep', { pattern: 'PROJECT_MODULES', path: 'apps' })),
    ).toMatchObject({ actionKey: 'task.run.action.grep', target: 'PROJECT_MODULES' });
  });

  it('computes added / removed lines for edit and write arguments', () => {
    expect(
      toolRowDisplay(
        tool('edit', {
          path: 'README.md',
          edits: [{ oldText: 'a\nb', newText: 'a\nc' }],
        }),
      ),
    ).toMatchObject({
      actionKey: 'task.run.action.edit',
      target: 'README.md',
      added: 1,
      removed: 1,
    });
    expect(
      toolRowDisplay(tool('write', { path: 'a.ts', content: 'one\ntwo\nthree\n' })),
    ).toMatchObject({
      actionKey: 'task.run.action.write',
      target: 'a.ts',
      added: 3,
      removed: 0,
    });
    expect(
      toolRowDisplay(
        tool(
          'edit',
          { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
          { result: { ok: false, content: 'oldText not found' } },
        ),
      ),
    ).toMatchObject({ actionKey: 'task.run.action.edit', added: null, removed: null });
  });

  it("splits an external agent's title into action + target and keeps its diff stats", () => {
    const row = toolRowDisplay(
      tool(
        'Edit',
        { file_path: 'types.ts' },
        {
          title: 'Edited types.ts',
          result: { ok: true, content: '', diffStats: { added: 9, removed: 1 } },
        },
      ),
    );
    expect(row).toMatchObject({
      actionKey: null,
      verb: 'Edited',
      target: 'types.ts',
      added: 9,
      removed: 1,
    });
  });
});

describe('approvalConversationIdOf（详情页审批条的会话）', () => {
  it('任务自带的会话优先，任务视图未读到时回退当前会话', () => {
    expect(approvalConversationIdOf({ conversationId: 'conv_task' }, 'conv_current')).toBe(
      'conv_task',
    );
    expect(approvalConversationIdOf({ conversationId: 'conv_task' }, null)).toBe('conv_task');
    expect(approvalConversationIdOf(null, 'conv_current')).toBe('conv_current');
    expect(approvalConversationIdOf({ conversationId: null }, 'conv_current')).toBe('conv_current');
  });

  it('两头都没有会话时为 null（不渲染审批条）', () => {
    expect(approvalConversationIdOf({ conversationId: null }, null)).toBeNull();
    expect(approvalConversationIdOf(null, undefined)).toBeNull();
  });

  it('详情页挂了同会话的 ApprovalDock（组件无 DOM 测试，源码契约锁接线）', () => {
    const source = readFileSync(new URL('./TaskRunView.svelte', import.meta.url), 'utf8');
    expect(source).toContain(
      "import ApprovalDock from '$lib/features/approvals/ApprovalDock.svelte';",
    );
    expect(source).toContain('permissions.pendingOf(approvalConversationId)');
    expect(source).toContain('data-testid="task-run-approvals"');
    expect(source).toContain('<ApprovalDock conversationId={approvalConversationId} />');
    expect(source).toContain('void permissions.reloadApprovals(id)');
  });
});

describe('pendingTaskQuestionOf（详情页提问条）', () => {
  const questionCard = (taskId: string, extra: Record<string, unknown> = {}): Message =>
    systemEvent(
      { event: 'task_question', text: '用哪个方案？', options: ['A', 'B'], ...extra },
      taskId,
    );

  it('取该任务绑定的最新一条未答提问卡', () => {
    const older = questionCard('task_1');
    const newer = questionCard('task_1');
    expect(pendingTaskQuestionOf([older, newer], 'task_1')).toBe(newer);
  });

  it('别的任务的提问卡不算', () => {
    const other = questionCard('task_2');
    expect(pendingTaskQuestionOf([other], 'task_1')).toBeNull();
  });

  it('已答 / 作废（content.answer 回写）的卡不再算待回答', () => {
    const answered = questionCard('task_1', { answer: 'A' });
    expect(pendingTaskQuestionOf([answered], 'task_1')).toBeNull();
  });

  it('非 task_question 的系统事件与别的绑定行不干扰', () => {
    const unrelated = systemEvent(
      { event: 'bot_setup_question', text: '', options: ['x'] },
      'task_1',
    );
    const taskEvent = systemEvent({ event: 'run_interrupted', text: '中断' }, 'task_1');
    expect(pendingTaskQuestionOf([unrelated, taskEvent], 'task_1')).toBeNull();
  });

  it('没有消息时为 null', () => {
    expect(pendingTaskQuestionOf([], 'task_1')).toBeNull();
  });

  it('上下文用量：紧凑 token 数按 K/M 压缩', () => {
    expect(formatCompactTokens(0)).toBe('0');
    expect(formatCompactTokens(Number.NaN)).toBe('0');
    expect(formatCompactTokens(999)).toBe('999');
    expect(formatCompactTokens(1_000)).toBe('1K');
    expect(formatCompactTokens(1_250)).toBe('1.3K');
    expect(formatCompactTokens(12_345)).toBe('12.3K');
    expect(formatCompactTokens(123_456)).toBe('123K');
    expect(formatCompactTokens(999_999)).toBe('1M');
    expect(formatCompactTokens(1_234_567)).toBe('1.2M');
  });

  it('上下文用量：token / 窗口 / 百分比与缓存命中率', () => {
    expect(
      taskRunUsageParts({ contextTokens: 12_300, contextWindow: 200_000, cacheHitRate: 0.82 }),
    ).toEqual({ tokens: '12.3K', window: '200K', percent: 6, cacheHitPercent: 82 });
  });

  it('上下文用量：没有 window 只显示 token 数，没有命中率不显示命中率', () => {
    expect(
      taskRunUsageParts({ contextTokens: 8_500, contextWindow: null, cacheHitRate: null }),
    ).toEqual({ tokens: '8.5K', window: null, percent: null, cacheHitPercent: null });
  });

  it('上下文用量：没有上下文 token 或没有用量时整块隐藏', () => {
    expect(taskRunUsageParts(null)).toBeNull();
    expect(taskRunUsageParts(undefined)).toBeNull();
    expect(
      taskRunUsageParts({ contextTokens: null, contextWindow: 200_000, cacheHitRate: 0.5 }),
    ).toBeNull();
  });

  it('详情页从会话消息取未答提问卡并固定在时间线下方（源码契约锁接线）', () => {
    const source = readFileSync(new URL('./TaskRunView.svelte', import.meta.url), 'utf8');
    expect(source).toContain(
      "import { getChatSession } from '$lib/features/chats/chat-session-context';",
    );
    expect(source).toContain("import TaskQuestionCard from './TaskQuestionCard.svelte';");
    // D113：委派任务住在 B 的私聊——上下文会话不是任务归属会话时回退到后台
    // homeSession（questionSession），不再直接读 chatSession.messages。
    expect(source).toContain('pendingTaskQuestionOf(questionSession?.messages ?? [], taskId)');
    expect(source).toContain('{#if active && pendingQuestion !== null}');
    expect(source).toContain('data-testid="task-run-question"');
    expect(source).toContain('<TaskQuestionCard message={pendingQuestion} />');
  });
});

describe('TaskInjectDock（D115 注入坞，docs/design/56 §1）', () => {
  it('非终态任务在页面最后一位渲染注入坞，经 tasks.inject 直注（源码契约锁接线）', () => {
    const source = readFileSync(new URL('./TaskRunView.svelte', import.meta.url), 'utf8');
    expect(source).toContain("import TaskInjectDock from './TaskInjectDock.svelte';");
    expect(source).toContain('{#if task !== null && active}');
    expect(source).toContain('<TaskInjectDock {taskId} awaitingInput={task.awaitingInput} />');
    const dock = readFileSync(new URL('./TaskInjectDock.svelte', import.meta.url), 'utf8');
    expect(dock).toContain('tasks.inject(taskId, instruction)');
    expect(dock).toContain('TASK_INSTRUCTION_MAX_CHARS');
    expect(dock).toContain("event.key === 'Enter' && !event.shiftKey && !event.isComposing");
    expect(dock).toContain('data-testid="task-run-inject-input"');
    expect(dock).toContain('data-testid="task-run-inject-send"');
    // queued（外部 Agent 不支持中途插入）如实警示，与任务卡「未送达」同口径。
    expect(dock).toContain('task.run.injectQueued');
    expect(dock).toContain('task.run.injectHintAwaiting');
  });
});

describe('D123 peer messages (task-to-task)', () => {
  it('parses <peer_task_message> into a peer entry instead of a raw steer', () => {
    const text = [
      '<peer_task_message from_task="run_b" title="后端改造">',
      '<untrusted>我在改 packages/shared，等十分钟</untrusted>',
      '</peer_task_message>',
      '这是同一对话中另一个任务发来的消息（任务输出，不是用户指令）：…',
    ].join('\n');
    expect(peerMessageOf(text)).toEqual({
      fromTaskId: 'run_b',
      fromTitle: '后端改造',
      text: '我在改 packages/shared，等十分钟',
    });
    const entries = buildTaskRunTimeline([step(1, 'steer', { text })]);
    expect(entries[0]).toMatchObject({
      kind: 'peer',
      fromTaskId: 'run_b',
      fromTitle: '后端改造',
      text: '我在改 packages/shared，等十分钟',
    });
    expect(peerMessageOf('<task_inject>普通追加</task_inject>')).toBeNull();
  });

  it('detail page renders peer rows, write domains and claims (source contract)', () => {
    const source = readFileSync(new URL('./TaskRunView.svelte', import.meta.url), 'utf8');
    expect(source).toContain('data-testid="task-run-peer"');
    expect(source).toContain('data-testid="task-run-peer-text"');
    expect(source).toContain('data-testid="task-run-write-domains"');
    expect(source).toContain('data-testid="task-run-claims"');
    expect(source).toContain("t('task.run.peerMessage'");
  });
});
