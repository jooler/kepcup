# 组件「在新窗口打开」（设计稿 + 执行文档）

> 状态：**实施中（2026-11-05）**。上游台账：[README.md](README.md)（P0–P3 已收口）；这是平台收口后的第一项增量能力：组件/微应用除了主窗口内的覆盖层（`WidgetViewer`，占满中部+右栏），允许**起一个独立 Electron 窗口**运行同一个组件卡。
> 红线不变：生成代码只跑在沙箱 iframe；能力只经宿主桥；本能力是**宿主外壳自身的 UI 能力**（用户在 KepCup 界面点按钮），不进入微应用能力枚举，微应用无法自行触发或感知。

## 1. 现状与目标

- 现状：海报卡点击 → `widgetViewer.show(messageId, card)` → `WidgetViewer.svelte` Portal 覆盖层（占主区+右栏）内挂 `WidgetRuntime`。一次一个；切会话自动关闭。
- 目标：覆盖层头部新增「在新窗口打开」：把当前卡片移交到独立 OS 窗口（可调大小、可与主窗口并排），覆盖层随即关闭（同一张卡不双实例运行）。窗口内提供与覆盖层一致的微应用外壳面（常驻网络徽标 / 麦克风授权开关 / 全屏键 / 停止键 / 重载 / 关闭）——55 §3.3 的「外壳常驻徽标」与 §7.3 MicroAppChrome 在任何宿主形态都不可缺。

## 2. 可行性核对（2026-11-05 结论：可行）

| 关注点 | 结论 |
|---|---|
| WidgetRuntime 自包含性 | 只依赖 `messageId + card + micGranted + onDisplayMode` props；core RPC 走 preload 端口 A；音频走 `sensors`/preload IPC。**不依赖聊天会话上下文**（会话守卫只在 WidgetViewer 层）→ 新窗口可直接复用 |
| core 端口 A（唯一硬阻塞） | `packages/core/src/process-entry.ts` 当前 app-port **单客户端**（新端口到达先 `appServer?.close()`）——新窗口接管会踢掉主窗口连接。**改造为多客户端**（§4.1） |
| 麦克风权限 | default session 权限处理器按 `requestingUrl === appUrl()` 判定（index.ts）→ 新窗口加载同一渲染 URL，天然放行 |
| `kepcup-app` 协议 | 处理器注册在 default session（iframe 网络栈跟随宿主 webContents 的 session）→ 新窗口同 session，微应用包加载无碍 |
| 事件广播（micro-app.stream 等） | core 事件桥随多客户端推送到所有 app-port 客户端；`WidgetRuntime.forwardStreamEvent` 按实例过滤 → 双窗口互不串扰 |
| 主题 / i18n | mode-watcher 与 i18n 读同源 localStorage → 新窗口自动一致 |
| 可见性事件 | `visibilitychange` pause/resume（§9.1）在窗口形态天然成立（最小化 = hidden） |
| 退出语义 | 托盘常驻（`window-all-closed` 空监听）；`before-quit → beginQuit` 增加关闭全部组件窗口 |

## 3. 契约与命名

- 主进程 IPC：`window:openWidget`（invoke，入参 `{ messageId: string; card: WidgetCard }`，主进程 `widgetCardSchema.parse` 校验）；推送 `widget-window:payload`（did-finish-load 后 `{ messageId, card }`）。
- preload API：`window.kepcup.openWidgetWindow(input)` / `window.kepcup.onWidgetWindowPayload(cb)`。
- 渲染层窗口模式：渲染入口 URL 携带 `?kcWindow=widget`；`App.svelte` 顶层分支只渲染 `WidgetWindowApp`（不进主壳，不挂侧栏/会话）。
- 主进程模块：`apps/desktop/src/main/widget-window.ts`（注册表 + 创建 + 校验 + URL 构造，纯逻辑可单测）。

## 4. 分层方案

### 4.1 core：app-port 多客户端（唯一契约变更）

- `process-entry.ts`：`appServer` 单变量 → `AppPortRegistry`（小类，导出可单测）：
  - `bind(transport, services)`：新建 `RpcServerHandle` 加入集合，`services.pushStatusTo(server)`；**不再 close 旧 server**（旧端口由渲染端销毁触发 `port.on('close')` 自然出清——与「fresh replaces previous」等效：reload 的旧端口必然关闭）。
  - `pushEvent(name, payload)`：遍历集合，单个 `pushEvent` 失败（端口已死）只摘除该客户端并 warn，不中断其他客户端。
  - `ElectronPortLike` 接口补 `on('close', ...)`。
- 主窗口重载语义不变：did-finish-load 每次换新 pair，旧端口 close 后出清。
- 单测：registry 的 bind/pushEvent/close 清理/死端口容错。

### 4.2 主进程：组件窗口

- `widget-window.ts`：
  - `openWidgetWindow({ input, preloadPath, rendererUrlResolver, log })`：同主窗口 webPreferences（preload / `sandbox:true` / `contextIsolation:true` / `nodeIntegration:false`）；标题 = card.title；默认 960×720（minWidth 420——inline 模式 420px 宽的下限）；dev 加载 `ELECTRON_RENDERER_URL + '?kcWindow=widget'`，prod `loadFile(index.html, { query })`。
  - 注册表 `Map<number, { win, messageId }>`：同 messageId 已开 → focus 不重开；`closed` 出清。
  - `did-finish-load`：`sendAppPortTo(win)`（复用 index.ts 的端口握手，抽参数化）+ `webContents.send('widget-window:payload', { messageId, card })`。
  - `setWindowOpenHandler` deny；`will-navigate` 阻止主框架跳离渲染入口（kepcup-app 子框架导航已有 `guardAllAppFrames` 全局兜底）。
  - `closeAllWidgetWindows()`：beginQuit 调用。
- 入参校验：`widgetCardSchema.parse`（shared 契约），失败记 warn 不开窗。

### 4.3 preload：两个透传方法

`openWidgetWindow`（invoke）与 `onWidgetWindowPayload`（ipcRenderer.on + removeListener 退订，形态同 `onNavigateConversation`）。

### 4.4 渲染层

1. **挂载点分流（实施时改为 main.ts，比 App.svelte 分支更彻底）**：`isWidgetWindowLocation()`（`location.search` 有 `kcWindow=widget`）在 `main.ts` 的 mount 处直接选 `WidgetWindowApp`——主壳的模块图（chat / shell / settings 等 store、全局浮层、全局快捷键）整段不加载，组件窗口只有 MicroAppChrome + WidgetRuntime。
2. `WidgetWindowApp.svelte`（features/widgets/）：
   - 等 `payload`（preload 推送）且 `core.connection === 'connected'` 再挂 Runtime；关闭按钮 = `window.close()`。
   - 头部复用覆盖层同款微应用控件（§4.5 抽取件）：网络徽标（点击展开访问范围）、麦克风开关（本窗口会话级授权，打开重置为关——同 55 §5.1）、全屏键 inline⇄immersive、停止键；非微应用组件只显示重载/关闭。
   - inline 模式居中 420px、immersive 铺满（同覆盖层布局分支）。
3. `MicroAppControls.svelte`（抽取共用）：覆盖层与窗口共用同一份控件实现（单一事实来源，防止两个外壳面漂移）；props = `microApp + micGranted + onToggleMic + displayMode + onToggleDisplayMode + onStopAudio`；testid 保持 `widget-viewer-*` 前缀不变（现无测试引用，保持稳定命名），窗口侧用 `widget-window-*` 前缀（前缀作为 prop）。
4. `WidgetViewer.svelte`：头部加「在新窗口打开」按钮（`ExternalLink` 图标）→ `openWidgetWindow({ messageId, card })` → 成功后 `widgetViewer.close()`（移交，不双实例）；失败 toast 不关。
5. i18n：zh `botWidget.openInWindow` = 「在新窗口打开」；en = "Open in new window"。

## 5. 边界与决策

- **移交而非并存**：开窗口即关覆盖层。理由：`widgets.ui.open` 按 messageId 登记资源、微应用 ai/媒体记账按实例隔离——同卡双实例会产生双份用量与双麦克风会话，且用户心智是「同一个组件换个地方跑」。窗口关闭后卡片还在对话里，可随时重开。
- **麦克风授权不跨形态保留**：新窗口按「每次打开重置为关」（55 §5.1 既有语义）；用户在窗口内自行开启。
- **窗口模式不进会话守卫**：无 `getChatSession`；切换会话不影响已开的组件窗口（组件运行是资源租约语义，与对话展示无关——与「关掉一个网页」一致，窗口就是它的网页）。
- **卡片数据通路**：主进程内存转交 `{ messageId, card }`（UI 描述符，不含 HTML/密钥）；渲染端拿到后再 `widgets.ui.open` 由 core 按 messageId 登记真实资源——不可信数据不经过这条通路。**载荷必须 `$state.snapshot` 拍成纯对象再过 IPC**：`widgetViewer.current` 是 `$state` 深代理，Electron IPC 的结构化克隆克隆不了 Proxy（`DataCloneError`），直传会在 `invoke` 边界即炸（实测表现：按钮一按就弹「未能打开组件窗口」，窗口不创建）；封装在 `widgetWindowHandoffPayload`，回归测试 `widget-viewer.svelte.test.ts` 用 `structuredClone`（同款 V8 序列化器）守住。
- **legacy 组件同样可用**：WidgetRuntime 本就双路径（v1 桥 / v2 桥），窗口模式对存量组件零差异。

## 6. 执行清单（2026-11-05 全部完成）

- [x] core：`AppPortRegistry`（`packages/core/src/app-port-registry.ts`）+ process-entry 接线 + 头注更新 + 单测（5 条）
- [x] main：`widget-window.ts`（纯逻辑）+ `widget-window-electron.ts`（装配，拆文件守住「被测模块不 import electron 运行时」的测试约定）+ index.ts（IPC `window:openWidget` / `sendAppPort` 参数化并遍历组件窗口 / core 状态广播 / beginQuit 清理）+ 单测（10 条）
- [x] preload：`openWidgetWindow` / `onWidgetWindowPayload` + shim.d.ts 类型 + web-shim no-op 桩（web 端点不支持，按钮按 opened=false 提示）
- [x] renderer：`widget-window-mode.ts` + main.ts 挂载点分流（比原 App.svelte 分支更彻底：主壳模块图整段不加载）+ `WidgetWindowApp` + `MicroAppControls` 抽取（WidgetViewer 改用）+ Viewer「在新窗口打开」按钮（移交成功才关覆盖层）+ i18n（zh/en）
- [x] 测试：定向 92 条绿；core 包全量 4962 绿；typecheck（core/desktop）与 eslint（改动文件）全绿
- [x] 收口：全量 `pnpm test` **739 文件 / 7862 用例全绿**（中途两轮各 1 例负载超时抖动，单跑复核通过，末两轮连续干净）
- [x] 修复实测 bug（2026-11-05）：覆盖层按钮点击即弹「未能打开组件窗口」——`$state` 深代理过不了 IPC 结构化克隆；载荷改走 `widgetWindowHandoffPayload`（`$state.snapshot`）+ 回归测试 1 条绿
- [x] 修复实测 bug（2026-11-05）：窗口一直「正在加载组件...」——组件窗口 did-finish-load 只推了 payload、**没发端口 A**（`sendAppPort` 只挂在主窗口 load 与 core 重启 'up' 上）；host 增 `onWindowDidLoad` 钩子，index.ts 在此补 `sendAppPort(win)` + 回归测试（widget-window.test.ts 共 11 条绿）

## 7. 测试计划

| 层 | 文件 | 覆盖 |
|---|---|---|
| core | `packages/core/test/unit/app-port-registry.test.ts` | 多客户端 bind/pushEvent、close 出清、死端口容错、pushStatusTo 逐客户端 |
| main | `apps/desktop/src/main/widget-window.test.ts` | URL 构造（dev/prod）、`widgetCardSchema.parse` 入参校验、注册表同 messageId 去重/出清 |
| renderer | 现有 svelte 测试复跑 | `MicroAppControls` 抽取后 `micro-app-audio.svelte.test.ts` / `micro-app-gate.svelte.test.ts` / `consent.svelte.test.ts` 不回归 |

## 8. 遗留与不做

- 窗口位置/尺寸持久化（window-state）不做首版：组件窗口是临时查看面，默认居中即可（后续如需再接 window-state）。
- 托盘/菜单入口（「最近组件窗口」）不做；入口只有覆盖层按钮。
- 多窗口同卡并存不支持（§5 移交语义）；不同卡可各开各的窗口（注册表按 messageId 去重）。
