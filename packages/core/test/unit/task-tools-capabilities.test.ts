import { describe, expect, it } from 'vitest';
import { TASK_CAPABILITIES_MAX } from '@kepcup/shared';
import {
  buildTaskTools,
  type StartTaskInput,
  type TaskToolFacade,
} from '../../src/tools/task-tools.js';
import { buildTasksSegment } from '../../src/agent/context/tasks-segment.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../../src/agent/types.js';

/** D91 P1: `start_task.capabilities` — schema, validation, pass-through, not-ready note. */

const identity: RunIdentity = {
  runId: 'run_t',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'turn',
};

function setup(result: Partial<ReturnType<TaskToolFacade['start']>> = {}) {
  const starts: StartTaskInput[] = [];
  const tasks = {
    start: (_identity: RunIdentity, input: StartTaskInput) => {
      starts.push(input);
      return { taskId: 'run_task', state: 'running' as const, queueReason: null, ...result };
    },
  } as unknown as TaskToolFacade;
  const tool = buildTaskTools({ identity, tasks }).find((t) => t.name === 'start_task')!;
  return { starts, tool };
}

async function call(tool: ToolDefinition, extra: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute(
    { title: 't', instruction: 'i', source_message_ids: [], writes: false, ...extra },
    {
      identity,
      signal: new AbortController().signal,
      terminate: () => {},
      progress: () => {},
    },
  );
}

describe('start_task capabilities (D91)', () => {
  it('declares an optional string-array parameter and the description matches the <capabilities> rule', () => {
    const { tool } = setup();
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain('"capabilities"');
    const props = (tool.parameters as { properties: Record<string, unknown>; required?: string[] })
      .properties;
    expect(props['capabilities']).toBeDefined();
    expect((tool.parameters as { required?: string[] }).required ?? []).not.toContain(
      'capabilities',
    );
    expect(tool.description).toContain('capabilities');
    expect(tool.description).toContain('任务只会挂上你列出的能力');
  });

  it('trims, dedupes and passes the ids through; omitted / empty passes nothing', async () => {
    const { tool, starts } = setup();
    expect((await call(tool, { capabilities: [' app:github ', 'mcp:x', 'app:github'] })).ok).toBe(
      true,
    );
    expect(starts[0]!.capabilities).toEqual(['app:github', 'mcp:x']);
    await call(tool, {});
    await call(tool, { capabilities: [] });
    expect(starts[1]!.capabilities).toBeUndefined();
    expect(starts[2]!.capabilities).toBeUndefined();
  });

  it('rejects non-arrays, non-strings, blanks and more than TASK_CAPABILITIES_MAX distinct ids', async () => {
    const { tool, starts } = setup();
    for (const bad of ['app:github', [1], [''], ['  ']]) {
      const result = await call(tool, { capabilities: bad });
      expect(result.ok).toBe(false);
      expect(result.content).toContain('capabilities 必须是能力 id 字符串数组');
    }
    const many = Array.from({ length: TASK_CAPABILITIES_MAX + 1 }, (_, i) => `mcp:s${i}`);
    const tooMany = await call(tool, { capabilities: many });
    expect(tooMany.ok).toBe(false);
    expect(tooMany.content).toContain(`最多 ${TASK_CAPABILITIES_MAX}`);
    // Duplicates do not count toward the cap.
    expect(
      (await call(tool, { capabilities: [...many.slice(0, TASK_CAPABILITIES_MAX), many[0]] })).ok,
    ).toBe(true);
    expect(starts).toHaveLength(1);
  });

  it('tells the model which declared capabilities are not ready and will not be mounted', async () => {
    const { tool } = setup({ notReadyCapabilities: ['app:gcalendar'] });
    const result = await call(tool, { capabilities: ['app:gcalendar'] });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('app:gcalendar');
    expect(result.content).toContain('不会挂上');
  });

  it('the in-flight <tasks> segment shows the declared capabilities', () => {
    const segment = buildTasksSegment(
      [
        {
          taskId: 'run_a',
          title: 'x',
          state: 'running',
          status: 'running',
          writes: false,
          workdir: null,
          createdAt: 0,
          endedAt: null,
          queueReason: null,
          awaitingInput: false,
          injectable: true,
          lastProgress: null,
          error: null,
          capabilities: ['app:github', 'mcp:notes'],
        },
      ],
      1_000,
    );
    expect(segment).toContain('能力：app:github、mcp:notes');
  });
});
