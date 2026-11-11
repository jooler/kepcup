import { describe, expect, it } from 'vitest';
import { buildTaskBriefSegment, type TaskBrief } from '../../src/dispatch/tasks.js';
import type { RenderMessageOptions } from '../../src/agent/context/conversation.js';

/** D123 W3: declared write domains reach the task brief (all engines share it). */

const options = {} as RenderMessageOptions;

function brief(writeDomains: string[] | null, writes = true, title = '前端'): TaskBrief {
  return {
    task: { id: 'run_t' } as never,
    title,
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

/**
 * D123 ①: the header's `writes` attribute used to say `true` for every writer,
 * so a scoped task could not read its own domain (and misread its queue reason).
 */
describe('task brief writes attribute (D123 ①)', () => {
  const header = (writeDomains: string[] | null, writes = true): string =>
    buildTaskBriefSegment(brief(writeDomains, writes), options, '/proj').split('\n')[0]!;

  it('says true only for whole-cwd writes', () => {
    expect(header(null)).toContain('writes="true"');
    expect(header(['**'])).toContain('writes="true"');
  });

  it('lists a single declared glob', () => {
    expect(header(['tmp/parallel-test/multi/a.txt'])).toContain(
      'writes="tmp/parallel-test/multi/a.txt"',
    );
    expect(header(['apps/**'])).not.toContain('writes="true"');
  });

  it('lists several globs, comma separated, on one line', () => {
    const line = header(['apps/**', 'packages/core/**']);
    expect(line).toContain('writes="apps/**, packages/core/**"');
    expect(line).not.toContain('\n');
  });

  it('says false for a read-only task even if a domain slipped into the brief', () => {
    expect(header(['apps/**'], false)).toContain('writes="false"');
  });

  it('keeps quotes/angle brackets/newlines out of the attribute', () => {
    const line = header(['apps/"<引号>/**', 'x\ny/**']);
    const attr = line.slice(line.indexOf('writes="') + 'writes="'.length);
    const value = attr.slice(0, attr.indexOf('"'));
    expect(value).not.toContain('<');
    expect(value).not.toContain('>');
    expect(value).not.toContain('\n');
    expect(value).toContain('apps/');
  });
});

describe('task brief header attributes (D123 ① review)', () => {
  const headerValue = (line: string, name: string): string => {
    const at = line.indexOf(`${name}="`);
    if (at < 0) return '';
    const rest = line.slice(at + name.length + 2);
    return rest.slice(0, rest.indexOf('"'));
  };

  it('keeps a model-chosen title from breaking out of its attribute', () => {
    const line = buildTaskBriefSegment(
      brief(['apps/**'], true, '前"端<注入>\n第二行'),
      options,
      '/proj',
    ).split('\n')[0]!;
    expect(headerValue(line, 'title')).toBe('前 端 注入 第二行');
    // The tag opens and closes exactly once, on one line.
    expect(line).toBe(
      '<task_brief task_id="run_t" title="前 端 注入 第二行" writes="apps/**" cwd="/proj">',
    );
  });

  it('escapes a cwd that contains quotes or angle brackets', () => {
    const line = buildTaskBriefSegment(brief(['apps/**']), options, '/proj"<x>').split('\n')[0]!;
    expect(headerValue(line, 'cwd')).toBe('/proj x');
    expect(line.endsWith('>')).toBe(true);
  });

  it('never renders an empty writes="" — an empty domain list is not writable', () => {
    const text = buildTaskBriefSegment(brief([]), options, '/proj');
    const line = text.split('\n')[0]!;
    expect(line).toContain('writes="false"');
    expect(line).not.toContain('writes=""');
    expect(text).not.toContain('本任务只应写入：');
  });
});
