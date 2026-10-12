/**
 * 组件骨架模板（设计 32 §11.13）：经制作 loop 的 `widget_template` 工具写入草稿 `index.html`，
 * 把弱模型的工作从「从零写页面」降到「往骨架里填业务」。每个模板本身必须通过 S0 / S1
 * 全部规则（单测锁住），自带窄屏布局与 `kepcup` 调用的错误处理范式。
 *
 * 全部模板都带 `<meta name="kepcup-kit" content="1">`：基础样式跟随宿主主题变量（`--kc-*`），
 * 图表与数字格式化用 `kepcup.ui`（设计 32 §11.13）。
 */

import { DASHBOARD_QUERIES_EXAMPLE, DASHBOARD_TEMPLATE } from './dashboard.js';
import { FORM_CALCULATOR_TEMPLATE } from './form-calculator.js';
import { LIST_TRACKER_TEMPLATE } from './list-tracker.js';

export interface WidgetTemplate {
  name: string;
  /** 一句话：适合什么组件（模型据此挑选）。 */
  summary: string;
  html: string;
  /** 配套的查询模板示例（写入草稿 queries.json，草稿里还没有时）。 */
  queries?: ReadonlyArray<{ name: string; sql: string }>;
}

const BLANK = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>组件</title>
</head>
<body>
<main id="app">
  <h3 id="title">标题</h3>
  <div class="kc-row">
    <button type="button" id="action" class="primary">操作</button>
  </div>
  <p id="status" class="kc-muted"></p>
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
    status.className = 'kc-error';
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
  {
    name: 'form-calculator',
    summary: '表单计算器：几个输入框 → 实时结果（数字防 NaN、输入防抖保存）',
    html: FORM_CALCULATOR_TEMPLATE,
  },
  {
    name: 'list-tracker',
    summary: '列表追踪：增 / 勾选 / 删条目（页内二次确认删除），整表存 storage',
    html: LIST_TRACKER_TEMPLATE,
  },
  {
    name: 'dashboard',
    summary: '数据看板：命名查询 → 指标卡 + kepcup.ui 柱状图 + 表格（会附带 queries.json 示例）',
    html: DASHBOARD_TEMPLATE,
    queries: DASHBOARD_QUERIES_EXAMPLE,
  },
];

export function widgetTemplate(name: string): WidgetTemplate | null {
  return WIDGET_TEMPLATES.find((template) => template.name === name) ?? null;
}
