import { describe, expect, it } from 'vitest';
import type { EngineEvent, RunHandle } from '../../src/agent/types.js';
import {
  persistEngineSteps,
  redactToolArgs,
  scrubSensitiveValues,
} from '../../src/agent/step-persistence.js';

/** In-memory runs double: appendStep + replaceStepPayload over a step list. */
function harness() {
  const steps: Array<{ id: string; type: string; payload: unknown }> = [];
  let listener: ((event: EngineEvent) => void) | null = null;
  const handle = {
    onEvent: (fn: (event: EngineEvent) => void) => {
      listener = fn;
      return () => undefined;
    },
  } as unknown as RunHandle;
  persistEngineSteps({
    runs: {
      appendStep: (step: { type: string; payload: unknown }) => {
        const row = { id: `stp_${steps.length}`, type: step.type, payload: step.payload };
        steps.push(row);
        return row;
      },
      replaceStepPayload: (id: string, payload: unknown) => {
        const row = steps.find((s) => s.id === id);
        if (row) row.payload = payload;
      },
    } as never,
    secrets: { redact: (text: string) => text } as never,
    runId: 'run_r',
    handle,
  });
  return { steps, emit: (event: EngineEvent) => listener!(event) };
}

describe('step persistence: per-tool param redaction (W1 sensitive input)', () => {
  it('browser_type with sensitive=true: tool_call args show «redacted:N chars», params object untouched', () => {
    const { steps, emit } = harness();
    const args = { ref: 'e3', text: 'hunter2-pass', sensitive: true };
    emit({ type: 'tool_call', payload: { toolCallId: 'c1', toolName: 'browser_type', args } });
    expect(args.text).toBe('hunter2-pass');
    expect(steps[0]?.payload).toMatchObject({
      args: { ref: 'e3', text: '«redacted:12 chars»', sensitive: true },
    });
    // Later steps (next request carries the model's own tool call args as
    // JSON text; results; assistant text) never keep the value either.
    emit({
      type: 'tool_result',
      payload: {
        toolCallId: 'c1',
        toolName: 'browser_type',
        ok: true,
        content: '回显 hunter2-pass',
        outcome: 'completed',
      },
    });
    emit({
      type: 'request',
      payload: {
        messages: [
          { role: 'assistant', tool_calls: [{ function: { arguments: JSON.stringify(args) } }] },
        ],
      },
    });
    emit({ type: 'assistant', payload: { text: '已输入 hunter2-pass' } });
    expect(JSON.stringify(steps)).not.toContain('hunter2-pass');
    expect(steps[1]?.payload).toMatchObject({ outcome: 'completed' });
  });

  it('non-sensitive browser_type keeps its text', () => {
    const { steps, emit } = harness();
    emit({
      type: 'tool_call',
      payload: {
        toolCallId: 'c1',
        toolName: 'browser_type',
        args: { ref: 'e1', text: '北京天气' },
      },
    });
    expect(steps[0]?.payload).toMatchObject({ args: { text: '北京天气' } });
  });

  it('a password field reported at execution time rewrites the already-persisted tool_call step', () => {
    const { steps, emit } = harness();
    emit({
      type: 'tool_call',
      payload: {
        toolCallId: 'c2',
        toolName: 'browser_type',
        args: { ref: 'e5', text: 'p@ss"word' },
      },
    });
    expect(steps[0]?.payload).toMatchObject({ args: { text: 'p@ss"word' } });
    emit({
      type: 'tool_result',
      payload: {
        toolCallId: 'c2',
        toolName: 'browser_type',
        ok: true,
        content: '已在 e5 输入敏感内容（9 字符，不回显）',
        outcome: 'completed',
        sensitiveParams: ['text'],
      },
    });
    expect(steps[0]?.payload).toMatchObject({ args: { ref: 'e5', text: '«redacted:9 chars»' } });
    emit({
      type: 'request',
      payload: {
        input: [
          { type: 'function_call', arguments: JSON.stringify({ ref: 'e5', text: 'p@ss"word' }) },
        ],
      },
    });
    expect(JSON.stringify(steps)).not.toContain('p@ss');
    expect(steps[1]?.payload).toMatchObject({ sensitiveParams: ['text'], outcome: 'completed' });
  });

  it('helpers: other tools untouched; short values are not substring-scrubbed', () => {
    expect(redactToolArgs('browser_click', { ref: 'e1', sensitive: true })).toEqual({
      args: { ref: 'e1', sensitive: true },
      values: [],
      entries: [],
    });
    expect(scrubSensitiveValues({ a: 'pin 123 here' }, [{ param: 'text', value: '123' }])).toEqual({
      a: 'pin 123 here',
    });
    expect(redactToolArgs('browser_type', { text: '123', sensitive: true }).args).toEqual({
      text: '«redacted:3 chars»',
      sensitive: true,
    });
  });

  it.each(['true', 'TRUE', '1', 'yes', 1])(
    'a coerced sensitive flag (%j) still redacts the tool_call args',
    (flag) => {
      const { steps, emit } = harness();
      emit({
        type: 'tool_call',
        payload: {
          toolCallId: 'c1',
          toolName: 'browser_type',
          args: { ref: 'e1', text: 'pw-9876', sensitive: flag },
        },
      });
      expect(JSON.stringify(steps)).not.toContain('pw-9876');
    },
  );

  it('short values (CVV / PIN) are removed structurally from later request steps', () => {
    const { steps, emit } = harness();
    const args = { ref: 'e7', text: '123', sensitive: true };
    emit({ type: 'tool_call', payload: { toolCallId: 'call_1', toolName: 'browser_type', args } });
    emit({
      type: 'request',
      payload: {
        messages: [
          // OpenAI chat: arguments as JSON text.
          {
            role: 'assistant',
            tool_calls: [{ id: 'call_1', function: { arguments: JSON.stringify(args) } }],
          },
          // Anthropic: input object.
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', input: args }] },
          // pi's validation failure echoes the raw arguments.
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: `Validation failed\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
          },
          // Unrelated text with the same digits stays intact.
          { role: 'user', content: '订单号 e123 共 123 件' },
        ],
      },
    });
    const request = JSON.stringify(steps[1]?.payload);
    expect(request).not.toMatch(/\\?"text\\?":\s*\\?"123\\?"/);
    expect(request).toContain('订单号 e123 共 123 件');
    expect(request).toContain('call_1');
  });

  it('identifiers are never scrubbed (call/result pairing survives an OTP-like id)', () => {
    const { steps, emit } = harness();
    emit({
      type: 'tool_call',
      payload: {
        toolCallId: 'c-482913',
        toolName: 'browser_type',
        args: { ref: 'e1', text: '482913', sensitive: true },
      },
    });
    emit({
      type: 'tool_result',
      payload: {
        toolCallId: 'c-482913',
        toolName: 'browser_type',
        ok: true,
        content: '已输入 482913',
      },
    });
    expect(steps[0]?.payload).toMatchObject({ toolCallId: 'c-482913' });
    expect(steps[1]?.payload).toMatchObject({
      toolCallId: 'c-482913',
      content: '已输入 «redacted»',
    });
  });

  it('registering a value rewrites the assistant step and earlier tool_call steps of the run', () => {
    const { steps, emit } = harness();
    // An earlier attempt (not flagged) and the model's own text, both written
    // before the value is known to be sensitive.
    emit({
      type: 'tool_call',
      payload: {
        toolCallId: 'a1',
        toolName: 'browser_type',
        args: { ref: 'e1', text: 'Secr3t!pw' },
      },
    });
    emit({
      type: 'tool_result',
      payload: {
        toolCallId: 'a1',
        toolName: 'browser_type',
        ok: false,
        content: '元素已变化',
        errorCode: 'BROWSER_REF_STALE',
      },
    });
    emit({ type: 'assistant', payload: { text: '我再输入一次 Secr3t!pw' } });
    emit({
      type: 'tool_call',
      payload: {
        toolCallId: 'a2',
        toolName: 'browser_type',
        args: { ref: 'e2', text: 'Secr3t!pw', sensitive: true },
      },
    });
    expect(JSON.stringify(steps)).not.toContain('Secr3t!pw');
    expect(steps[0]?.payload).toMatchObject({ toolCallId: 'a1' });
  });
});
