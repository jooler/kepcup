# KepCup 文档

| 目录 | 内容 | 读者 |
|---|---|---|
| [design/](design/README.md) | 产品与架构设计：做什么、为什么这样做，以及全部决策记录 | 所有人 |
| [dev/](dev/README.md) | 开发指导：工程规范、架构落地、数据模型、Agent 运行时规范、测试策略、分阶段开发计划与验收标准 | 执行开发的人或编程代理 |
| [guides/](guides/README.md) | 操作指南：可重复执行的工作怎么做（例如新增一家连接应用），含步骤、检查清单与常见陷阱 | 执行开发的人或编程代理 |

**优先级**：`design/` 是需求与决策的权威来源；`dev/` 是它的实现方案。两者冲突时以 `design/` 为准，并按 [dev/README.md](dev/README.md#偏差与问题) 的规则记录。

## 仓库结构

KepCup 是一个本地优先的 Bot 运行时桌面应用（Electron + Svelte 5 + TypeScript），以 pnpm monorepo 组织。当前实际结构如下（结构意图与模块规则见 [dev/01-conventions.md](dev/01-conventions.md#仓库结构)）：

```text
kepcup/
├── apps/
│   └── desktop/                  # @kepcup/desktop — Electron 桌面应用（产品唯一入口）
│       ├── src/main/             # 主进程：窗口、托盘、更新器与更新门控、登录启动项、DNS 解析、
│       │                         #   下载命名、Bot 浏览器页面托管、看护核心服务（core-host）
│       ├── src/core-entry/       # 核心服务进程入口（主进程经 utilityProcess.fork 启动，只负责启动 @kepcup/core）
│       ├── src/preload/          # contextBridge：向界面暴露 RPC 端口与少量平台调用
│       ├── src/renderer/         # Svelte 5 界面（Tailwind 4）
│       │   └── src/lib/
│       │       ├── features/     # 按功能组织：onboarding、chats、contacts、bot-panel、bot-setup、
│       │       │                 #   projects、approvals、right-panel、search、settings、shell、sidebar
│       │       ├── components/   # ui 组件（shadcn-svelte 生成，不手改）
│       │       ├── rpc/          # 调用核心服务的客户端与事件订阅
│       │       ├── stores/       # 界面状态（Svelte 5 runes）
│       │       ├── i18n/         # 界面文案（zh-CN）
│       │       └── hooks/ avatars/
│       ├── test/                 # Playwright e2e 测试（playwright.config.ts）
│       ├── scripts/              # 打包与本地度量脚本（dist.mjs、avatar-visual、measure-*、build-wsl-rootfs）
│       ├── resources/            # 打包进应用的二进制与图标
│       └── electron-builder.yml  # 打包配置
├── packages/
│   ├── shared/                   # @kepcup/shared — 跨进程共享的纯类型与契约（不依赖 Node/Electron API）
│   │   └── src/
│   │       ├── rpc/              # RPC 方法与事件的 zod 契约（birpc 双向通道）
│   │       ├── domain/           # 领域类型（Bot、Conversation、Message、Run …）
│   │       ├── browser/          # 浏览器工具的共享类型
│   │       └── ids.ts / errors.ts / constants.ts / update.ts   # ID 前缀、错误码、默认参数、更新
│   ├── core/                     # @kepcup/core — 核心服务：全部业务逻辑与数据（独立进程中运行）
│   │   ├── src/
│   │   │   ├── start.ts / create-core.ts / process-entry.ts    # 启动与组装：路径、日志、密钥、数据库、迁移、各服务、RPC
│   │   │   ├── infra/            # paths、logger、crypto、keystore、db、migrate、events、clock
│   │   │   ├── rpc/              # 把契约方法绑定到服务
│   │   │   ├── domain/           # bots、conversations、messages、drafts、attachments、projects、settings 等领域服务
│   │   │   ├── dispatch/         # 分发器：@ 解析、群聊判断、顺序执行、Bot 间 @ 连锁
│   │   │   ├── scheduler/        # 优先级调度、mailbox、厂商并发限制
│   │   │   ├── schedule/         # 定时任务：cron 解析、守护、持久化
│   │   │   ├── agent/            # AgentEngine（pi 系列库封装）、上下文组装、提示词模板
│   │   │   ├── tools/            # 工具定义与实现
│   │   │   ├── gateway/          # 工具网关：执行身份、路径检查、审批挂起、审计
│   │   │   ├── permissions/      # 授权、审批请求、命令白名单、无人值守模式
│   │   │   ├── sandbox/          # 沙箱后端（srt/wsl/lima/podman）与策略生成
│   │   │   ├── project/          # 写入租约、git 检查点、project 上下文
│   │   │   ├── memory/           # 记忆、用户画像、检索、各后台 loop（反思/整理/画像）
│   │   │   ├── wiki/             # Wiki：摄取、维护、全文检索
│   │   │   ├── skills/           # 技能：扫描、注册、生成
│   │   │   ├── media/            # 视觉、embedding、rerank 等媒体/模型服务
│   │   │   ├── env/              # 执行环境检测（doctor）与依赖安装
│   │   │   ├── browser/          # 浏览器工具 facade（页面实际由主进程托管）
│   │   │   └── usage/            # 用量预算
│   │   ├── migrations/           # 三个 SQLite 库（main / memory / runs）的 SQL 迁移
│   │   └── test/                 # vitest 单元测试
│   └── testkit/                  # @kepcup/testkit — 测试基建（直接以 src 源码被引用）：
│                                 #   mock-llm、假浏览器、假时钟、git/web/file server fixtures
├── docs/                         # 本目录：design/（产品与架构设计）、dev/（开发指导）
├── scripts/                      # 仓库级脚本：run-tests.mjs（vitest 编排）、generate-icons.mjs、measure-browser-dns.mjs
├── .github/workflows/            # ci.yml（lint / typecheck / test）、release.yml（构建与发布）
└── todo/                         # 待办与验收记录（如跨平台验收）
```

根目录其余文件为工程配置：`pnpm-workspace.yaml`（workspace 与构建许可）、`tsconfig.base.json`、`vitest.config.ts`（shared / core / testkit 三个测试工程）、`eslint.config.js`、`.prettierrc.json`。

几点约定：

- **依赖方向**：`desktop → core → shared`；`testkit` 依赖 core 与 shared，仅供测试使用，不进生产包。
- **编译产物**：`shared` 与 `core` 在运行时按包入口消费 `dist/` 编译产物，根目录 `pnpm dev` 会先重建两者再启动应用；`out/`（electron-vite 构建输出）、`release/`（打包产物）、`test-results/`（测试产物）均为生成目录，不入库。
- **测试**：单元测试为 vitest 三工程（shared / core / testkit），由 `scripts/run-tests.mjs` 编排；e2e 为 desktop 内的 Playwright（`pnpm test:e2e`）。
