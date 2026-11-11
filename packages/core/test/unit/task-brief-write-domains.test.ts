import { describe, expect, it } from 'vitest';
import { buildTaskBriefSegment, type TaskBrief } from '../../src/dispatch/tasks.js';
import type { RenderMessageOptions } from '../../src/agent/context/conversation.js';

/** D123 W3: declared write domains reach the task brief (all engines share it). */

const options = {} as RenderMessageOptions;

function brief(writeDomains: string[] | null, writes = true): TaskBrief {
  return {
    task: { id: 'run_t' } as never,
    title: '前端',
    instruction: 'TASK',
    writes,
    writeDomains,
    sourceMessages: [],
    injects: [],
    continuesTaskId: null,
  };
}

describe('task brief write domains (D123)', () => {
  it('names the declared domain and the command-enforcement caveat', () => {
    const text = buildTaskBriefSegment(brief(['apps/**']), options, '/proj');
    expect(text).toContain('本任务只应写入：apps/**');
    expect(text).toContain('域外写入会被拒绝');
    expect(text).toContain('命令写入不受写域强制，冲突由检查点兜底');
  });

  it('whole cwd and read-only briefs stay unchanged', () => {
    for (const domains of [null, ['**']]) {
      const text = buildTaskBriefSegment(brief(domains), options, '/proj');
      expect(text).not.toContain('本任务只应写入');
      expect(text).not.toContain('命令写入不受写域强制');
    }
    const readOnly = buildTaskBriefSegment(brief(null, false), options, '/proj');
    expect(readOnly).toContain('这是只读任务');
  });
});
