import { BOT_WIDGET_HTML_MAX_BYTES, type WidgetCheckIssue } from '@kepcup/shared';

/**
 * 组件检查器的规则注册表（设计 32 §11.8）。规则、制作 loop 的「沙箱雷区清单」提示词
 * （{@link sandboxPitfallsPrompt}）与卡片上的「已知问题」文案都从这里生成——改一处三处同步，
 * 提示与检查不会漂移（单测锁住：提示词必须提到每一条规则 id）。
 *
 * 级别与阻断（设计 32 §11.6）：S0 / S1 的 error 全部是阻断项；S2 里未捕获异常 / 未处理的
 * 拒绝 / 页面空白 / 预览超时是阻断项，`console.error` 与 `csp.violation` 是不阻断的 error
 * （外链资源的 CSP 违规 S0 已经静态拦住，S2 再报只是佐证）。沙箱行为以 P3-0 在 Electron
 * 44 上的实测为准（执行文档 §8.1）：`alert` 不阻断控制流，降为 warning；只有 submit 按钮、
 * 没有 submit 处理函数时按钮的 click 照常执行，拆成 warning。
 */
export interface WidgetCheckRule {
  /** 规则 id（如 `sandbox.storage`）。 */
  id: string;
  level: 'error' | 'warning';
  stage: 'S0' | 'S1' | 'S2';
  /** 阻断项：存在即不可交付。 */
  blocking: boolean;
  /** 简短标题（给模型）。 */
  title: string;
  /** 怎么改（给模型，具体到 `kepcup.*` 替代写法）。 */
  hint: string;
  /** 卡片「已知问题」里给用户看的一句话；空串 = 不上卡（只关乎制作过程的规则）。 */
  userText: string;
}

const HTML_MAX_MB = Math.round((BOT_WIDGET_HTML_MAX_BYTES / 1024 / 1024) * 10) / 10;

export const WIDGET_CHECK_RULES: readonly WidgetCheckRule[] = [
  // --- S0 静态 -------------------------------------------------------------------
  {
    id: 'html.missing',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '缺少 index.html',
    hint: '在草稿目录写出完整的 index.html（单文件：HTML + 内联 <style> + 内联 <script>）。',
    userText: '组件源码缺失',
  },
  {
    id: 'html.size',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: 'HTML 超出体积上限',
    hint: `单文件不能超过 ${HTML_MAX_MB} MB：删掉重复的样式与示例数据，图片改用 CSS 或内联 SVG。`,
    userText: '组件体积超出上限',
  },
  {
    id: 'html.truncated',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: 'HTML 不完整（疑似输出被截断）',
    hint: '补全缺失的结尾（未闭合的 <script> / <style> / 注释、</body>、</html>）。文件很长时用 edit 分段补写，不要整份重写。',
    userText: '组件源码不完整',
  },
  {
    id: 'html.doctype',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: '缺少 <!DOCTYPE html>',
    hint: '第一行写 <!DOCTYPE html>，否则页面进入怪异模式（quirks mode），盒模型与 CSS 表现异常。',
    userText: '页面排版可能异常',
  },
  {
    id: 'sandbox.external-resource',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '引用了外部资源（加载不到）',
    hint:
      "组件是离线单文件：CSP default-src 'none' 拦截一切外链，草稿目录里的其他文件也不会随组件发布——CDN 脚本、" +
      'Google Fonts、外链样式 / 图片、相对路径的 src / href、import 都加载不到（CSS url() 被拦时连报错都没有）。' +
      '脚本与样式写进内联 <script> / <style>；图标用内联 SVG 或 data: URL；字体用系统字体栈；图表用内联 SVG / canvas 自己画。',
    userText: '部分外部资源（脚本、字体或图片）无法加载',
  },
  {
    id: 'sandbox.storage',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '使用了浏览器存储（沙箱里一碰就抛错）',
    hint:
      '不透明 origin 下 localStorage / sessionStorage / indexedDB / document.cookie 连读取都抛 SecurityError，' +
      '整段脚本随之中断。持久化改用 await kepcup.storage.get(key) / await kepcup.storage.set(key, value)' +
      '（值可为任意 JSON），删除用 kepcup.storage.delete(key)，列出用 kepcup.storage.list()。',
    userText: '数据保存功能无法使用',
  },
  {
    id: 'sandbox.network',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '发起了网络请求（组件禁网）',
    hint:
      'fetch / XMLHttpRequest / WebSocket / EventSource / navigator.sendBeacon 都会失败。需要的数据写进组件本身、' +
      '用 kepcup.storage 保存，或在 queries.json 里声明查询模板后用 await kepcup.query(名字, 参数) 读取。',
    userText: '联网请求无法完成',
  },
  {
    id: 'sandbox.modals',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '使用了 confirm / prompt（不弹窗）',
    hint:
      'confirm() 立即返回 false、prompt() 立即返回 null，不会弹窗——if (confirm(…)) 的分支永远不执行。' +
      '改成页内确认 UI（如点一次按钮变成「确认删除？」、再点一次才执行），输入用页内的输入框 + 按钮。',
    userText: '需要确认或输入的操作无法完成',
  },
  {
    id: 'sandbox.alert',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: '使用了 alert（提示不会显示）',
    hint: 'alert() 不弹窗、直接返回，用户看不到提示。改成页内提示（状态栏文字或页内 toast 元素）。',
    userText: '部分提示信息不会显示',
  },
  {
    id: 'sandbox.form-submit',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '依赖表单提交（submit 事件永远不触发）',
    hint:
      '沙箱禁止表单提交：点 submit 按钮、在输入框按 Enter、requestSubmit()、form.submit() 都不会触发 submit 事件。' +
      '去掉 onsubmit / submit 监听，按钮写 type="button" 并在它的 click 里处理；需要回车时在输入框的 keydown 里判断 event.key === "Enter"。',
    userText: '提交表单的操作没有反应',
  },
  {
    id: 'sandbox.submit-button',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: 'submit 类型的按钮',
    hint: 'submit 按钮自身的 click 处理照常执行，但回车提交与默认提交无效。显式写 type="button"，需要回车时自己处理 keydown。',
    userText: '在输入框里按回车不会提交',
  },
  {
    id: 'sandbox.popup',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '打开新窗口（沙箱不允许）',
    hint: '沙箱没有弹窗权限：window.open() 返回 null，target="_blank" 的链接点了没反应。外部链接改用 kepcup.openLink("https://…")（宿主请用户确认后在浏览器打开）。',
    userText: '打开外部链接无反应',
  },
  {
    id: 'sandbox.top-nav',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '页面导航（宿主拦截）',
    hint:
      '宿主拦截组件框架的一切导航：改写 location / location.href / top.location、location.assign / replace / reload() 都无效或抛错。' +
      '页内切换视图用显示 / 隐藏元素（可配合 location.hash）；外部网址用 kepcup.openLink(url)。',
    userText: '页面跳转无反应',
  },
  {
    id: 'sandbox.link-navigation',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: '普通链接（点击会被拦下）',
    hint: '点 <a href="https://…"> 这类链接会被宿主的导航守卫拦下，什么也不发生。外链改成按钮 + kepcup.openLink(url)；页内跳转用 href="#锚点"。',
    userText: '部分链接点击无反应',
  },
  {
    id: 'sandbox.download',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: '下载链接（沙箱里无效）',
    hint: 'a[download] 在沙箱里静默无效。需要导出时把内容显示在页内（如可全选的 <textarea>），提示用户复制。',
    userText: '下载 / 导出功能不可用',
  },
  {
    id: 'sandbox.clipboard',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: '使用了 navigator.clipboard（被拒）',
    hint: 'navigator.clipboard 在沙箱里被拒（NotAllowedError）。把文本放进页内可选中的 <textarea>，提示用户手动复制。',
    userText: '复制到剪贴板不可用',
  },
  {
    id: 'theme.media-query',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: '用 prefers-color-scheme 跟随系统主题',
    hint:
      '应用主题可能与系统不同。用 [data-theme="dark"] 选择器与宿主的 CSS 变量（var(--kc-bg, #fff)、--kc-fg、--kc-muted、' +
      '--kc-border、--kc-accent、--kc-danger，写好备用值），或 await kepcup.theme() 取当前主题。',
    userText: '深浅色可能与应用主题不一致',
  },
  {
    id: 'query.invalid',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: 'queries.json 未通过校验',
    hint:
      'queries.json 必须是 [{"name": "…", "sql": "select …"}] 数组；SQL 只读、只能引用视图 widget_kv / conversation_messages、' +
      '不能带库名前缀，参数用 :名字 占位。按报错修改对应的查询。',
    userText: '数据查询配置有误',
  },
  {
    id: 'query.unknown-name',
    level: 'error',
    stage: 'S0',
    blocking: true,
    title: '调用了未声明的查询',
    hint: '在 queries.json 里声明同名的查询模板（{"name", "sql"}），或改成已声明的名字。',
    userText: '部分数据查询无法执行',
  },
  {
    id: 'acceptance.invalid',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: 'acceptance.json 格式不合格',
    hint:
      '按验收点 schema 改写：[{"id", "desc", "must", "steps": [{"click": 选择器} | {"fill": 选择器, "value": "…"} | …], ' +
      '"expect": [{"selector": 选择器, "textContains": "…"} | …]}]。不合格时预览只跑乱点冒烟。',
    userText: '',
  },
  {
    id: 'fixtures.invalid',
    level: 'warning',
    stage: 'S0',
    blocking: false,
    title: 'fixtures.json 格式不合格',
    hint: 'fixtures.json 必须是 {"storage": {键: 值}, "queries": {查询名: [行对象, …]}}；不合格时预览按空数据运行。',
    userText: '',
  },

  // --- S1 JavaScript ---------------------------------------------------------------
  {
    id: 'js.syntax',
    level: 'error',
    stage: 'S1',
    blocking: true,
    title: '脚本语法错误',
    hint: '按报错位置修正语法；输出被截断时补全剩余代码。经典 <script> 顶层不能用 await——放进 async 函数里再调用。',
    userText: '脚本有语法错误，组件无法运行',
  },
  {
    id: 'js.handler-syntax',
    level: 'error',
    stage: 'S1',
    blocking: true,
    title: 'on* 属性里的代码有语法错误',
    hint: 'on* 属性里是函数体：只写简单调用（如 onclick="addRow()"），复杂逻辑放进 <script> 里的函数；属性里的引号要与外层不同。',
    userText: '部分按钮点击后报错',
  },
  {
    id: 'js.handler-undefined',
    level: 'error',
    stage: 'S1',
    blocking: true,
    title: '内联事件处理器找不到函数',
    hint:
      'onclick 等内联处理器只能看到全局函数：写在 DOMContentLoaded / load 回调里或 type="module" 脚本里的函数它看不到。' +
      '推荐在脚本里用 addEventListener 绑定事件；或把函数移到经典 <script> 的顶层；或 window.函数名 = 函数名。',
    userText: '部分按钮点击后没有反应',
  },
  {
    id: 'js.undefined-name',
    level: 'error',
    stage: 'S1',
    blocking: true,
    title: '使用了未定义的名字',
    hint: '先声明再用，检查拼写。沙箱里没有任何第三方库（Chart、$、_、dayjs 等都不存在，CDN 也加载不了）——需要的功能自己写。',
    userText: '脚本引用了不存在的变量或函数',
  },
  {
    id: 'js.redeclare',
    level: 'error',
    stage: 'S1',
    blocking: true,
    title: '多个脚本之间重复声明',
    hint:
      '多个经典 <script> 共享全局词法作用域：同名 let / const / class（或与另一段的 var / function 同名）会让后一段整段抛 SyntaxError、' +
      '一行都不执行；let / const 也不能用 window、document、location、top 这类名字。合并成一个 <script>、改名，或把代码包进函数。',
    userText: '部分脚本无法运行',
  },
  {
    id: 'dom.id-missing',
    level: 'error',
    stage: 'S1',
    blocking: true,
    title: '按 id 取元素，但页面里没有这个 id',
    hint: '在 HTML 里加上这个 id 的元素，或改正 getElementById / querySelector 里的拼写（拿到 null 后再访问属性会抛 TypeError）。',
    userText: '部分界面元素找不到，相关功能会报错',
  },
  {
    id: 'dom.duplicate-id',
    level: 'warning',
    stage: 'S1',
    blocking: false,
    title: '重复的 id',
    hint: 'id 必须唯一：getElementById 只会拿到第一个。重复的元素改用 class。',
    userText: '部分元素可能不响应操作',
  },
  {
    id: 'kepcup.not-awaited',
    level: 'warning',
    stage: 'S1',
    blocking: false,
    title: 'kepcup 调用的结果没有 await 就被使用',
    hint:
      'kepcup.storage.* 与 kepcup.query 返回 Promise：在 async 函数里 await（或 .then）之后再用结果，' +
      '否则拿到的是 Promise 对象而不是数据。并发多个调用用 await Promise.all([...])。',
    userText: '部分数据可能显示不正确',
  },

  // --- S2 预览（P3b 执行；这里先登记，提示词里作为运行时预期） ----------------------
  {
    id: 'runtime.error',
    level: 'error',
    stage: 'S2',
    blocking: true,
    title: '运行时未捕获的异常',
    hint: '按报错与行号修正；注意空数据、元素不存在、JSON 解析失败、kepcup 调用被拒（有 code）等边界。',
    userText: '运行时会报错',
  },
  {
    id: 'runtime.rejection',
    level: 'error',
    stage: 'S2',
    blocking: true,
    title: '未处理的 Promise 拒绝',
    hint: '给 kepcup.* 调用加 try / catch（配合 await）或 .catch，失败时在页内显示原因（error.code 区分限流、配额、过期）。',
    userText: '部分操作失败时没有处理',
  },
  {
    id: 'console.error',
    level: 'error',
    stage: 'S2',
    blocking: false,
    title: '运行中有 console.error 输出',
    hint: '找到输出错误的代码路径并修正根因；不要只删掉 console.error。',
    userText: '运行中有错误输出',
  },
  {
    id: 'console.warn',
    level: 'warning',
    stage: 'S2',
    blocking: false,
    title: '运行中有 console.warn 输出',
    hint: '确认警告是否意味着功能异常；调试输出交付前删掉。',
    userText: '',
  },
  {
    id: 'csp.violation',
    level: 'error',
    stage: 'S2',
    blocking: false,
    title: '被安全策略（CSP）拦截',
    hint: '去掉外链脚本 / 样式 / 图片 / 字体与网络请求，改成内联或 data: URL（见 sandbox.external-resource / sandbox.network）。',
    userText: '部分资源被安全策略拦截',
  },
  {
    id: 'render.blank',
    level: 'error',
    stage: 'S2',
    blocking: true,
    title: '页面空白',
    hint: '加载后没有任何可见内容：检查脚本是否报错、初始渲染是否在等数据（数据为空也要显示空状态与操作入口）。',
    userText: '页面空白',
  },
  {
    id: 'render.overflow-x',
    level: 'warning',
    stage: 'S2',
    blocking: false,
    title: '窄屏横向溢出',
    hint: '360px 宽下内容超出：用弹性布局、max-width: 100%、overflow-wrap: anywhere；宽表格外包一层 overflow-x: auto 的容器。',
    userText: '窄屏下内容横向溢出',
  },
  {
    id: 'render.bad-text',
    level: 'warning',
    stage: 'S2',
    blocking: false,
    title: '页面上出现 NaN / undefined / [object Object] / null',
    hint: '数字先校验再计算（空输入按 0 或提示），对象取字段后再显示，空值显示占位文字。',
    userText: '部分数值显示异常（如 NaN）',
  },
  {
    id: 'preview.timeout',
    level: 'error',
    stage: 'S2',
    blocking: true,
    title: '预览超时（疑似死循环）',
    hint: '检查 while / for 循环的退出条件、递归终止条件，以及加载期间的长时间同步计算。',
    userText: '组件会卡死',
  },
];

const RULES_BY_ID = new Map(WIDGET_CHECK_RULES.map((rule) => [rule.id, rule]));

/** 按 id 取规则；未知 id 抛错（规则 id 是代码常量，写错是 bug）。 */
export function widgetCheckRule(id: string): WidgetCheckRule {
  const rule = RULES_BY_ID.get(id);
  if (rule === undefined) throw new Error(`unknown widget check rule: ${id}`);
  return rule;
}

/** 单条问题文本的上限：报错原文（如超长的 SQL 报错）不能挤掉其他条目。 */
const ISSUE_MESSAGE_MAX_CHARS = 300;

/**
 * 按规则生成一条问题。`level` 可降级（`js.undefined-name` 未被调用时是 warning）；
 * 阻断与否由规则决定，且只有 error 级才可能阻断。
 */
export function ruleIssue(
  id: string,
  input: {
    message: string;
    line?: number;
    col?: number;
    level?: 'error' | 'warning';
    file?: WidgetCheckIssue['file'];
    trigger?: string;
    viewport?: string;
  },
): WidgetCheckIssue {
  const rule = widgetCheckRule(id);
  const level = input.level ?? rule.level;
  const message =
    input.message.length > ISSUE_MESSAGE_MAX_CHARS
      ? `${input.message.slice(0, ISSUE_MESSAGE_MAX_CHARS - 1)}…`
      : input.message;
  const issue: WidgetCheckIssue = {
    rule: id,
    level,
    stage: rule.stage,
    blocking: rule.blocking && level === 'error',
    file: input.file ?? 'index.html',
    message,
    hint: rule.hint,
  };
  if (input.line !== undefined) issue.line = input.line;
  if (input.col !== undefined) issue.col = input.col;
  if (input.trigger !== undefined) issue.trigger = input.trigger;
  if (input.viewport !== undefined) issue.viewport = input.viewport;
  return issue;
}

const LEVEL_LABEL = { error: '错误', warning: '警告' } as const;

/**
 * 制作 loop 系统提示里的「沙箱雷区清单」（设计 32 §11.7）：由注册表生成，S0 / S1 规则逐条列出
 * （宿主检查器会机器执行），S2 规则作为「真实运行时的预期」列出。
 */
export function sandboxPitfallsPrompt(): string {
  const section = (stage: WidgetCheckRule['stage']): string =>
    WIDGET_CHECK_RULES.filter((rule) => rule.stage === stage)
      .map((rule) => {
        const level = rule.blocking ? `${LEVEL_LABEL[rule.level]}·阻断` : LEVEL_LABEL[rule.level];
        return `- [${rule.id}]（${level}）${rule.title}：${rule.hint}`;
      })
      .join('\n');
  return [
    '## 沙箱雷区清单（检查器规则）',
    '',
    '组件跑在 sandbox="allow-scripts" 的不透明 origin iframe 里：CSP default-src \'none\'，没有网络、没有弹窗 / 表单 / 导航权限，' +
      '除了 index.html 本身没有任何文件。宿主的检查器按下面的规则机器检查每一版草稿，报告格式是' +
      '「[规则id] 第 L 行:C 列 — 问题 — 怎么改」。标「阻断」的必须修好才能交付；警告不阻断交付，但会作为已知问题告诉用户。',
    '',
    '### 静态检查（S0：HTML 结构、沙箱禁区、查询声明）',
    section('S0'),
    '',
    '### 脚本检查（S1：语法与作用域）',
    section('S1'),
    '',
    '### 运行预览（S2：在真实浏览器里加载、乱点、执行验收点时的预期）',
    section('S2'),
  ].join('\n');
}
