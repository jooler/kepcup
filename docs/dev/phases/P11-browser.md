# P11 浏览器工具

## 目标

每个 Bot 默认具备浏览任意网页的能力：打开网页、读取页面、点击、输入、滚动、截图、下载。浏览器基于 Electron 内置的 Chromium，每个 Bot 使用独立的浏览器会话；绑定 project 的对话中可以访问本机端口测试开发服务器；用户可以打开 Bot 的浏览器窗口实时查看。

## 依赖

P04。

## 设计依据

- [design/14-models-and-browser.md](../../design/14-models-and-browser.md#浏览器工具)（实现、隔离、网络、可见性）
- [design/06-isolation-and-storage.md](../../design/06-isolation-and-storage.md#信任隔离防提示注入与记忆污染)（页面内容为不可信输入）
- [02-architecture.md](../02-architecture.md#进程间通信)（端口 B）

## 范围

包含：

- 主进程的浏览器托管：每个 Bot 一个会话分区 `persist:bot-{botId}`（数据位于 `bots/{id}/browser/`），每个“Bot + 对话”一个页面（`WebContentsView`），默认不显示。
- 通过 `webContents.debugger`（CDP）控制页面；**不开启远程调试端口**。
- 核心服务经端口 B 调用浏览器能力；工具在核心服务中定义。
- 工具：`browser_open`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_press`、`browser_scroll`、`browser_screenshot`、`browser_back`、`browser_close`。
- 网络规则：公网可访问；本机端口仅在对话绑定 project 时可访问；其他内网地址、链路本地地址、元数据地址拦截。
- 下载：保存到当前 workspace 的 `downloads/`。
- “查看 Bot 的浏览器”：从右栏或执行步骤打开一个可见窗口，显示该 Bot 在当前对话中的页面；用户可以在其中手动登录。
- 页面内容以 `<untrusted>` 返回；截图作为图片返回给支持图像输入的模型（不支持时只返回页面快照文本）。
- 生命周期：删除 Bot 时清理会话数据与页面；删除对话时关闭对应页面。

不包含：

- 使用用户自己浏览器的登录状态（设计决定为完全隔离）。

## 任务

1. **主进程浏览器宿主**（`apps/desktop/src/main/browser-host.ts`）
   - `ensurePage(botId, conversationId)`：创建或返回页面；页面挂在一个隐藏窗口中（离屏但保持渲染）。
   - 会话配置：独立分区；禁用通知、地理位置、摄像头、麦克风等权限请求（一律拒绝）；禁用弹窗（新窗口在同一页面打开）。
   - 下载：`will-download` 事件中把保存路径设为核心服务提供的 workspace 路径。
2. **网络拦截**（`browser-host.ts`）：`session.webRequest.onBeforeRequest` 中解析主机名（`dns.lookup` 获取全部地址），任一地址属于拦截范围则取消请求；本机地址是否放行取决于该页面所属对话是否绑定 project（核心服务在 `ensurePage` 时传入，project 变化时更新）。
3. **CDP 操作**（`browser-host.ts`）
   - `snapshot`：通过 `Accessibility.getFullAXTree` 生成可交互元素列表，每个元素分配短引用（例如 `e12`），同时返回页面标题、URL、主要文本（截断）。
   - `click(ref)`、`type(ref, text)`、`press(key)`、`scroll(direction, amount)`：按引用定位元素（引用在下一次快照前有效）。
   - `screenshot`：`Page.captureScreenshot`，限制尺寸。
4. **工具**（`packages/core/src/tools/browser.ts`）：参数校验、结果截断与 `<untrusted>` 包装、步骤说明（“正在打开 example.com”）；每次操作后自动返回新的快照摘要，减少模型调用次数。
5. **查看窗口**：界面通过 ipc 请求主进程把该页面移入一个可见窗口；关闭窗口后页面回到隐藏状态，不中断 Bot 操作。
6. **生命周期**：删除 Bot → 关闭该 Bot 所有页面、清除分区数据、删除 `bots/{id}/browser/`；删除对话 → 关闭对应页面。

## 接口与数据

- 端口 B 新增方法：`browser.ensurePage`、`browser.navigate`、`browser.snapshot`、`browser.click`、`browser.type`、`browser.press`、`browser.scroll`、`browser.screenshot`、`browser.back`、`browser.close`、`browser.setNetworkContext`、`browser.clearBotData`。
- ipc（界面 → 主进程）：`browser.show(botId, conversationId)`。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| 隐藏窗口中的 `WebContentsView` 能正常渲染、截图 | 截图非空白 |
| `onBeforeRequest` 中异步 DNS 解析的可行性与延迟 | 访问公网页面的额外延迟 < 50ms（有缓存时） |
| `Accessibility.getFullAXTree` 在复杂页面上的输出规模 | 对 3 个大型网站测量，确定截断策略 |

## 测试要求

- 集成（使用本地测试网页服务）：打开、快照、点击、输入、提交表单、下载到 workspace；不同 Bot 的 cookie 互相不可见；同一 Bot 在不同对话中共享登录状态（同一分区）。
- 网络：访问 `127.0.0.1` 在未绑定 project 的对话中被拦截、绑定后放行；访问 `192.168.x.x`、`169.254.169.254` 始终被拦截。
- 端到端：打开“查看 Bot 的浏览器”窗口，显示 Bot 当前页面。
- 删除 Bot 后其分区数据不存在。

## 验收标准

- [ ] Bot 无需任何安装就能浏览网页并根据页面内容回答。
- [ ] Bot 能完成简单的网页操作（搜索、填写表单、点击链接），下载的文件出现在 workspace 中。
- [ ] 每个 Bot 的浏览器会话相互隔离，与用户自己的浏览器无关。
- [ ] 绑定 project 的对话中，Bot 能打开本机开发服务器页面；其他内网地址始终被拦截。
- [ ] 用户可以打开窗口实时查看 Bot 的浏览器，并在其中手动登录。
- [ ] 删除 Bot 时清理其浏览器数据。
- [ ] 本阶段测试全部通过。

## 注意事项

- 主进程只提供浏览器能力，不决定是否允许某个 Bot 使用；权限判断在核心服务的工具与网关中完成。
- 页面中的文本、标题、元素名称都可能包含诱导指令，一律按不可信输入返回。
