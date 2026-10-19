# KepCup

<p align="center">
  <img src="apps/desktop/resources/sidebar/logo-light.svg" alt="KepCup" width="120" />
</p>

<p align="center"><strong>本地优先的 Bot 运行时桌面应用</strong></p>

<p align="center">
  <a href="https://kepcup.app">kepcup.app</a> ·
  <a href="docs/README.md">文档</a> ·
  <a href="docs/releases/v0.1.0.md">v0.1.0 发行说明</a> ·
  <a href="LICENSE">GPL-3.0</a>
</p>

KepCup 让你在本机创建并调度多个有独立人格、记忆与工具面的 AI 联系人（Bot）。对话、记忆、知识库与执行环境都留在本地；Bot 在你给定的权限与工作目录里读写文件、跑命令、连应用、做长任务。

当前首发内测版为 **0.1.0**（macOS / Windows / Linux）。产品定位与决策见 [docs/design/](docs/design/README.md)；工程落地见 [docs/dev/](docs/dev/README.md)。

## 能力一览

- **多 Bot 对话与协作**：一对一与项目组，`@` 触发与 Bot 连锁；负责人路由、共享上下文与写入租约
- **执行与工具**：文件 / 命令 / Git，经统一工具网关做身份、路径检查、审批与审计；可配置沙箱
- **记忆与 Wiki**：长期记忆与用户画像；Wiki 摄取 / 维护 / 全文检索；本地向量（默认 Jina Embeddings v2 base-zh）
- **技能与扩展**：预置与按需技能；连接应用（MCP + OAuth）；邮件通道；扩展中心
- **外部智能体（可选）**：经 ACP 接入用户本机已安装的 Claude Code / Codex / Cursor / OpenCode / DeepSeek Harness 等 peer CLI
- **桌面壳**：Electron + Svelte 5，中文界面，三栏布局；应用内自动更新

更完整的版本说明见 [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md)。

## 仓库结构（简）

```text
kepcup/
├── apps/desktop/     # Electron 桌面应用（产品入口）
├── packages/core/    # 业务逻辑与数据（独立进程）
├── packages/shared/  # 跨进程契约与类型
├── packages/testkit/ # 测试基建
├── docs/             # design / dev / guides / releases
└── infra/            # Cloudflare 等配套
```

细节与模块规则见 [docs/dev/01-conventions.md](docs/dev/01-conventions.md) 与 [docs/README.md](docs/README.md)。

## 开发

需要 **Node.js ≥ 22.19** 与 **pnpm@11.22.0**（见根 `packageManager`）。

```bash
pnpm install
pnpm dev          # 先构建 shared/core，再启动桌面应用
pnpm test         # 单元 / 集成（见 AGENTS.md：迭代中请先定向跑）
pnpm test:e2e     # Playwright e2e（@kepcup/desktop）
```

编程代理约定见 [AGENTS.md](AGENTS.md)。

## 许可

本仓库根许可为 [GPL-3.0](LICENSE)。预置技能中 vendored 的 MinerU 技能单独以 AGPL-3.0 再分发，说明见 [apps/desktop/resources/preset-skills/NOTICE.md](apps/desktop/resources/preset-skills/NOTICE.md)。仓库级 NOTICE 尚未单列。

---

## Thanks

KepCup 站在许多开源项目与产品灵感之上。以下致谢**不暗示**任何商标方的背书或隶属关系；标志与名称分属各自权利人。

### 产品灵感

感谢 **Grok Bot**（xAI / Cursor 产品线）提供的产品创意灵感——对话式 Bot、三栏布局与扁平 UI（见设计决策 [D46](docs/design/README.md) 与 [12-ui-layout.md](docs/design/12-ui-layout.md)）。KepCup 是独立实现，并非 Grok Bot 的官方衍生或附属产品。

<!-- PENDING_GROK_BOT_LOGO: full-width horizontal Grok Bot logo.
     Awaiting an official asset confirmed for third-party README use
     (xAI/Cursor brand guidelines: official provided assets only, no
     alteration, no endorsement implication). Do not substitute
     unofficial SVGs (e.g. asvg.app) or reconstructed marks. -->

*PENDING — Grok Bot 满宽横版 logo：待 Pengfei 提供经官方确认、可在第三方 README 使用的素材后替换本占位。*

想法上亦参考过 [Rakazo](https://github.com/elie222/rakazo)、[OpenMuse](https://github.com/CopilotKit/OpenMuse)、[OpenDots](https://github.com/CopilotKit/OpenDots) 等本地 / 自托管助手路线；它们**不是**本仓库的运行时依赖，故不进入下方开源矩阵。

### 开源依赖（logo 矩阵）

v1 仅用**名称 + 上游链接**（权属与品牌授权未单独确认前，不嵌入第三方图形标志；亦不使用非官方 logo CDN）。建议阅读顺序：

[Electron](https://github.com/electron/electron) ·
[Svelte](https://svelte.dev) ·
[TypeScript](https://www.typescriptlang.org) ·
[Vite](https://vite.dev) ·
[Tailwind CSS](https://tailwindcss.com) ·
[shadcn-svelte](https://www.shadcn-svelte.com) ·
[TipTap](https://tiptap.dev) ·
[Lucide](https://lucide.dev) ·
[pi](https://github.com/earendil-works/pi) ·
[MCP](https://modelcontextprotocol.io) ·
[ACP](https://agentclientprotocol.com) ·
[Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) ·
[SQLite](https://sqlite.org) ·
[sqlite-vec](https://github.com/asg017/sqlite-vec) ·
[ONNX Runtime](https://onnxruntime.ai) ·
[Jina Embeddings v2 base-zh](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh) ·
[Zod](https://zod.dev) ·
[electron-builder](https://github.com/electron-userland/electron-builder) ·
[MinerU](https://github.com/opendatalab/MinerU) ·
[Nodemailer](https://nodemailer.com) ·
[es-git](https://github.com/toss/es-git)

### 依赖列表

#### Tier 1 — 平台与构建

| | 项目 | 用途 |
| --- | --- | --- |
| | [Electron](https://github.com/electron/electron) | 桌面壳；Bot 浏览器经 `webContents` + CDP |
| | [Node.js](https://nodejs.org) | 运行时（`engines.node` ≥ 22.19） |
| | [TypeScript](https://www.typescriptlang.org) | 全仓语言 |
| | [Vite](https://vite.dev) + [electron-vite](https://electron-vite.org) | 桌面构建与 HMR |
| | [pnpm](https://pnpm.io) | Monorepo（`pnpm@11.22.0`） |
| | [electron-builder](https://github.com/electron-userland/electron-builder) / electron-updater | 打包与应用内更新 |

（Chromium 随 Electron 提供，不单列。）

#### Tier 2 — 界面

| | 项目 | 用途 |
| --- | --- | --- |
| | [Svelte 5](https://svelte.dev) | 渲染进程 UI |
| | [Tailwind CSS 4](https://tailwindcss.com) | 样式 |
| | [shadcn-svelte](https://www.shadcn-svelte.com)（[+ bits-ui](https://github.com/huntabyte/bits-ui)） | 组件基座 |
| | [Lucide](https://lucide.dev) | 图标 |
| | [TipTap](https://tiptap.dev) | 输入区富文本 / Composer |
| | [streamdown-svelte](https://github.com/PacificStudio/streamdown-svelte) | 流式 Markdown |
| | [Paneforge](https://github.com/svecosystem/paneforge) | 可拖拽分栏 |
| | [mode-watcher](https://github.com/svecosystem/mode-watcher) / [svelte-sonner](https://github.com/wobsoriano/svelte-sonner) | 主题与 Toast |
| | [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs)（+ Shiki） | Diff 展示 |

#### Tier 3 — AI / 协议 / 沙箱

| | 项目 | 用途 |
| --- | --- | --- |
| | [pi](https://github.com/earendil-works/pi)（`@earendil-works/pi-*`） | 内置双 loop、工具与 MCP 包装 |
| | [ACP](https://agentclientprotocol.com)（`@agentclientprotocol/sdk`） | 外部智能体协议 |
| | [MCP](https://modelcontextprotocol.io)（`@modelcontextprotocol/sdk`） | 工具服务器与连接应用 |
| | [Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime) | 默认沙箱后端（srt） |
| | [ONNX Runtime](https://onnxruntime.ai) | 本地 embedding 推理（按需安装） |
| | [Jina Embeddings v2 base-zh](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh) | 默认本地记忆向量（Apache-2.0） |

#### Tier 4 — 数据 / 邮件 / 工具库

| | 项目 | 用途 |
| --- | --- | --- |
| | [SQLite](https://sqlite.org)（+ [better-sqlite3-multiple-ciphers](https://github.com/m4heshd/better-sqlite3-multiple-ciphers)） | 加密本地库与 FTS5 |
| | [sqlite-vec](https://github.com/asg017/sqlite-vec) | 向量扩展 |
| | [es-git](https://github.com/toss/es-git) | Wiki / 技能 / 检查点的 Git 操作 |
| | [@napi-rs/keyring](https://github.com/napi-rs/keyring) | 系统钥匙串存放 DB 主密钥 |
| | [ImapFlow](https://imapflow.com) / [Nodemailer](https://nodemailer.com) / [mailparser](https://github.com/nodemailer/mailparser) | 扩展中心邮件通道 |
| | [Zod](https://zod.dev) | 运行时校验与 RPC 契约 |
| | [birpc](https://github.com/antfu-collective/birpc) | 主进程 ↔ core RPC |
| | [undici](https://undici.nodejs.org) | HTTP |
| | [MinerU](https://github.com/opendatalab/MinerU) | 文档解析预置技能（AGPL-3.0；见 [NOTICE](apps/desktop/resources/preset-skills/NOTICE.md)） |
| | [cron-parser](https://github.com/harrisiirak/cron-parser)；[bash-parser](https://github.com/vorpaljs/bash-parser) + [acorn](https://github.com/acornjs/acorn)；[pino](https://github.com/pinojs/pino) / [ulid](https://github.com/ulid/javascript) | 定时、命令解析、日志与 ID |

以及我们传递依赖的各位维护者（ESLint / Prettier / Vitest / `@types`、纯工具库如 `clsx` / `tailwind-merge` 等刻意不逐条展开；Playwright 仅用于 e2e，产品内浏览器是 Electron CDP）。

### Optional ACP agents（user-installed peers）

下列产品**不是** npm 依赖，也不进入上方开源 logo 矩阵。用户可在本机安装后，经 ACP 作为可选 peer CLI 接入 KepCup（见 [docs/design/28-external-agents-acp.md](docs/design/28-external-agents-acp.md)）：

- Claude Code
- Codex
- Cursor
- OpenCode
- DeepSeek Harness

### 可选沙箱增强（非 npm）

默认沙箱为 Anthropic Sandbox Runtime。平台上还可选 [Lima](https://lima-vm.io)（macOS）、rootless [Podman](https://podman.io)（Linux）或 Linux 上的 [bubblewrap](https://github.com/containers/bubblewrap) 等增强路径；它们由环境检测 / 文档引导，不是本仓库的 package 依赖。详见 [docs/design/10-sandbox.md](docs/design/10-sandbox.md)。
