/**
 * 组件骨架模板（设计 32 §11.13）：经制作 loop 的 `widget_template` 工具写入草稿 `index.html`，
 * 把弱模型的工作从「从零写页面」降到「往骨架里填业务」。每个模板本身必须通过 S0 / S1
 * 全部规则（单测锁住），自带窄屏布局与 `kepcup` 调用的错误处理范式。
 *
 * P3a 只有 `blank`；`form-calculator` / `list-tracker` / `dashboard` 与主题变量、`kepcup-kit`
 * 在 P3b 补齐。
 */

export interface WidgetTemplate {
  name: string;
  /** 一句话：适合什么组件（模型据此挑选）。 */
  summary: string;
  html: string;
}

const BLANK = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>组件</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; font: 14px/1.5 system-ui, sans-serif; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
  button { padding: 6px 12px; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
  input, select, textarea { padding: 6px 8px; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; min-width: 0; }
  .muted { opacity: 0.7; }
  .error { color: #d33; }
</style>
</head>
<body>
<main id="app">
  <h3 id="title">标题</h3>
  <div class="row">
    <button type="button" id="action">操作</button>
  </div>
  <p id="status" class="muted"></p>
</main>
<script>
  // 页面状态：渲染只读 state，事件处理改 state 后调 render()。
  const state = { count: 0 };

  function render() {
    document.getElementById('status').textContent = '已点击 ' + state.count + ' 次';
  }

  // 宿主 API 都返回 Promise：一律 await，并把错误显示在页面上（error.message 是可直接展示的中文）。
  async function save() {
    try {
      await window.kepcup.storage.set('state', state);
    } catch (error) {
      showError(error);
    }
  }

  function showError(error) {
    const status = document.getElementById('status');
    status.textContent = (error && error.message) || '出错了';
    status.className = 'error';
  }

  document.getElementById('action').addEventListener('click', async () => {
    state.count += 1;
    render();
    await save();
  });

  async function init() {
    try {
      const saved = await window.kepcup.storage.get('state');
      if (saved && typeof saved.count === 'number') state.count = saved.count;
    } catch (error) {
      showError(error);
    }
    render();
  }

  init();
</script>
</body>
</html>
`;

export const WIDGET_TEMPLATES: readonly WidgetTemplate[] = [
  {
    name: 'blank',
    summary: '空白骨架：状态 + render() + 带错误处理的 kepcup.storage 读写，适合任何组件的起点',
    html: BLANK,
  },
];

export function widgetTemplate(name: string): WidgetTemplate | null {
  return WIDGET_TEMPLATES.find((template) => template.name === name) ?? null;
}
