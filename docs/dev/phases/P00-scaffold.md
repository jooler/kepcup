# P00 工程骨架与基础设施

## 目标

搭建可在三个平台运行的空应用：三栏界面骨架、常驻的核心服务、进程间通信、数据目录、加密数据库、钥匙串、日志、CI。后续所有阶段都在此基础上开发。

## 依赖

无。

## 设计依据

- [design/07-local-runtime.md](../../design/07-local-runtime.md)（进程结构）
- [design/09-tech-stack.md](../../design/09-tech-stack.md)（技术选型）
- [design/11-storage.md](../../design/11-storage.md)（数据目录、加密）
- [design/12-ui-layout.md](../../design/12-ui-layout.md)（布局与视觉风格）
- [01-conventions.md](../01-conventions.md)、[02-architecture.md](../02-architecture.md)、[05-testing.md](../05-testing.md)

## 范围

包含：

- pnpm monorepo：`apps/desktop`、`packages/shared`、`packages/core`、`packages/testkit`。
- Electron 应用：主进程、preload、界面、核心服务入口（`utilityProcess`）。
- 托盘常驻：关闭窗口不退出；托盘菜单“打开窗口”“退出”。
- 进程间通信：端口 A、端口 B、少量 ipc，birpc + zod 契约；方法 `system.ping`、`system.info`；事件 `core.status`。
- 核心服务崩溃后自动重启与界面重连。
- 数据目录与 `KEPCUP_HOME` 覆盖。
- 日志（pino）与脱敏器。
- 钥匙串（`@napi-rs/keyring`，Linux 强制 Secret Service）、测试用内存实现、主密钥生成与读取、`locked` 状态。
- 加密工具：HKDF 派生、AES-256-GCM 加解密。
- 数据库层：打开加密库、PRAGMA、迁移执行器；`main.db` 的 `settings` 表，`runs.db` 的空迁移。
- 界面：Tailwind v4 + shadcn-svelte 初始化，浅色 / 深色主题（跟随系统），三栏骨架（左栏 Sidebar，底部头像菜单占位；中栏空状态；右栏占位；中右两栏可拖拽调整宽度）。
- 界面文案机制（`i18n/zh-CN.ts`）。
- testkit：模拟模型服务的基本框架（能启动、能编排文本回复、能记录请求），供 P01 使用。
- CI：三个平台的 lint、类型检查、单元与集成测试。

不包含：

- 任何业务功能（Bot、对话、消息）。
- 打包签名、自动更新、开机自启（P13）。

## 任务

1. **仓库初始化**
   - 根 `package.json` 脚本：`dev`、`build`、`lint`、`typecheck`、`test`、`test:e2e`。
   - `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、ESM。
   - ESLint、Prettier、svelte-check 配置。
2. **Electron 应用**（`apps/desktop`）
   - electron-vite 配置：主进程构建包含两个入口：`src/main/index.ts` 与 `src/core-entry/index.ts`。
   - 选定 Electron 版本（内置 Node ≥ 22.19），锁定精确版本。
   - 主进程：单实例锁（`app.requestSingleInstanceLock`）；托盘；窗口创建与关闭行为；`utilityProcess.fork` 启动核心服务；端口建立与转交；崩溃重启策略（[02-architecture.md](../02-architecture.md#启动退出与崩溃恢复)）。
   - preload：`contextBridge` 暴露 `getCorePort()` 与 `platform.*`（本阶段只需 `platform.info()`）。
   - 界面安全配置：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；CSP 禁止远程脚本。
3. **RPC**（`packages/shared/src/rpc`、`packages/core/src/rpc`、`apps/desktop/src/renderer/src/lib/rpc`）
   - 契约格式与 zod 校验中间件。
   - 界面侧客户端：连接、断线检测、重连、事件订阅接口。
4. **核心服务基础设施**（`packages/core/src/infra`）
   - `paths.ts`：所有数据目录路径的唯一来源。
   - `logger.ts`：pino，按天滚动，保留 14 天，脱敏器。
   - `keystore.ts`：接口 `get/set/delete`；实现：`@napi-rs/keyring`（服务名 `kepcup`，账户 `master-key`）；Linux 固定使用 Secret Service，不可用时返回 `KEYSTORE_UNAVAILABLE`；测试用内存实现（仅 `NODE_ENV=test`）。
   - `crypto.ts`：`hkdf(masterKey, info)`、`seal/open`（AES-256-GCM，附加认证数据参数）。
   - `db.ts`：打开加密库（ChaCha20-Poly1305）、设置 PRAGMA、关闭；`migrate.ts`：按 `user_version` 执行迁移。
   - `start.ts`：启动顺序（[02-architecture.md](../02-architecture.md#启动退出与崩溃恢复)）；首次运行生成主密钥；**已有数据库但取不到密钥时进入 `locked`，不得生成新密钥**。
   - `clock.ts`、`events.ts`（进程内事件总线）。
5. **界面骨架**
   - shadcn-svelte 初始化（CLI）；添加 Sidebar、Resizable、Dropdown Menu、Avatar、Button、Tooltip、Sonner。
   - `App.svelte`：三栏布局；左栏底部头像点击弹出菜单（设置、通讯录，均为占位页）；中栏空状态“选择或开始一个对话”；右栏占位；右栏可折叠。
   - 顶部横幅组件（用于“正在重新连接”，后续也用于无人值守模式）。
   - 核心服务状态显示：`locked` 时显示原因页面。
6. **testkit**：模拟模型服务框架（OpenAI 兼容流式接口、按模型 id 编排、请求记录、`hold/release`）；本阶段实现文本回复与 tool call 回复即可。
7. **CI**：`.github/workflows/ci.yml`，矩阵见 [05-testing.md](../05-testing.md#ci-矩阵)。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| `utilityProcess` 中加载 better-sqlite3-multiple-ciphers、`@napi-rs/keyring` | 三个平台上启动应用，核心服务成功打开数据库、读写钥匙串 |
| 用 Electron 作为 Node 运行 vitest 并加载原生模块 | `pnpm test` 在三个平台的 CI 中通过 |
| better-sqlite3-multiple-ciphers 的 ChaCha20 加密 PRAGMA 写法 | 加密后用普通 sqlite3 命令行打开失败；带密钥打开成功 |
| Electron 内置 Node 版本 ≥ 22.19 | `system.info` 返回 `process.versions.node` |
| Linux 上 `@napi-rs/keyring` 固定使用 Secret Service，不退回内核密钥环 | 在无 Secret Service 的环境中返回 `KEYSTORE_UNAVAILABLE` |

## 接口与数据

- RPC 方法：`system.ping() → { pong: true, ts }`、`system.info() → { version, platform, arch, nodeVersion, dataDir, coreStatus }`。
- 事件：`core.status`（`starting | ready | locked | error`，含原因）。
- 数据：`main.db` 迁移 `0001_settings.sql`；`runs.db` 迁移 `0001_init.sql`（可为空表结构占位）。

## 测试要求

- 单元：`crypto`（派生结果稳定、加解密往返、篡改检测）、`migrate`（按顺序执行、幂等）、脱敏器、`paths`（`KEPCUP_HOME` 覆盖）。
- 集成：`createCore()` 启动 → ping；首次运行生成密钥并建库；第二次启动读取同一密钥；删除内存钥匙串中的密钥后启动进入 `locked` 且数据库文件未被改动。
- 安全用例：数据库文件不带密钥无法打开。
- 端到端（可在 P01 加入 CI，本阶段本地通过即可）：应用启动显示三栏骨架。

## 验收标准

- [ ] 三个平台上 `pnpm install && pnpm dev` 可以启动应用，显示三栏骨架，深浅色随系统切换。
- [ ] 界面调用 `system.ping` 成功；`system.info` 显示 Node 版本 ≥ 22.19。
- [ ] 关闭窗口后应用仍在托盘中运行，核心服务进程存活；托盘“打开窗口”恢复窗口；托盘“退出”后所有进程退出（5 秒内）。
- [ ] 重复启动应用只激活已有窗口（单实例）。
- [ ] 手动结束核心服务进程后，2 秒内自动重启，界面显示“正在重新连接”并自动恢复。
- [ ] 首次启动创建 `~/.kepcup/`（或 `KEPCUP_HOME` 指定的目录），包含 `main.db`、`runs.db`、`logs/`。
- [ ] `main.db` 无法用不带密钥的 SQLite 打开。
- [ ] 主密钥存于系统钥匙串；钥匙串中的密钥被删除后，应用显示 `locked` 页面，数据库文件未被修改。
- [ ] 日志中键名为 `apiKey`、`token` 等的字段显示为 `[REDACTED]`。
- [ ] CI 在三个平台通过。
- [ ] 需验证技术点全部有结论并记录在 PROGRESS.md。

## 注意事项

- 界面组件全部通过 shadcn-svelte CLI 添加到 `components/ui/`，不手改其中文件；需要定制时在外层包装。
- 主进程不写业务逻辑；本阶段也不要为后续阶段预先写业务代码。
- 不要在任何地方打印主密钥或派生密钥，包括调试日志。
