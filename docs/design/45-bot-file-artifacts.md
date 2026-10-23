# Bot 文件卡片与预览（D95）

> 状态：**已实现**（2026-10-22）。对话里 Bot 创建 / 修改的本地文件以卡片列在回答下方，点击后在覆盖层中查看。

## 目标

Bot 在任务里写完文件后，用户不必去 Finder 找：回答下方直接列出本次涉及的文件，点开即可查看。卡片属于消息内容，重开对话后仍在。

**定位（与 Bot 组件的区别）**：文件卡片是 **Bot 根据用户要求修改或创建的本地文件的列表，方便用户在应用内查看**——文件是用户工作目录里的真实工件（`write` / `edit` 等工具实际写出的），卡片只登记路径作为入口，不复制字节、不改变文件归属。它与 Bot 组件（[32](32-bot-widgets.md)）不同：组件是 **Bot 生成并交付给用户的产品**，HTML 在库里版本化、按版本人工确认后运行、带 storage / query / openLink / reply 能力桥；文件卡的 HTML 预览只是把磁盘上已有的文件当网页打开（[47](47-file-webapp-viewer.md)），没有确认环节，页面也没有能力桥。两者的 HTML 运行档位相同（同款 sandbox 旗标与 CSP），定位与守门方式不同。

## 数据模型

`messageArtifactSchema`：

```ts
{ path: string; name: string; change: 'created' | 'modified'; size?: number }
```

- 文本消息的 `content.artifacts`：这一轮回答附带的文件（`ChatMessageRow` 在气泡下方渲染）。
- `task_event` 终态条目（`result` / `failure`）的 `content.artifacts`：任务实际写出的文件；对话轮转述任务结果时合并到回答消息。
- 路径是工具实际写入的绝对路径，文件字节不复制、不进模型上下文。

## 采集口径

- 采集：`write` / `edit` 文件工具；`generate_image` / `generate_speech` / `generate_video` 落盘产物。
- 暂不采集：`bash` 里间接写出的文件、外部 Agent 原生工具写入（无可靠路径信息）。这是第一期的明确边界，不静默伪装成「全部文件」。
- 同一文件在同一个 run 内多次写入去重，保留首次的 `created` / `modified`，大小取最新。

## 界面

- 回答下方卡片列表：图标按扩展名分类，显示文件名、类型、新建 / 修改、大小；超过 6 个折叠。
- 覆盖层：占满中部 + 右栏（左栏保持可交互），左上角圆形关闭按钮与左栏顶部按钮同一样式；Esc 关闭，打开时聚焦关闭按钮，切换会话时自动关闭。
- 类型：图片 / 视频；HTML（完整 WebApp 档：在 `kepcup-file://` 独占源的沙箱 iframe 里运行，脚本、网络、相对路径多文件、localStorage 全可用，外链转交系统浏览器，见 [47](47-file-webapp-viewer.md)；2026-10 前为静态渲染）；Markdown；DOCX（mammoth）；XLSX / XLS / ODS / CSV（SheetJS 0.20.3）；文本 / 代码。
- PDF 使用 Chromium 内置查看器（`plugins: true` + `object-src 'self' blob:`）直接内嵌；PPTX 等无内置渲染器的格式显示操作面板：用系统程序打开 / 下载 / 在文件夹中显示。

## 读取与安全

- RPC `files.preview` 只接受 `hasArtifactPath(conversationId, path)` 命中的文件；不开放数据目录、历史 workdir 或任意路径。HTML 走 `files.previewSession` / `files.previewResource`（[47](47-file-webapp-viewer.md)），同一归属校验，另加所在目录的范围校验。
- 路径先经 `canonicalPath`；符号链接解析后的目标必须仍等于消息里登记的路径，否则 `PATH_OUT_OF_SCOPE`。
- 异步读取；按类型限制字节数（文本 8MB、Office 12MB、图片 24MB、PDF 32MB、视频 48MB），避免大文件 base64 阻塞主进程。
- 打开 / 显示文件由主进程 `shell.openPath` / `showItemInFolder` 完成，渲染层只传绝对路径。

## 未做

- PDF 解析由 Chromium 内置查看器负责（已实测 Electron 44 的 blob URL 内嵌可用）。
- `bash` / 外部 Agent 的文件产出追踪。
- 文件内容变更后的自动刷新（覆盖层每次打开重新读取）。
