import { describe, expect, it } from 'vitest';
import {
  buildTaskTools,
  type StartTaskInput,
  type TaskToolFacade,
} from '../../src/tools/task-tools.js';
import type { RunIdentity, ToolDefinition, ToolResult } from '../../src/agent/types.js';

/** D123: `start_task.writes` — boolean | glob array, pass-through to the host (validation lives there). */

const identity: RunIdentity = {
  runId: 'run_t',
  botId: 'bot_1',
  conversationId: 'conv_1',
  loopType: 'turn',
};

function setup() {
  const starts: StartTaskInput[] = [];
  const tasks = {
    start: (_identity: RunIdentity, input: StartTaskInput) => {
      starts.push(input);
      return { taskId: 'run_task', state: 'running' as const, queueReason: null };
    },
  } as unknown as TaskToolFacade;
  const tool = buildTaskTools({ identity, tasks }).find((t) => t.name === 'start_task')!;
  return { starts, tool };
}

async function call(tool: ToolDefinition, extra: Record<string, unknown>): Promise<ToolResult> {
  return tool.execute(
    { title: 't', instruction: 'i', source_message_ids: [], ...extra },
    {
      identity,
      signal: new AbortController().signal,
      terminate: () => {},
      progress: () => {},
    },
  );
}

describe('start_task write domains (D123)', () => {
  it('schema accepts a boolean or a string array and documents the domain semantics', () => {
    const { tool } = setup();
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain('"writes"');
    expect(schema).toContain('"anyOf"');
    expect(tool.description).toContain('写域');
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props['writes']).toBeDefined();
  });

  it('passes booleans, glob arrays and omission through unchanged', async () => {
    const { tool, starts } = setup();
    await call(tool, { writes: true });
    await call(tool, { writes: ['apps/renderer/**'] });
    await call(tool, {});
    expect(starts[0]?.writes).toBe(true);
    expect(starts[1]?.writes).toEqual(['apps/renderer/**']);
    expect('writes' in (starts[2] ?? {})).toBe(false);
  });

  it('rejects non-boolean / non-string-array values before reaching the host', async () => {
    const { tool, starts } = setup();
    const result = await call(tool, { writes: 42 });
    expect(result.ok).toBe(false);
    expect(starts).toHaveLength(0);
  });
});
