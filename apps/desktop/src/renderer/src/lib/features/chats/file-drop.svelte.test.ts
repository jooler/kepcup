import { describe, expect, it, vi } from 'vitest';
import { createFileDropZone, dragCarriesFiles, type FileDropZone } from './file-drop.svelte';

/**
 * 父视图级文件拖拽附加（file-drop.svelte.ts）：事件判定与门禁让位逻辑。
 * 测试环境没有 DOM——用普通对象冒充 DragEvent，handler 内部只依赖鸭子类型
 * 探测（dataTransfer / contains），不需要浏览器全局。
 */

function fakeDragEvent(init: {
  types?: string[];
  files?: Array<{ name: string }>;
  defaultPrevented?: boolean;
  currentTarget?: { contains(node: unknown): boolean } | null;
  relatedTarget?: unknown;
}): DragEvent {
  let prevented = init.defaultPrevented === true;
  return {
    dataTransfer: {
      types: init.types ?? [],
      files: (init.files ?? []) as unknown as FileList,
    },
    defaultPrevented: prevented,
    currentTarget: init.currentTarget ?? null,
    relatedTarget: init.relatedTarget ?? null,
    preventDefault: () => {
      prevented = true;
    },
    get isDefaultPrevented(): boolean {
      return prevented;
    },
  } as unknown as DragEvent;
}

function wasPrevented(event: DragEvent): boolean {
  return (event as unknown as { isDefaultPrevented: boolean }).isDefaultPrevented;
}

function setupZone(input: {
  enabled?: () => boolean;
  onFiles?: (files: FileList) => void;
}): { zone: FileDropZone; files: Array<{ name: string }>; stop(): void } {
  const files: Array<{ name: string }> = [];
  let zone: FileDropZone | undefined;
  // $effect.root 返回清理函数（不是回调返回值）：zone 用闭包接出来。
  const stop = $effect.root(() => {
    zone = createFileDropZone({
      enabled: input.enabled ?? (() => true),
      onFiles: (list) => {
        files.push(...(Array.from(list) as Array<{ name: string }>));
      },
    });
  });
  if (zone === undefined) throw new Error('unreachable');
  return { zone, files, stop };
}

describe('dragCarriesFiles', () => {
  it('types 含 Files 才算文件拖拽（看板卡片等内部拖拽不算）', () => {
    expect(dragCarriesFiles(fakeDragEvent({ types: ['Files'] }))).toBe(true);
    expect(dragCarriesFiles(fakeDragEvent({ types: ['text/plain', 'application/x-card'] }))).toBe(
      false,
    );
    expect(dragCarriesFiles(fakeDragEvent({}))).toBe(false);
  });
});

describe('createFileDropZone', () => {
  it('dragover 命中文件时点亮 dragActive 并拦默认行为', () => {
    const { zone, stop } = setupZone({});
    const event = fakeDragEvent({ types: ['Files'] });
    zone.onDragOver(event);
    expect(zone.dragActive).toBe(true);
    expect(wasPrevented(event)).toBe(true);
    stop();
  });

  it('非文件拖拽（内部卡片拖拽）不点亮也不拦默认行为', () => {
    const { zone, stop } = setupZone({});
    const event = fakeDragEvent({ types: ['application/x-card'] });
    zone.onDragOver(event);
    expect(zone.dragActive).toBe(false);
    expect(wasPrevented(event)).toBe(false);
    stop();
  });

  it('门禁关闭（只读 / 终态任务）不点亮提示；drop 不上传但仍拦默认行为', () => {
    const { zone, files, stop } = setupZone({ enabled: () => false });
    const over = fakeDragEvent({ types: ['Files'] });
    zone.onDragOver(over);
    expect(zone.dragActive).toBe(false);
    expect(wasPrevented(over)).toBe(true);

    const drop = fakeDragEvent({ types: ['Files'], files: [{ name: 'a.png' }] });
    zone.onDrop(drop);
    expect(files).toEqual([]);
    expect(wasPrevented(drop)).toBe(true);
    stop();
  });

  it('drop 命中文件时交给 onFiles 并收起提示', () => {
    const { zone, files, stop } = setupZone({});
    zone.onDragOver(fakeDragEvent({ types: ['Files'] }));
    expect(zone.dragActive).toBe(true);
    zone.onDrop(fakeDragEvent({ types: ['Files'], files: [{ name: 'a.png' }, { name: 'b.pdf' }] }));
    expect(files.map((file) => file.name)).toEqual(['a.png', 'b.pdf']);
    expect(zone.dragActive).toBe(false);
    stop();
  });

  it('输入坞药丸已处理的 drop（defaultPrevented）父视图让位不上传', () => {
    const { zone, files, stop } = setupZone({});
    zone.onDrop(
      fakeDragEvent({ types: ['Files'], files: [{ name: 'a.png' }], defaultPrevented: true }),
    );
    expect(files).toEqual([]);
    stop();
  });

  it('非文件 drop 不上传、不拦默认行为（保持文本拖放的默认语义）', () => {
    const { zone, files, stop } = setupZone({});
    const event = fakeDragEvent({ types: ['text/plain'] });
    zone.onDrop(event);
    expect(files).toEqual([]);
    expect(wasPrevented(event)).toBe(false);
    stop();
  });

  it('dragleave 在根元素内部子元素间移动不收起，离开根元素（relatedTarget 出根 / null）才收起', () => {
    const insideChild = { id: 'child' };
    const root = {
      contains: (node: unknown) => node === insideChild,
    };
    const { zone, stop } = setupZone({});
    zone.onDragOver(fakeDragEvent({ types: ['Files'] }));
    expect(zone.dragActive).toBe(true);

    // 消息列表 → 输入坞（都在根内）：提示保持。
    zone.onDragLeave(
      fakeDragEvent({
        types: ['Files'],
        currentTarget: root,
        relatedTarget: insideChild,
      }),
    );
    expect(zone.dragActive).toBe(true);

    // 离开窗口（relatedTarget null）或移进 portal 浮层（不在根内）：收起。
    zone.onDragLeave(fakeDragEvent({ types: ['Files'], currentTarget: root }));
    expect(zone.dragActive).toBe(false);

    zone.onDragOver(fakeDragEvent({ types: ['Files'] }));
    zone.onDragLeave(
      fakeDragEvent({ types: ['Files'], currentTarget: root, relatedTarget: { id: 'portal' } }),
    );
    expect(zone.dragActive).toBe(false);
    stop();
  });

  it('dragover 心跳停止（拖拽被取消）后提示超时自动收起', () => {
    vi.useFakeTimers();
    try {
      const { zone, stop } = setupZone({});
      zone.onDragOver(fakeDragEvent({ types: ['Files'] }));
      expect(zone.dragActive).toBe(true);
      // 心跳续拍：持续 dragover 期间提示保持。
      vi.advanceTimersByTime(500);
      zone.onDragOver(fakeDragEvent({ types: ['Files'] }));
      vi.advanceTimersByTime(500);
      expect(zone.dragActive).toBe(true);
      // 心跳停止（拖拽取消 / 光标进了不冒泡的浮层）：超时收起。
      vi.advanceTimersByTime(200);
      expect(zone.dragActive).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
