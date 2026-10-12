/** 表单计算器骨架：若干输入 → 实时计算结果；输入记忆在 kepcup.storage（防抖保存）。 */
export const FORM_CALCULATOR_TEMPLATE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>计算器</title>
<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
  .result { font-size: 20px; font-weight: 600; margin-top: 12px; }
</style>
</head>
<body>
<main id="app">
  <h3 id="title">计算器</h3>
  <div class="grid">
    <label>数量 A<input id="inputA" type="number" inputmode="decimal" value="0"></label>
    <label>数量 B<input id="inputB" type="number" inputmode="decimal" value="0"></label>
  </div>
  <div class="kc-row">
    <button type="button" id="reset">清空</button>
  </div>
  <p class="result" id="result">0</p>
  <p id="status" class="kc-muted"></p>
</main>
<script>
  const FIELDS = ['inputA', 'inputB'];
  let saveTimer = null;

  // 把输入框的文本读成数字：空串、非数字都按 0，避免页面上出现 NaN。
  function readNumber(id) {
    const value = Number(document.getElementById(id).value);
    return Number.isFinite(value) ? value : 0;
  }

  function compute(values) {
    return values.inputA + values.inputB;
  }

  function render() {
    const values = {};
    for (const id of FIELDS) values[id] = readNumber(id);
    document.getElementById('result').textContent = window.kepcup.ui.format(compute(values));
  }

  function showStatus(text, isError) {
    const status = document.getElementById('status');
    status.textContent = text;
    status.className = isError ? 'kc-error' : 'kc-muted';
  }

  // 输入频繁变化：防抖 500ms 再保存，避免触发宿主限流。
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const values = {};
      for (const id of FIELDS) values[id] = document.getElementById(id).value;
      try {
        await window.kepcup.storage.set('inputs', values);
        showStatus('', false);
      } catch (error) {
        showStatus((error && error.message) || '保存失败', true);
      }
    }, 500);
  }

  for (const id of FIELDS) {
    document.getElementById(id).addEventListener('input', () => {
      render();
      scheduleSave();
    });
  }

  document.getElementById('reset').addEventListener('click', () => {
    for (const id of FIELDS) document.getElementById(id).value = '0';
    render();
    scheduleSave();
  });

  async function init() {
    try {
      const saved = await window.kepcup.storage.get('inputs');
      if (saved && typeof saved === 'object') {
        for (const id of FIELDS) {
          if (typeof saved[id] === 'string') document.getElementById(id).value = saved[id];
        }
      }
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
