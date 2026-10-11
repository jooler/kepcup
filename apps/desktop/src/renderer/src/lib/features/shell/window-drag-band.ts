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
 * 有意为之的代价：浮层打开期间顶部 40px 只能拖窗口、不能点击，浮层自己的
 * 交互内容须避开这一条（bits-ui 弹框垂直居中天然满足；灯箱顶栏因此下移）。
 * 新增全屏浮层时给根元素加 data-window-overlay 即接入，不要逐组件往遮罩里
 * 塞拖拽条；局部 popover（「+」面板、右键菜单）不算——它们的顶部正是
 * 可交互内容，接进来反而被带挡住。
 */

const OVERLAY_SELECTOR = '[data-window-overlay]';
const ACTIVE_CLASS = 'window-drag-band-active';

export function mountWindowDragBand(): () => void {
  const band = document.createElement('div');
  band.className = 'window-drag-band';
  band.setAttribute('data-testid', 'window-drag-band');
  band.setAttribute('aria-hidden', 'true');
  document.body.append(band);

  const sync = (): void => {
    // portal 到 body 末尾的浮层会排到带之后，重新沉底保住「最后子节点」。
    if (document.body.lastElementChild !== band) document.body.append(band);
    const active = document.querySelector(OVERLAY_SELECTOR) !== null;
    band.classList.toggle(ACTIVE_CLASS, active);
    band.setAttribute('data-active', active ? 'true' : 'false');
  };

  // subtree：浮层可能挂进早已存在的 portal 容器；rAF 合并高频 DOM 变更。
  let frame = 0;
  const schedule = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(sync);
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();

  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    band.remove();
  };
}
