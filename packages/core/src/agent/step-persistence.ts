import { redactStepPayload, stripImageBlocks } from '../infra/redact.js';
import type { RunsService } from '../domain/runs.js';
import type { SecretsService } from '../domain/secrets.js';
import type { RunHandle } from './types.js';

/**
 * 引擎事件 → run_steps 落库（「模型看到的一切都在日志里」，
 * docs/dev/03-data-model.md）。response loop（orchestrator）与 subagent 子
 * run（D66）共用同一条路径；差别只在是否把进度转发给 UI。
 */
export function persistEngineSteps(input: {
  runs: RunsService;
  secrets: SecretsService;
  runId: string;
  handle: RunHandle;
  /** Progress forwarding (run.progress events); omitted for quiet sub runs. */
  onProgress?: (progress: { toolName?: string; text?: string }) => void;
}): () => void {
  const { runs, secrets, runId, handle, onProgress } = input;
  return handle.onEvent((event) => {
    switch (event.type) {
      case 'request':
        runs.appendStep({
          runId,
          type: 'request',
          payload: redactStepPayload(
            (text) => secrets.redact(text),
            stripImageBlocks(event.payload),
          ),
        });
        return;
      case 'assistant':
        runs.appendStep({ runId, type: 'assistant', payload: event.payload });
        return;
      case 'tool_call':
        runs.appendStep({
          runId,
          type: 'tool_call',
          payload: redactStepPayload((text) => secrets.redact(text), event.payload),
        });
        if (onProgress !== undefined && event.payload.toolName.length > 0) {
          // External agents' human-readable title wins on the status line (D72 P5).
          // Agent titles are free text (often the command itself): redacted
          // like the persisted payload (P5 审查 #8).
          const title = event.payload.title;
          onProgress({
            toolName: event.payload.toolName,
            ...(title !== undefined && title.length > 0 ? { text: secrets.redact(title) } : {}),
          });
        }
        return;
      case 'tool_result':
        runs.appendStep({
          runId,
          type: 'tool_result',
          payload: {
            ...event.payload,
            content: secrets.redact(String(event.payload.content)),
          },
        });
        return;
      case 'progress': {
        // Progress text can quote agent titles / tool output: redacted (审查 #8).
        const text = secrets.redact(String(event.payload.text));
        runs.appendStep({ runId, type: 'progress', payload: { ...event.payload, text } });
        if (onProgress !== undefined && text.length > 0) onProgress({ text });
        return;
      }
      case 'steer':
        runs.appendStep({ runId, type: 'steer', payload: event.payload });
        return;
    }
  });
}
