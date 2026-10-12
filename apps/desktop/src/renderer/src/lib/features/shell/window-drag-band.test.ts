import { describe, expect, test } from 'vitest';
import { OverlayTracker, type TrackedNode } from './window-drag-band';

/** 极简节点替身：children 模拟子树，marked 表示自带 data-window-overlay。 */
interface FakeNode extends TrackedNode {
  connected: boolean;
  children: FakeNode[];
}

function node(options: { marked?: boolean; children?: FakeNode[]; text?: boolean } = {}): FakeNode {
  const el: FakeNode = {
    nodeType: options.text ? 3 : 1,
    connected: true,
    children: options.children ?? [],
    get isConnected() {
      return this.connected;
    },
    matches: () => options.marked === true,
    querySelectorAll(): FakeNode[] {
      const out: FakeNode[] = [];
      const walk = (list: FakeNode[]): void => {
        for (const child of list) {
          if (child.matches?.('')) out.push(child);
          walk(child.children);
        }
      };
      walk(this.children);
      return out;
    },
  };
  return el;
}

describe('OverlayTracker（浮层集合增量维护，替代每帧全树扫描）', () => {
  test('浮层作为新增节点（含嵌在新增子树里）被计入，移除后不再活跃', () => {
    const tracker = new OverlayTracker();
    const overlay = node({ marked: true });
    const wrapper = node({ children: [overlay] });
    expect(tracker.active).toBe(false);

    expect(tracker.apply({ addedNodes: [wrapper], removedNodes: [] })).toBe(true);
    expect(tracker.active).toBe(true);

    expect(tracker.apply({ addedNodes: [], removedNodes: [wrapper] })).toBe(true);
    expect(tracker.active).toBe(false);
  });

  test('与浮层无关的变更（消息流式渲染：普通元素 / 文本节点）不改变集合、返回 false', () => {
    const tracker = new OverlayTracker();
    const plain = node({ children: [node(), node()] });
    const text = node({ text: true });
    expect(tracker.apply({ addedNodes: [plain, text], removedNodes: [] })).toBe(false);
    expect(tracker.apply({ addedNodes: [], removedNodes: [plain, text] })).toBe(false);
    expect(tracker.active).toBe(false);
  });

  test('多个浮层叠开：关一个仍活跃，全关才不活跃', () => {
    const tracker = new OverlayTracker();
    const a = node({ marked: true });
    const b = node({ marked: true });
    tracker.apply({ addedNodes: [a, b], removedNodes: [] });
    tracker.apply({ addedNodes: [], removedNodes: [a] });
    expect(tracker.active).toBe(true);
    tracker.apply({ addedNodes: [], removedNodes: [b] });
    expect(tracker.active).toBe(false);
  });

  test('同一节点重复新增不重复计数；已脱离文档的残留在读取时剔除', () => {
    const tracker = new OverlayTracker();
    const overlay = node({ marked: true });
    expect(tracker.apply({ addedNodes: [overlay], removedNodes: [] })).toBe(true);
    expect(tracker.apply({ addedNodes: [overlay], removedNodes: [] })).toBe(false);
    overlay.connected = false;
    expect(tracker.active).toBe(false);
  });

  test('初次 scan 收录已存在的浮层', () => {
    const tracker = new OverlayTracker();
    tracker.scan(node({ children: [node({ marked: true })] }));
    expect(tracker.active).toBe(true);
  });
});
