/**
 * Admin console assets (task 5B): the embedded single-page triage UI served
 * same-origin from the Worker under /admin* — vanilla JS, zero dependencies,
 * zero build step (wrangler bundles these strings into the Worker as-is).
 *
 * Why embedded instead of a separate site / Astro: same-origin fetches need no
 * CORS and share the session cookie naturally, and a strict CSP stays trivial
 * (script/style both 'self') — see README「管理端 Web UI」.
 *
 * Security invariants (asserted by test/admin-ui.test.ts, keep them true):
 *   - ALL dynamic content is rendered with textContent/createTextNode; there is
 *     deliberately NO markup-injection sink anywhere in this file (report
 *     message text is untrusted input — the XSS lines are CSP + text-only DOM).
 *   - The assets never contain the admin token or any secret; they are safe to
 *     serve unauthenticated (auth happens per API call via the session cookie).
 *   - No inline event handlers in the HTML; JS attaches everything with
 *     addEventListener.
 *
 * The three exports are plain template literals. Keep the client JS free of
 * backticks and '${' so the literals need no escaping; use single quotes and
 * string concatenation inside it.
 */

export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KepCup 举报管理</title>
<link rel="stylesheet" href="/admin/app.css">
</head>
<body>
<section id="login-view" class="view" hidden>
  <form id="login-form" class="login-card">
    <h1>KepCup 举报管理</h1>
    <p class="muted">输入 Admin Token 登录（会话有效期 12 小时）。</p>
    <label for="login-token">Admin Token</label>
    <input id="login-token" name="token" type="password" autocomplete="current-password">
    <button id="login-btn" type="submit">登录</button>
    <p id="login-error" class="error" hidden></p>
  </form>
</section>
<main id="main-view" class="view" hidden>
  <header class="topbar">
    <h1>KepCup 举报管理</h1>
    <div class="actions">
      <button id="refresh-btn" type="button">刷新</button>
      <button id="logout-btn" type="button">登出</button>
    </div>
  </header>
  <section id="stats-row" class="stats-row" aria-label="统计"></section>
  <section class="filters">
    <label>状态
      <select id="filter-status">
        <option value="new">待处理（new）</option>
        <option value="triaged">已评估（triaged）</option>
        <option value="actioned">已处置（actioned）</option>
        <option value="dismissed">已忽略（dismissed）</option>
        <option value="all">全部（合并四种状态）</option>
      </select>
    </label>
    <label>Client ID <input id="filter-client" type="text" placeholder="精确过滤" spellcheck="false"></label>
    <label>每页 <input id="filter-limit" type="number" min="1" max="100" value="20"></label>
    <button id="filter-apply" type="button">应用筛选</button>
  </section>
  <p id="error-state" class="error" hidden></p>
  <p id="empty-state" class="muted" hidden>没有符合条件的举报。</p>
  <div class="table-wrap">
    <table id="report-table" hidden>
      <thead>
        <tr>
          <th>时间</th><th>状态</th><th>正文预览</th><th>Bot</th><th>模型</th>
          <th>平台 / 版本</th><th>来源</th><th>操作</th>
        </tr>
      </thead>
      <tbody id="report-tbody"></tbody>
    </table>
  </div>
  <nav class="pager">
    <button id="prev-btn" type="button" disabled>← 上一页</button>
    <button id="next-btn" type="button" disabled>下一页 →</button>
  </nav>
  <section id="detail-panel" hidden>
    <div class="detail-head">
      <h2 id="detail-title">举报详情</h2>
      <button id="detail-close" type="button">关闭</button>
    </div>
    <div id="detail-body"></div>
  </section>
  <section id="delete-zone" class="delete-zone">
    <h2>按 Client 删除（隐私删除）</h2>
    <p class="muted">输入完整 Client ID 启用删除按钮；点击后还有确认弹窗。将删除该 client 的全部举报与限流记录，不可撤销。</p>
    <div class="delete-row">
      <input id="delete-client-input" type="text" placeholder="client-…" spellcheck="false">
      <button id="delete-client-btn" type="button" disabled>删除该 Client</button>
    </div>
    <p id="delete-client-msg" class="muted" hidden></p>
  </section>
  <footer class="footer muted">reports.kepcup.com 内部管理工具 · 处置 API 与 CLI（scripts/report-triage.mjs）同源同权</footer>
</main>
<script src="/admin/app.js"></script>
</body>
</html>
`;

export const ADMIN_JS = `'use strict';
(function () {
  var STATUS_LIST = ['new', 'triaged', 'actioned', 'dismissed'];
  var STATUS_LABELS = { new: '待处理', triaged: '已评估', actioned: '已处置', dismissed: '已忽略' };
  var PREVIEW_CHARS = 80;

  var state = {
    status: 'new',
    client: '',
    limit: 20,
    cursor: null,
    nextCursor: null,
    history: [null],
    // 请求序号：列表 / 详情各一个，迟到的旧响应据此作废（筛选连点不串页）。
    seq: 0,
    detailSeq: 0,
  };

  function $(id) { return document.getElementById(id); }

  // DOM builder: every dynamic value goes through textContent / attributes —
  // report text is untrusted and must never become markup.
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'disabled') node.disabled = value === true;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) {
        if (children[i] !== null && children[i] !== undefined) node.appendChild(children[i]);
      }
    }
    return node;
  }

  function replaceChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------------------------------------------------------------- api

  function api(method, path, body) {
    var init = { method: method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (error) { data = null; }
        }
        // 会话过期/未登录：任何接口的 401 都回到登录视图。
        if (res.status === 401) showLogin();
        return { status: res.status, data: data };
      });
    });
  }

  function apiErrorMessage(result, fallback) {
    if (result.data && result.data.error) return String(result.data.error);
    return fallback;
  }

  // ---------------------------------------------------------------- misc

  function showLogin() {
    $('login-view').hidden = false;
    $('main-view').hidden = true;
  }

  function showMain() {
    $('login-view').hidden = true;
    $('main-view').hidden = false;
  }

  function showError(error) {
    var node = $('error-state');
    node.textContent = error && error.message ? error.message : String(error);
    node.hidden = false;
  }

  function hideError() { $('error-state').hidden = true; }

  function setBusy(busy) { document.body.classList.toggle('busy', busy === true); }

  function formatTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '-';
    var d = new Date(ms);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return (
      d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    );
  }

  function previewText(text, max) {
    if (!text) return '-';
    return text.length > max ? text.slice(0, max) + '…' : text;
  }

  function modelText(report) {
    if (report.modelProvider) return report.modelProvider + '/' + (report.modelId || '-');
    return report.modelId || '-';
  }

  function statusBadge(status) {
    return el('span', { class: 'badge badge-' + status, text: STATUS_LABELS[status] || status });
  }

  function flash(node, message) {
    node.textContent = message;
    node.hidden = false;
    window.setTimeout(function () { node.hidden = true; }, 3000);
  }

  // ---------------------------------------------------------------- stats

  function loadStats() {
    return api('GET', '/v1/admin/stats').then(function (result) {
      if (result.status !== 200) throw new Error(apiErrorMessage(result, '统计加载失败'));
      renderStats(result.data || {});
    });
  }

  function renderStats(data) {
    var row = $('stats-row');
    replaceChildren(row);
    var by = data.byStatus || {};
    var total = 0;
    STATUS_LIST.forEach(function (s) { total += by[s] || 0; });
    var cards = [['总计', total]];
    STATUS_LIST.forEach(function (s) { cards.push([STATUS_LABELS[s] + '（' + s + '）', by[s] || 0]); });
    cards.push(['近 7 天', data.last7Days || 0]);
    cards.forEach(function (card) {
      row.appendChild(el('div', { class: 'stat-card' }, [
        el('div', { class: 'stat-num', text: String(card[1]) }),
        el('div', { class: 'stat-label', text: card[0] }),
      ]));
    });
  }

  // ---------------------------------------------------------------- list

  function clampLimit() {
    var parsed = Number.parseInt($('filter-limit').value, 10);
    if (!isFinite(parsed)) parsed = 20;
    var limit = Math.min(100, Math.max(1, parsed));
    $('filter-limit').value = String(limit);
    return limit;
  }

  function listQuery(status, cursor) {
    var params = new URLSearchParams();
    params.set('status', status);
    if (state.client) params.set('client', state.client);
    params.set('limit', String(state.limit));
    if (cursor) params.set('before', cursor);
    return '/v1/admin/reports?' + params.toString();
  }

  function fetchPage(cursor) {
    if (state.status !== 'all') {
      return api('GET', listQuery(state.status, cursor)).then(function (result) {
        if (result.status !== 200) throw new Error(apiErrorMessage(result, '列表加载失败'));
        return { reports: result.data.reports || [], nextBefore: result.data.nextBefore || null };
      });
    }
    // 'all'：服务端只提供按状态过滤，这里并发四种状态后在浏览器合并排序。
    // 翻页用裸时间戳游标（received_at），跨状态稳定；毫秒级并列的边界行极罕见。
    var requests = STATUS_LIST.map(function (s) { return api('GET', listQuery(s, cursor)); });
    return Promise.all(requests).then(function (results) {
      var reports = [];
      var anyNext = false;
      results.forEach(function (result) {
        if (result.status !== 200) throw new Error(apiErrorMessage(result, '列表加载失败'));
        reports = reports.concat(result.data.reports || []);
        if (result.data.nextBefore) anyNext = true;
      });
      reports.sort(function (a, b) {
        if (b.receivedAt !== a.receivedAt) return b.receivedAt - a.receivedAt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
      var page = reports.slice(0, state.limit);
      var nextBefore = anyNext && page.length > 0 ? String(page[page.length - 1].receivedAt) : null;
      return { reports: page, nextBefore: nextBefore };
    });
  }

  function gotoPage(cursor) {
    var seq = ++state.seq;
    setBusy(true);
    hideError();
    return fetchPage(cursor)
      .then(function (page) {
        if (seq !== state.seq) return; // 已有更新的请求在途：本响应作废
        state.cursor = cursor;
        state.nextCursor = page.nextBefore;
        renderTable(page.reports);
        $('next-btn').disabled = !page.nextBefore;
        $('prev-btn').disabled = state.history.length <= 1;
      })
      .catch(function (error) {
        if (seq !== state.seq) return;
        showError(error);
      })
      .then(function () { setBusy(false); });
  }

  function renderTable(reports) {
    replaceChildren($('report-tbody'));
    $('report-table').hidden = reports.length === 0;
    $('empty-state').hidden = reports.length !== 0;
    reports.forEach(function (report) {
      var detailBtn = el('button', { type: 'button', class: 'link-btn', text: '详情' });
      detailBtn.addEventListener('click', function () { openDetail(report.id); });
      $('report-tbody').appendChild(el('tr', null, [
        el('td', { class: 'nowrap', text: formatTime(report.receivedAt) }),
        el('td', null, [statusBadge(report.status)]),
        el('td', { class: 'preview-cell', text: previewText(report.messagePreview, PREVIEW_CHARS) }),
        el('td', { text: report.botName || report.botId || '-' }),
        el('td', { text: modelText(report) }),
        el('td', { text: (report.platform || '-') + ' / ' + (report.appVersion || '-') }),
        el('td', { text: report.sourceKind || '-' }),
        el('td', null, [detailBtn]),
      ]));
    });
  }

  // ---------------------------------------------------------------- detail

  function openDetail(id) {
    var seq = ++state.detailSeq;
    setBusy(true);
    hideError();
    return api('GET', '/v1/admin/reports/' + encodeURIComponent(id))
      .then(function (result) {
        if (seq !== state.detailSeq) return; // 已有点开的详情更新：本响应作废
        if (result.status === 404) throw new Error('举报不存在（可能已删除或该 client 已被清空）');
        if (result.status !== 200) throw new Error(apiErrorMessage(result, '详情加载失败'));
        renderDetail(result.data.report);
        var panel = $('detail-panel');
        panel.hidden = false;
        panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      })
      .catch(function (error) {
        if (seq !== state.detailSeq) return;
        showError(error);
      })
      .then(function () { setBusy(false); });
  }

  function metaRow(grid, label, value) {
    grid.appendChild(el('div', { class: 'meta-label', text: label }));
    grid.appendChild(el('div', { class: 'meta-value', text: value }));
  }

  function kvTable(title, columns, rows) {
    var tbody = el('tbody');
    if (!rows || rows.length === 0) {
      tbody.appendChild(el('tr', null, [el('td', { class: 'muted', text: '（无记录）' })]));
    } else {
      rows.forEach(function (row) {
        tbody.appendChild(el('tr', null, columns.map(function (col) {
          var value = row ? row[col] : undefined;
          return el('td', { text: value === undefined || value === null ? '-' : String(value) });
        })));
      });
    }
    var head = columns.map(function (col) { return el('th', { text: col }); });
    var table = el('table', { class: 'kv-table' }, [el('thead', null, [el('tr', null, head)]), tbody]);
    return el('div', { class: 'kv-wrap' }, [el('h4', { text: title }), table]);
  }

  function renderDetail(report) {
    $('detail-title').textContent = '举报详情 — ' + report.id;
    var body = $('detail-body');
    replaceChildren(body);

    var meta = el('div', { class: 'meta-grid' });
    metaRow(meta, '状态', (STATUS_LABELS[report.status] || report.status) + '（' + report.status + '）');
    metaRow(meta, 'Client ID', report.clientId || '-');
    metaRow(meta, 'Bot', (report.botName || '-') + '（' + (report.botId || '-') + '）');
    metaRow(meta, '模型', modelText(report));
    metaRow(meta, '平台 / 版本', (report.platform || '-') + ' / ' + (report.appVersion || '-'));
    metaRow(meta, '来源', report.sourceKind || '-');
    metaRow(meta, '接收时间', formatTime(report.receivedAt));
    metaRow(meta, '更新时间', report.updatedAt ? formatTime(report.updatedAt) : '-');
    metaRow(meta, 'IP hash', report.ipHash || '-');
    metaRow(meta, 'content hash', report.contentHash || '-');
    metaRow(meta, 'payload hash', report.payloadHash || '-');
    body.appendChild(meta);

    body.appendChild(el('h3', { text: '正文（message.text）' }));
    body.appendChild(el('pre', { class: 'msg-text', text: report.messageText || '（空）' }));

    var payload = report.payload || {};
    body.appendChild(el('details', null, [
      el('summary', { text: 'payload_json（点击展开原始 JSON）' }),
      el('pre', { class: 'payload-json', text: JSON.stringify(report.payload, null, 2) }),
    ]));

    body.appendChild(el('h3', { text: 'usage / tools / providers' }));
    body.appendChild(el('div', { class: 'sum-tables' }, [
      kvTable('usage', ['provider', 'model', 'loopType', 'calls', 'inputTokens', 'outputTokens'], payload.usage),
      kvTable('tools', ['name', 'calls'], payload.tools),
      kvTable('providers', ['id', 'name', 'vendor', 'api'], payload.providers),
    ]));

    body.appendChild(el('h3', { text: '处置' }));
    var noteArea = el('textarea', { id: 'detail-note', rows: '3', placeholder: '备注（写明动作便于审计；清空保存即清除备注）' });
    noteArea.value = report.note || '';
    body.appendChild(el('div', { class: 'note-row' }, [
      el('label', { class: 'note-label', text: '备注' }),
      noteArea,
    ]));

    var msg = el('span', { id: 'detail-msg', class: 'muted' });
    var selected = report.status;
    var buttons = [];
    var buttonRow = el('div', { class: 'detail-actions' });
    STATUS_LIST.forEach(function (status) {
      var btn = el('button', {
        type: 'button',
        class: 'status-btn' + (status === selected ? ' active' : ''),
        text: (status === report.status ? '当前：' : '标记为') + (STATUS_LABELS[status] || status),
      });
      if (status === 'new') {
        btn.disabled = true;
        btn.title = 'new 是系统初始态，不可手工设置';
      } else {
        btn.addEventListener('click', function () {
          selected = status;
          saveBtn.disabled = false;
          saveBtn.title = '';
          buttons.forEach(function (other) { other.classList.toggle('active', other === btn); });
        });
      }
      buttons.push(btn);
      buttonRow.appendChild(btn);
    });
    var saveBtn = el('button', { type: 'button', class: 'status-btn primary', text: '保存处置' });
    // PATCH 必须带可设置的状态：当前是 new（未选择处置）时先禁用保存，避免必 400 的请求。
    saveBtn.disabled = selected === 'new';
    saveBtn.title = selected === 'new' ? '先选择一个处置状态（new 为系统初始态，不可手工设置）' : '';
    saveBtn.addEventListener('click', function () { saveDetail(report.id, selected, noteArea.value); });
    buttonRow.appendChild(saveBtn);
    var copyBtn = el('button', { type: 'button', class: 'status-btn', text: '复制 payload JSON' });
    copyBtn.addEventListener('click', function () {
      navigator.clipboard.writeText(JSON.stringify(report.payload, null, 2)).then(
        function () { flash(msg, '已复制 payload JSON'); },
        function () { flash(msg, '复制失败：浏览器拒绝剪贴板访问'); },
      );
    });
    buttonRow.appendChild(copyBtn);
    body.appendChild(buttonRow);
    body.appendChild(msg);
  }

  var saving = false;

  function saveDetail(id, status, noteText) {
    if (saving) return; // 双击防抖：保存请求在途时忽略再次点击
    saving = true;
    var patch = { status: status, note: noteText === '' ? null : noteText };
    setBusy(true);
    api('PATCH', '/v1/admin/reports/' + encodeURIComponent(id), patch)
      .then(function (result) {
        if (result.status !== 200) throw new Error(apiErrorMessage(result, '保存失败'));
        loadStats().catch(function () {});
        gotoPage(state.cursor);
        openDetail(id);
      })
      .catch(showError)
      .then(function () { saving = false; setBusy(false); });
  }

  // ---------------------------------------------------------------- delete zone

  function looksLikeClientId(value) {
    return value.length >= 6 && !/\\s/.test(value);
  }

  function setupDeleteZone() {
    var input = $('delete-client-input');
    var btn = $('delete-client-btn');
    var msg = $('delete-client-msg');
    var deleting = false;
    input.addEventListener('input', function () {
      // 双重确认之一：输入完整形似 id（无空白、至少 6 位）才能点删除。
      btn.disabled = !looksLikeClientId(input.value.trim());
    });
    btn.addEventListener('click', function () {
      var clientId = input.value.trim();
      if (!looksLikeClientId(clientId)) return;
      // 双重确认之二：confirm 弹窗文案携带 clientId。
      var confirmed = window.confirm(
        '即将删除 client「' + clientId + '」的全部举报与限流记录。\\n此操作不可撤销，确定继续？',
      );
      if (!confirmed) return;
      if (deleting) return; // 双击防抖：删除请求在途时忽略再次确认
      deleting = true;
      setBusy(true);
      api('DELETE', '/v1/admin/clients/' + encodeURIComponent(clientId))
        .then(function (result) {
          if (result.status !== 200) throw new Error(apiErrorMessage(result, '删除失败'));
          msg.textContent = '已删除 ' + result.data.reports + ' 条举报、' + result.data.rateRows + ' 条限流记录。';
          msg.hidden = false;
          input.value = '';
          btn.disabled = true;
          loadStats().catch(function () {});
          gotoPage(null);
        })
        .catch(function (error) {
          msg.textContent = error && error.message ? error.message : '删除失败';
          msg.hidden = false;
        })
        .then(function () { deleting = false; setBusy(false); });
    });
  }

  // ---------------------------------------------------------------- wiring

  function applyFilters() {
    state.status = $('filter-status').value;
    state.client = $('filter-client').value.trim();
    state.limit = clampLimit();
    state.history = [null];
    gotoPage(null);
  }

  function boot() {
    // 用 stats 探测会话：200 -> 直接进主视图；401 -> 登录视图。
    api('GET', '/v1/admin/stats').then(function (result) {
      if (result.status === 200) {
        renderStats(result.data || {});
        showMain();
        gotoPage(null);
      } else {
        showLogin();
      }
    }).catch(function () { showLogin(); });
  }

  function setup() {
    $('login-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var btn = $('login-btn');
      var errorNode = $('login-error');
      btn.disabled = true;
      errorNode.hidden = true;
      api('POST', '/admin/session', { token: $('login-token').value })
        .then(function (result) {
          btn.disabled = false;
          if (result.status !== 200) {
            errorNode.textContent = result.status === 401 ? 'Token 不正确。' : '登录失败（HTTP ' + result.status + '）。';
            errorNode.hidden = false;
            return;
          }
          $('login-token').value = '';
          showMain();
          state.history = [null];
          loadStats().catch(showError);
          gotoPage(null);
        })
        .catch(function () {
          btn.disabled = false;
          errorNode.textContent = '网络错误，请重试。';
          errorNode.hidden = false;
        });
    });
    $('logout-btn').addEventListener('click', function () {
      // 无论请求成败都回登录视图（本地登出），也不留未处理 rejection。
      api('DELETE', '/admin/session').then(showLogin, showLogin);
    });
    $('refresh-btn').addEventListener('click', function () {
      loadStats().catch(showError);
      gotoPage(state.cursor);
    });
    $('filter-apply').addEventListener('click', applyFilters);
    $('filter-client').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') applyFilters();
    });
    $('next-btn').addEventListener('click', function () {
      if (!state.nextCursor) return;
      state.history.push(state.nextCursor);
      gotoPage(state.nextCursor);
    });
    $('prev-btn').addEventListener('click', function () {
      if (state.history.length <= 1) return;
      state.history.pop();
      gotoPage(state.history[state.history.length - 1]);
    });
    $('detail-close').addEventListener('click', function () {
      $('detail-panel').hidden = true;
    });
    setupDeleteZone();
    boot();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setup);
  } else {
    setup();
  }
})();
`;

export const ADMIN_CSS = `/* reports.kepcup.com 管理端（任务 5B）：同源静态样式，系统字体栈，暗色友好。 */
:root { color-scheme: light dark; }

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1f2328;
  background: #f6f8fa;
}

body.busy { cursor: progress; }

button {
  font: inherit;
  padding: 4px 12px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #f6f8fa;
  color: inherit;
  cursor: pointer;
}
button:hover:not(:disabled) { background: #eaeef2; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
button.primary:hover:not(:disabled) { background: #1a5ed1; }
button.link-btn { border: none; background: none; color: #0969da; padding: 2px 4px; }

input, select, textarea {
  font: inherit;
  padding: 4px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
  color: inherit;
}

.muted { color: #6a737d; }
.error { color: #cf222e; margin: 8px 0; }
.nowrap { white-space: nowrap; }

.view[hidden] { display: none !important; }

#login-view { display: flex; justify-content: center; padding-top: 12vh; }
.login-card {
  width: min(360px, 90vw);
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.login-card h1 { font-size: 18px; margin: 0; }

#main-view { max-width: 1080px; margin: 0 auto; padding: 16px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.topbar h1 { font-size: 18px; margin: 0; }
.topbar .actions { display: flex; gap: 8px; }

.stats-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
.stat-card {
  min-width: 110px;
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 10px 14px;
}
.stat-num { font-size: 22px; font-weight: 600; }
.stat-label { color: #6a737d; font-size: 12px; }

.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0; }
.filters label { display: flex; align-items: center; gap: 6px; color: #6a737d; }

.table-wrap { overflow-x: auto; }
table#report-table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d0d7de; }
#report-table th, #report-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eaeef2; vertical-align: top; }
#report-table th { color: #6a737d; font-weight: 500; white-space: nowrap; }
.preview-cell { max-width: 360px; overflow-wrap: anywhere; }

.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; white-space: nowrap; }
.badge-new { background: #ddf4ff; color: #0969da; }
.badge-triaged { background: #fff8c5; color: #9a6700; }
.badge-actioned { background: #dafbe1; color: #1a7f37; }
.badge-dismissed { background: #eaeef2; color: #57606a; }

.pager { display: flex; gap: 8px; margin: 12px 0; }

#detail-panel {
  background: #fff;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  padding: 16px;
  margin: 12px 0;
}
.detail-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.detail-head h2 { font-size: 16px; margin: 0; overflow-wrap: anywhere; }
.meta-grid { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; margin: 12px 0; }
.meta-label { color: #6a737d; }
.meta-value { overflow-wrap: anywhere; }
#detail-body h3 { font-size: 14px; margin: 16px 0 8px; }
.msg-text, .payload-json {
  background: #f6f8fa;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 480px;
  overflow: auto;
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
details { margin: 10px 0; }
summary { cursor: pointer; color: #0969da; }
.sum-tables { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
.kv-wrap h4 { margin: 0 0 6px; }
.kv-table { border-collapse: collapse; }
.kv-table th, .kv-table td { border: 1px solid #d0d7de; padding: 4px 8px; font-size: 12.5px; text-align: left; }
.note-row { display: flex; gap: 8px; align-items: flex-start; margin: 10px 0; }
.note-label { color: #6a737d; padding-top: 6px; }
.note-row textarea { flex: 1; }
.detail-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; align-items: center; }
.status-btn.active { border-color: #1f6feb; color: #1f6feb; font-weight: 600; }

.delete-zone {
  background: #fff;
  border: 1px solid #d0d7de;
  border-left: 4px solid #cf222e;
  border-radius: 8px;
  padding: 16px;
  margin: 12px 0;
}
.delete-zone h2 { font-size: 15px; margin: 0 0 6px; color: #cf222e; }
.delete-row { display: flex; gap: 8px; flex-wrap: wrap; }
.delete-row input { flex: 1; min-width: 220px; max-width: 420px; }
#delete-client-btn:not(:disabled) { background: #cf222e; border-color: #cf222e; color: #fff; }

.footer { margin: 24px 0 8px; text-align: center; }

@media (prefers-color-scheme: dark) {
  body { color: #e6edf3; background: #0d1117; }
  button { background: #21262d; border-color: #30363d; }
  button:hover:not(:disabled) { background: #30363d; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  button.link-btn { color: #58a6ff; }
  input, select, textarea { background: #0d1117; border-color: #30363d; }
  .login-card, .stat-card, #detail-panel, .delete-zone, table#report-table { background: #161b22; border-color: #30363d; }
  #report-table th, #report-table td { border-bottom-color: #21262d; }
  .muted, .filters label, .stat-label, .meta-label, .note-label { color: #8b949e; }
  .msg-text, .payload-json { background: #0d1117; border-color: #30363d; }
  .badge-new { background: #121d2f; color: #58a6ff; }
  .badge-triaged { background: #272115; color: #d29922; }
  .badge-actioned { background: #12261e; color: #3fb950; }
  .badge-dismissed { background: #21262d; color: #8b949e; }
  .error, .delete-zone h2 { color: #f85149; }
  #delete-client-btn:not(:disabled) { background: #da3633; border-color: #da3633; color: #fff; }
}
`;
