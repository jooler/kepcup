/**
 * 数据看板骨架：一条命名查询（queries.json 里声明）→ 指标 + 柱状图 + 表格。图表用 kit 的
 * `kepcup.ui.bar`（纯 SVG），不手画 canvas。
 */
export const DASHBOARD_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>看板</title>
<style>
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
  .kpi .value { font-size: 22px; font-weight: 600; }
  .table-wrap { overflow-x: auto; margin-top: 12px; }
</style>
</head>
<body>
<main id="app">
  <h3 id="title">看板</h3>
  <div class="kpis">
    <div class="kc-card kpi"><div class="kc-muted">合计</div><div class="value" id="total">—</div></div>
    <div class="kc-card kpi"><div class="kc-muted">条目</div><div class="value" id="count">—</div></div>
  </div>
  <div id="chart" style="margin-top:12px"></div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>名称</th><th>数值</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
  <div class="kc-row"><button type="button" id="refresh">刷新</button></div>
  <p id="status" class="kc-muted"></p>
</main>
<script>
  // 查询名要与 queries.json 里声明的一致；这里假设它返回 label / value 两列。
  const QUERY = 'summary';

  function showStatus(text, isError) {
    const status = document.getElementById('status');
    status.textContent = text;
    status.className = isError ? 'kc-error' : 'kc-muted';
  }

  function render(rows) {
    const data = rows.map((row) => ({ label: String(row.label ?? ''), value: Number(row.value) || 0 }));
    const total = data.reduce((sum, row) => sum + row.value, 0);
    document.getElementById('total').textContent = window.kepcup.ui.format(total);
    document.getElementById('count').textContent = String(data.length);
    window.kepcup.ui.bar('#chart', data, { empty: '暂无数据' });
    const body = document.getElementById('rows');
    body.textContent = '';
    for (const row of data) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = row.label;
      const value = document.createElement('td');
      value.textContent = window.kepcup.ui.format(row.value);
      tr.append(name, value);
      body.appendChild(tr);
    }
  }

  async function load() {
    showStatus('加载中…', false);
    try {
      const result = await window.kepcup.query(QUERY, {});
      render(result.rows);
      showStatus(result.truncated ? '数据较多，只显示了前一部分' : '', false);
    } catch (error) {
      render([]);
      showStatus((error && error.message) || '查询失败', true);
    }
  }

  document.getElementById('refresh').addEventListener('click', load);
  load();
</script>
</body>
</html>
`;

/** 看板骨架配套的查询模板示例（BUILD 照着改；只能读 widget_kv / conversation_messages）。 */
export const DASHBOARD_QUERIES_EXAMPLE = [
  {
    name: 'summary',
    sql: "select key as label, json_extract(value_json, '$.amount') as value from widget_kv order by key",
  },
];
