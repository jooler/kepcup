import { describe, expect, test } from 'vitest';
import { BROWSER_SNAPSHOT_MAX_ELEMENTS, BROWSER_SNAPSHOT_MAX_TEXT_CHARS } from '@kepcup/shared';
import { buildSnapshotSummary, formatSnapshot, type AxtreeNode } from '@kepcup/shared';

function node(overrides: Partial<AxtreeNode> & { nodeId: string }): AxtreeNode {
  return {
    role: { value: 'generic' },
    ignored: false,
    ...overrides,
  };
}

let nextBackend = 100;
function interactive(nodeId: string, role: string, name: string, backend = ++nextBackend): AxtreeNode {
  return node({ nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId: backend });
}

function text(nodeId: string, value: string): AxtreeNode {
  return node({ nodeId, role: { value: 'StaticText' }, name: { value } });
}

describe('buildSnapshotSummary', () => {
  test('assigns sequential e-refs to interactive elements in document order', () => {
    const summary = buildSnapshotSummary(
      [
        text('t1', '标题文本'),
        interactive('a1', 'textbox', '搜索'),
        interactive('a2', 'button', '提交'),
        interactive('a3', 'link', '下一页'),
      ],
      { maxElements: 150, maxTextChars: 4000 },
    );
    expect(summary.elements.map((el) => el.ref)).toEqual(['e1', 'e2', 'e3']);
    expect(summary.elements.map((el) => el.role)).toEqual(['textbox', 'button', 'link']);
    expect(summary.refs.get('e2')).toBe(102); // second element → backend 102
    expect(summary.text).toContain('标题文本');
    expect(summary.elementsTruncated).toBe(false);
  });

  test('skips ignored nodes and non-interactive roles', () => {
    const summary = buildSnapshotSummary(
      [
        node({ nodeId: 'x1', ignored: true, role: { value: 'button' }, name: { value: 'hidden' } }),
        node({ nodeId: 'x2', role: { value: 'generic' }, name: { value: 'block' } }),
        interactive('a1', 'button', '唯一'),
      ],
      { maxElements: 150, maxTextChars: 4000 },
    );
    expect(summary.elements).toEqual([{ ref: 'e1', role: 'button', name: '唯一' }]);
    expect(summary.text).not.toContain('block');
  });

  test('caps the element list and reports truncation (calibrated: complex pages expose >1000 nodes)', () => {
    const many = Array.from({ length: 400 }, (_, i) => interactive(`a${i}`, 'link', `item ${i}`));
    const summary = buildSnapshotSummary(many, {
      maxElements: BROWSER_SNAPSHOT_MAX_ELEMENTS,
      maxTextChars: 4000,
    });
    expect(summary.elements).toHaveLength(BROWSER_SNAPSHOT_MAX_ELEMENTS);
    expect(summary.elements[0]?.ref).toBe('e1');
    expect(summary.elementsTruncated).toBe(true);
    // W1: the cap stays at 150; the note tells the model how many are left.
    expect(summary.elementsOmitted).toBe(400 - BROWSER_SNAPSHOT_MAX_ELEMENTS);
    const rendered = formatSnapshot(summary, { title: 't', url: 'http://x/' });
    expect(rendered).toContain(
      `还有 ${400 - BROWSER_SNAPSHOT_MAX_ELEMENTS} 个元素未列出，可 browser_scroll 或缩小范围`,
    );
  });

  test('caps page text and marks it truncated', () => {
    const summary = buildSnapshotSummary([text('t1', '字'.repeat(10_000))], {
      maxElements: 150,
      maxTextChars: BROWSER_SNAPSHOT_MAX_TEXT_CHARS,
    });
    expect(summary.text).toHaveLength(BROWSER_SNAPSHOT_MAX_TEXT_CHARS);
    expect(summary.textTruncated).toBe(true);
  });

  test('long element names are cut to keep the list compact', () => {
    const summary = buildSnapshotSummary([interactive('a1', 'link', '长'.repeat(300))], {
      maxElements: 150,
      maxTextChars: 4000,
      maxNameChars: 80,
    });
    expect(summary.elements[0]?.name).toHaveLength(81); // 80 + ellipsis
    expect(summary.elements[0]?.name?.endsWith('…')).toBe(true);
  });
});

describe('formatSnapshot', () => {
  test('renders title, url, elements and text', () => {
    const summary = buildSnapshotSummary(
      [text('t1', '正文'), interactive('a1', 'button', '提交')],
      { maxElements: 150, maxTextChars: 4000 },
    );
    const rendered = formatSnapshot(summary, { title: '示例页面', url: 'http://127.0.0.1:9/x' });
    expect(rendered).toContain('页面：示例页面');
    expect(rendered).toContain('URL：http://127.0.0.1:9/x');
    expect(rendered).toContain('- [e1] button “提交”');
    expect(rendered).toContain('正文');
  });

  test('notes truncation of elements and text', () => {
    const rendered = formatSnapshot(
      {
        elements: Array.from({ length: 150 }, (_, i) => ({
          ref: `e${i + 1}`,
          role: 'link',
          name: `n${i}`,
        })),
        elementsTruncated: true,
        text: 'x'.repeat(4000),
        textTruncated: true,
      },
      { title: '', url: 'http://x/' },
    );
    expect(rendered).toContain('已截断');
    expect(rendered).toContain('页面文本已截断');
    expect(rendered).toContain('（无标题）');
  });
});
