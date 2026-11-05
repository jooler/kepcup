import type { WidgetTemplate } from './index.js';

/**
 * 微应用包骨架模板（D112 P3，设计 55 §11 / §6.1 templates/ 分层）：`widget_template` 写入
 * 时连同 micro-app.json、包文件与 fixtures 一起落草稿，能被清单校验器解析并跑通 S2
 * （宿主能力 mock）。三个模板都满足：能力最小、net 收紧（儿童向建议）、有键盘回退、
 * app.ready 协商后按 grants 降级、kepcup 调用 await + try/catch。
 */

const TUTOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>口语陪练</title>
</head>
<body>
<main id="app">
  <h3 id="title">English Practice</h3>
  <div id="chat" class="kc-card" style="min-height:180px;padding:12px"></div>
  <p id="status" class="kc-muted"></p>
  <div class="kc-row">
    <input type="text" id="text-input" placeholder="Type here if mic is off…" style="flex:1">
    <button type="button" id="send" class="primary">Send</button>
  </div>
  <div class="kc-row">
    <button type="button" id="mic" class="primary">🎙 Talk</button>
    <button type="button" id="progress">同步进度</button>
  </div>
</main>
<script>
  const state = { turns: [], listening: null };

  function render() {
    const chat = document.getElementById('chat');
    chat.innerHTML = '';
    for (const turn of state.turns) {
      const p = document.createElement('p');
      p.textContent = (turn.role === 'user' ? 'You: ' : 'Tutor: ') + turn.text;
      chat.appendChild(p);
    }
    chat.scrollTop = chat.scrollHeight;
  }

  function showError(error) {
    const status = document.getElementById('status');
    status.textContent = (error && error.message) || '出错了';
    status.className = 'kc-error';
  }

  async function ask(text) {
    state.turns.push({ role: 'user', text });
    render();
    try {
      const out = await window.kepcup.ai.chat({ messages: state.turns.map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text })) });
      state.turns.push({ role: 'tutor', text: out.text });
      render();
      await window.kepcup.media.speak({ text: out.text });
    } catch (error) {
      showError(error);
    }
  }

  async function startListening() {
    try {
      const session = await window.kepcup.media.listen({ lang: 'en-US', mode: 'vad' });
      session.on('final', (value) => {
        const text = value && typeof value.text === 'string' ? value.text : '';
        if (text !== '') void ask(text);
      });
      session.on('error', (value) => showError(value instanceof Error ? value : new Error(String(value))));
      await session.start();
      state.listening = session;
      document.getElementById('mic').textContent = '🎙 Listening…';
    } catch (error) {
      // 麦克风被拒 / 缺 ASR 配置：键盘输入仍然可用（降级路径）。
      showError(error);
    }
  }

  async function init() {
    try {
      const ready = await window.kepcup.app.ready();
      if (!ready.capabilities.includes('media.listen')) document.getElementById('mic').disabled = true;
      const saved = await window.kepcup.storage.get('session:turns');
      if (Array.isArray(saved)) state.turns = saved;
      if (state.turns.length === 0) await ask('Hello! I am your tutor. Say hi!');
    } catch (error) {
      showError(error);
    }
    render();
  }

  document.getElementById('send').addEventListener('click', async () => {
    const input = document.getElementById('text-input');
    const text = input.value.trim();
    if (text === '') return;
    input.value = '';
    await ask(text);
  });

  document.getElementById('mic').addEventListener('click', () => {
    if (state.listening === null) void startListening();
    else {
      void state.listening.stop();
      state.listening = null;
      document.getElementById('mic').textContent = '🎙 Talk';
    }
  });

  document.getElementById('progress').addEventListener('click', async () => {
    try {
      await window.kepcup.context.update({ headline: '完成 ' + state.turns.length + ' 轮口语练习', data: { turns: state.turns.length } });
      await window.kepcup.storage.set('session:turns', state.turns);
      document.getElementById('status').textContent = '进度已同步';
      document.getElementById('status').className = 'kc-muted';
    } catch (error) {
      showError(error);
    }
  });

  init();
</script>
</body>
</html>
`;

const FORM_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>信息收集</title>
</head>
<body>
<main id="app">
  <h3 id="title">报名信息</h3>
  <div class="kc-row"><label>姓名 <input type="text" id="name"></label></div>
  <div class="kc-row"><label>年级 <input type="text" id="grade"></label></div>
  <div class="kc-row"><button type="button" id="submit" class="primary">保存</button>
  <button type="button" id="handin">交给 Bot</button></div>
  <p id="status" class="kc-muted"></p>
</main>
<script>
  function showError(error) {
    const status = document.getElementById('status');
    status.textContent = (error && error.message) || '出错了';
    status.className = 'kc-error';
  }

  function readForm() {
    return { name: document.getElementById('name').value.trim(), grade: document.getElementById('grade').value.trim() };
  }

  async function init() {
    try {
      const saved = await window.kepcup.storage.get('form');
      if (saved && typeof saved === 'object') {
        document.getElementById('name').value = String(saved.name ?? '');
        document.getElementById('grade').value = String(saved.grade ?? '');
      }
    } catch (error) {
      showError(error);
    }
  }

  document.getElementById('submit').addEventListener('click', async () => {
    try {
      await window.kepcup.storage.set('form', readForm());
      document.getElementById('status').textContent = '已保存';
      document.getElementById('status').className = 'kc-muted';
    } catch (error) {
      showError(error);
    }
  });

  document.getElementById('handin').addEventListener('click', async () => {
    const form = readForm();
    if (form.name === '') {
      document.getElementById('status').textContent = '姓名还没有填';
      document.getElementById('status').className = 'kc-error';
      return;
    }
    try {
      const sent = await window.kepcup.reply('报名信息：' + JSON.stringify(form));
      document.getElementById('status').textContent = sent ? '已交给 Bot' : '发送被取消';
    } catch (error) {
      showError(error);
    }
  });

  init();
</script>
</body>
</html>
`;

const BOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="kepcup-kit" content="1">
<title>练习看板</title>
</head>
<body>
<main id="app">
  <h3 id="title">本周练习</h3>
  <div id="stats" class="kc-card" style="padding:12px"></div>
  <p id="status" class="kc-muted"></p>
</main>
<script>
  function showError(error) {
    const status = document.getElementById('status');
    status.textContent = (error && error.message) || '出错了';
    status.className = 'kc-error';
  }

  async function init() {
    try {
      const rows = await window.kepcup.query('daily_minutes');
      const total = rows.reduce((sum, row) => sum + Number(row.minutes ?? 0), 0);
      const days = rows.length;
      document.getElementById('stats').textContent = '本周累计 ' + total + ' 分钟 · 练习 ' + days + ' 天';
    } catch (error) {
      showError(error);
    }
  }

  init();
</script>
</body>
</html>
`;

const TUTOR_MANIFEST = {
  spec: 'kepcup-micro-app/1',
  slug: 'voice-tutor',
  name: '口语陪练',
  description: '虚拟人物陪练口语：说话 → 转写 → 模型回复 → 播报，可打断，进度可恢复',
  entry: 'index.html',
  permissions: ['storage.kv', 'ai.chat', 'media.listen', 'media.speak', 'context.update'],
  net: { mode: 'none' as const },
  display: { mode: 'immersive' as const },
};

export const MICRO_APP_TEMPLATES: readonly WidgetTemplate[] = [
  {
    name: 'micro-voice-tutor',
    summary: '微应用·语音陪练：说话转写 → 模型回复 → 播报，键盘回退 + 进度同步（带清单与 fixtures，S2 mock 可跑整轮）',
    html: TUTOR_HTML,
    manifestJson: `${JSON.stringify(TUTOR_MANIFEST, null, 2)}\n`,
    fixtures: {
      ai: ["Great job! Let's practice: 'I went to the park yesterday.'", 'Nice! Try: "She has been studying for two hours."'],
      transcripts: ['I went to the park yesterday', 'She has been studying for two hours'],
    },
  },
  {
    name: 'micro-form-intake',
    summary: '微应用·信息收集：表单存 storage + 一键 reply 交给 Bot（带清单，网络收紧为 none）',
    html: FORM_HTML,
    manifestJson: `${JSON.stringify(
      {
        spec: 'kepcup-micro-app/1',
        slug: 'form-intake',
        name: '信息收集',
        description: '收集结构化信息并存本地，一键交给 Bot 处理',
        entry: 'index.html',
        permissions: ['storage.kv', 'host.reply'],
        net: { mode: 'none' as const },
        display: { mode: 'inline' as const },
      },
      null,
      2,
    )}\n`,
  },
  {
    name: 'micro-data-board',
    summary: '微应用·数据看板：命名查询 → 指标摘要（带清单与 queries.json 示例）',
    html: BOARD_HTML,
    manifestJson: `${JSON.stringify(
      {
        spec: 'kepcup-micro-app/1',
        slug: 'data-board',
        name: '练习看板',
        description: '从对话数据里汇总本周练习量',
        entry: 'index.html',
        permissions: ['storage.kv'],
        net: { mode: 'none' as const },
        display: { mode: 'inline' as const },
      },
      null,
      2,
    )}\n`,
    queries: [{ name: 'daily_minutes', sql: 'select 1 as day, 10 as minutes' }],
  },
];
