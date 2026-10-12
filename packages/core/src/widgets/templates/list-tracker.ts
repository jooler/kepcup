/** 列表追踪骨架：增 / 改（勾选）/ 删（页内确认，不用 confirm）条目，整表存 kepcup.storage。 */
export const LIST_TRACKER_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>清单</title>
<style>
  ul { list-style: none; padding: 0; margin: 8px 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--kc-border); }
  li .text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  li.done .text { text-decoration: line-through; color: var(--kc-muted); }
  #newItem { flex: 1; }
</style>
</head>
<body>
<main id="app">
  <h3 id="title">清单</h3>
  <div class="kc-row">
    <input id="newItem" type="text" placeholder="添加一项" maxlength="200">
    <button type="button" id="add" class="primary">添加</button>
  </div>
  <ul id="list"></ul>
  <p id="empty" class="kc-muted">还没有条目</p>
  <p id="status" class="kc-muted"></p>
</main>
<script>
  const state = { items: [], pendingDelete: null };

  function showStatus(text, isError) {
    const status = document.getElementById('status');
    status.textContent = text;
    status.className = isError ? 'kc-error' : 'kc-muted';
  }

  async function save() {
    try {
      await window.kepcup.storage.set('items', state.items);
    } catch (error) {
      showStatus((error && error.message) || '保存失败', true);
    }
  }

  // 每次都从 state 整体重画；文字一律用 textContent（不拼 HTML）。
  function render() {
    const list = document.getElementById('list');
    list.textContent = '';
    for (const item of state.items) {
      const li = document.createElement('li');
      if (item.done) li.className = 'done';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = item.done;
      check.addEventListener('change', async () => {
        item.done = check.checked;
        render();
        await save();
      });
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = item.text;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      // 删除先在页内确认（沙箱里 confirm() 恒为 false）。
      remove.textContent = state.pendingDelete === item.id ? '确认删除' : '删除';
      remove.addEventListener('click', async () => {
        if (state.pendingDelete !== item.id) {
          state.pendingDelete = item.id;
          render();
          return;
        }
        state.items = state.items.filter((other) => other.id !== item.id);
        state.pendingDelete = null;
        render();
        await save();
      });
      li.append(check, text, remove);
      list.appendChild(li);
    }
    document.getElementById('empty').hidden = state.items.length > 0;
  }

  async function addItem() {
    const input = document.getElementById('newItem');
    const text = input.value.trim();
    if (text === '') return;
    state.items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false });
    input.value = '';
    render();
    await save();
  }

  document.getElementById('add').addEventListener('click', addItem);
  document.getElementById('newItem').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addItem();
  });

  async function init() {
    try {
      const saved = await window.kepcup.storage.get('items');
      if (Array.isArray(saved)) state.items = saved.filter((item) => item && typeof item.text === 'string');
    } catch (error) {
      showStatus((error && error.message) || '读取失败', true);
    }
    render();
  }

  init();
</script>
</body>
</html>
`;
