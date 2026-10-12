/**
 * 全局弹层拖拽带（app.css「window-drag-band」块）：
 *
 * 浮层要能点击必须整体 no-drag 并且排在内容 drag 区之后（app.css 的
 * app-region 规则）；全屏浮层（对话框遮罩/灯箱/引导向导）因此把窗口顶部
 * 的 drag 区全部压平——浮层一开，窗口就拖不动。
 *
 * 这里在 body 末尾常驻一条隐藏的顶部拖拽带：存在 `[data-window-overlay]`
 * （全屏浮层的统一标记）时激活为窗口顶部 40px 的 drag 矩形。app-region
 * 矩形按 DOM 顺序后者胜出，所以带必须始终是 body 的最后一个子节点——用
 * MutationObserver 在 portal 插入后重新沉底，并同步激活态。
 *
 * 性能：不再「任何 DOM 变更 → 下一帧 document.querySelector 全树扫描」（流式消息时每帧都
 * 在扫整棵树）。MutationObserver 的记录里只看**增删的节点**：节点自身或其子树里命中
 * 标记才计入活跃浮层集合（OverlayTracker），与浮层无关的变更（消息流式渲染）只做
 * O(新增节点) 的匹配、不触发 rAF、不扫全树。浮层可能挂在 portal 容器里，也可能就地渲染在
 * 应用树内（引导向导、灯箱），所以仍要观察整棵子树的 childList。
 *
 * 有意为之的代价：浮层打开期间顶部 40px 只能拖窗口、不能点击，浮层自己的
 * 交互内容须避开这一条（bits-ui 弹框垂直居中天然满足；灯箱顶栏因此下移）。
 * 新增全屏浮层时给根元素加 data-window-overlay 即接入，不要逐组件往遮罩里
 * 塞拖拽条；局部 popover（「+」面板、右键菜单）不算——它们的顶部正是
 * 可交互内容，接进来反而被带挡住。
 */

const OVERLAY_SELECTOR = '[data-window-overlay]';
const ACTIVE_CLASS = 'window-drag-band-active';

/** OverlayTracker 用到的节点最小面（单测用替身）。 */
export interface TrackedNode {
  nodeType: number;
  isConnected?: boolean;
  matches?(selector: string): boolean;
  querySelectorAll?(selector: string): Iterable<TrackedNode>;
}

export interface TrackedRecord {
  addedNodes: Iterable<TrackedNode>;
  removedNodes: Iterable<TrackedNode>;
}

const ELEMENT_NODE = 1;

/**
 * 活跃浮层集合：增量维护 `[data-window-overlay]` 元素，替代每帧全树 querySelector。
 */
export class OverlayTracker {
  readonly #live = new Set<TrackedNode>();
  readonly #selector: string;

  constructor(selector: string = OVERLAY_SELECTOR) {
    this.#selector = selector;
  }

  /** 命中节点自身与其子树里所有浮层标记元素。 */
  #collect(node: TrackedNode): TrackedNode[] {
    if (node.nodeType !== ELEMENT_NODE) return [];
    const found: TrackedNode[] = [];
    if (node.matches?.(this.#selector)) found.push(node);
    if (node.querySelectorAll)
      for (const inner of node.querySelectorAll(this.#selector)) found.push(inner);
    return found;
  }

  /** 初次挂载时对已有 DOM 扫一遍（仅一次）。 */
  scan(root: TrackedNode): void {
    for (const el of this.#collect(root)) this.#live.add(el);
  }

  /** 应用一条变更记录；返回活跃集合是否变化。 */
  apply(record: TrackedRecord): boolean {
    let changed = false;
    for (const node of record.removedNodes) {
      for (const el of this.#collect(node)) changed = this.#live.delete(el) || changed;
    }
    for (const node of record.addedNodes) {
      for (const el of this.#collect(node)) {
        if (!this.#live.has(el)) {
          this.#live.add(el);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** 是否存在仍在文档里的浮层（顺手剔除已脱离文档的残留，如同批次内先增后删）。 */
  get active(): boolean {
    for (const el of this.#live) {
      if (el.isConnected === false) this.#live.delete(el);
    }
    return this.#live.size > 0;
  }
}

export function mountWindowDragBand(): () => void {
  const band = document.createElement('div');
  band.className = 'window-drag-band';
  band.setAttribute('data-testid', 'window-drag-band');
  band.setAttribute('aria-hidden', 'true');
  document.body.append(band);

  const tracker = new OverlayTracker();
  tracker.scan(document.body);

  const sync = (): void => {
    // portal 到 body 末尾的浮层会排到带之后，重新沉底保住「最后子节点」。
    if (document.body.lastElementChild !== band) document.body.append(band);
    const active = tracker.active;
    band.classList.toggle(ACTIVE_CLASS, active);
    band.setAttribute('data-active', active ? 'true' : 'false');
  };

  // rAF 合并同帧内的多次变更；只有「浮层集合变化」或「body 的直接子节点变化（portal 插入）」
  // 才需要同步，其余变更（消息流式渲染）一概不处理。
  let frame = 0;
  const schedule = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };
  const observer = new MutationObserver((records) => {
    let dirty = false;
    for (const record of records) {
      if (record.target === document.body) dirty = true;
      if (tracker.apply(record)) dirty = true;
    }
    if (dirty) schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  sync();

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    band.remove();
  };
}
