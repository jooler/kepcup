# 47 文件目录预览协议（kepcup-file，「完整 WebApp 档」）

状态：已定稿并实施（2026-10）。关联：32-bot-widgets.md §13（组件同款档位）、45-bot-file-artifacts.md（文件卡）、38/D73 apps-ui 管线（隔离模式来源）。

## 1 背景与目标

FileViewer 浏览 Bot 产出的 HTML 时，原实现是 `<iframe sandbox="" srcdoc>`：脚本不执行、相对路径资源全挂、单文件 base64 上限 8MB、父页 CSP 继承。目标：**像浏览器开了一个本地网站**——脚本、网络（fetch / WebSocket / CDN）、相对路径多文件、localStorage、表单、对话框全部可用；同时页面代码不能逃逸影响宿主应用。

**与 Bot 组件的关系**：本协议让文件卡的 HTML 预览与 Bot 组件（32 §13）处于同一运行档位——同款 sandbox 旗标，`fileAppResponseHeaders` 直接复用 `buildWidgetRuntimeCspHeader()`。但同档位只说明「页面在 iframe 里能做的事一样」，不说明两者是同一种东西：**组件是 Bot 生成并交付给用户的产品**（HTML 在库里版本化、按版本人工确认后运行、带 storage / query / openLink / reply 能力桥；单文件，源为 `kepcup-app://widget-{hash}`）；**文件卡是 Bot 根据用户要求修改或创建的本地文件的列表，方便用户在应用内查看**（文件是用户工作目录里的真实工件，预览只校验 artifact 归属，无确认环节、页面无能力桥；目录树按相对路径供数、同 token 可自导航、外链唯一出口是系统浏览器）。

## 2 方案

自定义协议 `kepcup-file://`（standard + secure + supportFetchAPI，corsEnabled 关），注册在宿主 session（与 `kepcup-app` 同一次 `registerSchemesAsPrivileged`，`app.ready` 前）。页面源 = `kepcup-file://{token}/{相对路径}`：

- **token** = `f` + sha256(canonical 绝对路径) 前 24 hex（core 侧 `filePreviewTokenOf`）。可复现：重开同一文件 = 同一源 → localStorage 延续；不同文件 = 不同源 → 互相隔离。
- **会话登记**：渲染端打开 FileViewer 时调 app RPC `files.previewSession {conversationId, path}`；core 校验「该对话文件卡登记过的 artifact」（`hasArtifactPath`，兼符号链接防护）后在内存登记 `{token → 所在目录}`（滑动 TTL 30min + LRU 64 条，模式同 widgets resource-store），返回 `{token, size}`。
- **取资源**：主进程协议 handler（`installFileAppProtocol`，default session）对每个 GET 调平台 RPC `files.previewResource {token, rel}`；core 解析 `join(root, rel)` → `canonicalPath` → `isInsidePath(root, …)`（防 `..` 与符号链接逃逸）→ stat isFile → 64MB 上限 → base64 回传；MIME 按 Web 资产扩展名表。
- **渲染端**：FileViewer 的 html 分支不再走 `files.preview` 字节通道；iframe `src = kepcup-file://{token}/{encodeURIComponent(入口文件名)}`，`sandbox="allow-scripts allow-same-origin allow-forms allow-modals"`。主窗口 CSP `frame-src` 追加 `kepcup-file:`。

## 3 信任边界（为什么 allow-same-origin 是安全的）

`allow-scripts + allow-same-origin` 的经典警告只在 iframe 与嵌入方**同源**时成立（能反改自己的 sandbox 属性去碰父级）。这里 iframe 源是独占的 `kepcup-file://{token}`，与宿主（file:// / dev server）不同源：

- 碰不到父窗口 DOM 与 `window.kepcup`（preload 只注入主框架；主窗口 `sandbox:true + nodeIntegration:false + contextIsolation:true`）；
- 跨 token 跨源读不到彼此（协议响应无 CORS 头；`corsEnabled: false`）；
- 无弹窗（无 allow-popups + `setWindowOpenHandler` deny）、无顶层导航（无 allow-top-navigation + `will-navigate` 拦截 + 导航守卫）、无下载（无 allow-downloads）；
- 浏览器权限（摄像头等）：default session 权限白名单只认应用自身 origin，协议源全拒；响应头 Permissions-Policy 再拒一道；
- **网络是明示给出的**：页面可 fetch 任意 https、可探测 localhost——这就是「完整 WebApp」的语义本身；UI 不再显示旧的「不执行脚本」警告条。

**导航守卫**（`appFrameNavigationVerdict`，覆盖两个协议）：kepcup-file 帧允许**同 token** 自我导航（多页面 WebApp），跨 token / 跳两个特权协议拦；kepcup-app 帧维持全拦；顶层窗口禁止导航到任一特权协议；首次加载（about:blank）放行，内容由 `frame-src` 决定。URL 解析（`parseFileAppUrl`）严格：token 形状、段解码、拒 `..` 段 / 反斜杠 / 凭据 / 端口 / 空段——WHATWG 解析器本身会把点段收敛在 token 根内（Web 根即根，跳不出去），core 的 `isInsidePath` 再兜底。

**外链转交系统浏览器**（2026-10 追加）：预览页里点外站链接不应静默失效——「像浏览器开了一个网站」的语义包括链接能出去。两条通路：① 锚点点击**优先**走主进程注入 kepcup-file 帧的外链桥接脚本（`externalLinkBridgeScript`，与滚动条兜底同挂法、各自独立 executeJavaScript）——sandbox 无 allow-popups，`target=_blank` 的点击在 Blink 层就被静默吞掉、导航守卫收不到，只能帧内拦截：白名单 scheme 的锚点点击 preventDefault 后 `postMessage` 给宿主渲染层（`FILE_APP_OPEN_EXTERNAL_MESSAGE`），FileViewer 校验 `event.source` / origin 后经 `shell:openExternal` 打开（主进程再验一次白名单）；脚本只装在顶层预览帧（`parent===top`），带凭据 URL 不拦（与白名单一致地让它落回守卫静默拦）；② 程序化同帧跳转（JS `location.href`、表单提交、meta refresh）与桥接缺位时的兜底由导航守卫接手：verdict `open-external` → 拦下导航并直接 `shell.openExternal`。两条通路共用 `isOpenablePreviewLinkUrl` 白名单（http / https 任意主机 + mailto + tel，拒凭据；与 `shell-methods` 的 OAuth 白名单（https 外加回环 http）相互独立——这里是用户点击语义）与每 webContents 令牌桶限流（`createOpenExternalRateLimiter`，容量 4、每 10s 回 1，guard 与 IPC 共用）——页面不需要手势也能走到 `shell.openExternal`，限流兜住「onload 循环无限弹系统浏览器」。同 token 页内跳转不拦；`window.open` 与白名单外 scheme（自定义协议等）维持静默拦截。

## 4 响应头

`fileAppResponseHeaders(mime)`：`content-type` + CSP 只保留 `sandbox`（与 iframe 属性同旗标）与 `frame-ancestors file: http://localhost:*`（其余资源 / 网络指令全部不设——完整 WebApp 档）+ `nosniff` + `no-store` + `referrer-policy: no-referrer` + Permissions-Policy 拒摄像头等。

## 5 已知边界

- core 重启丢会话表：协议侧 404，页面资源加载失败；重新打开 FileViewer 即重建（渲染端每次打开都先调 previewSession）。
- 页面触发的下载被 sandbox 静默拦截（不给 allow-downloads）；default session 本期不加 will-download 处理。
- 外链只放行 http / https / mailto / tel：`window.open`、自定义 scheme（`vscode:` 等）、带凭据 URL 与非白名单跳转维持静默拦截；同 token 页内跳转带 `target=_blank`（sandbox 吞掉弹窗）与修饰键 / 中键点击外链是死链；预览页内嵌的第三方 iframe 内部点击不走桥接（注入只落顶层 kepcup-file 帧）；限流超限时打开被静默放弃。
- 大于 64MB 的单文件资源 404（`INVALID_INPUT` 记日志）。
- Range 请求不支持（视频 seek 从头加载）；按需再补。

## 6 测试

- `apps/desktop/src/main/apps-ui-policy.test.ts`：URL 解析（含点段收敛 / 拒绝表）、导航守卫（同 token 放行 / 跨 token / 顶层 / 首次加载 / 外链 open-external 判定）、外链白名单、桥接脚本形状、外链限流、响应头。
- `packages/core/test/unit/files-preview-bindings.test.ts`：token 派生、MIME 表、会话校验（PATH_OUT_OF_SCOPE / NOT_FOUND）、穿越与符号链接拒收。
- 桌面渲染层：FileViewer html 分支 typecheck（svelte-check）；端到端手工验证清单见 docs/dev。
