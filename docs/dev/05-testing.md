# 05 测试策略

## 测试分层

| 层 | 范围 | 工具 | 位置 |
|---|---|---|---|
| 单元测试 | 纯函数、解析器、策略生成、上下文组装、白名单匹配、租约冲突判定 | vitest | 各包 `test/unit/` |
| 集成测试 | 核心服务的服务层 + 真实数据库（临时目录）+ 模拟模型服务 | vitest | `packages/core/test/integration/` |
| 沙箱测试 | 真实沙箱中的逃逸用例与网络用例 | vitest（按平台条件执行） | `packages/core/test/sandbox/` |
| 端到端测试 | 启动打包前的 Electron 应用，模拟用户操作界面 | Playwright（`_electron`） | `apps/desktop/test/e2e/` |
| 手工冒烟 | 使用真实模型厂商 | 检查清单（下文） | — |

每个阶段的“测试要求”说明该阶段必须新增哪些测试；阶段结束时全部测试必须通过。

## 模拟模型服务（packages/testkit）

测试中不调用真实模型。`testkit` 提供一个本地 HTTP 服务，实现 **OpenAI 兼容的 Chat Completions 接口**（流式 SSE，支持 tool calls），通过 pi 的自定义 `baseUrl` 接入。

### 场景脚本

```ts
const llm = await startMockLlm();
llm.script('mock-main', [
  step().expect(req => req.lastUserText().includes('帮我'))
        .replyToolCall('send_message', { text: '收到' }),
  step().replyText('完成了'),
]);
llm.script('mock-light', [
  step().replySubmit({ decision: 'respond', confidence: 0.9, reason: '...' }),
]);
```

能力要求：

- **按模型 id 分别编排**：`mock-main`、`mock-light` 等，互不干扰，便于同时测试响应 loop 与后台 loop。
- **断言请求内容**：每个步骤可以检查收到的请求（系统提示词、消息、工具列表），不匹配时测试失败并打印差异。
- **记录全部请求**：测试结束后可以检查“某段内容是否出现在发给模型的请求中”（例如 API key 绝不出现）。
- **可控延迟与闸门**：`step().hold()` 让响应挂起，直到测试调用 `release()`；用于测试执行中注入、取消、租约等待。
- **错误注入**：返回 401、429、500、中途断流。
- **usage**：每个响应返回可配置的 token 用量，用于测试用量账本。
- 未编排的请求直接失败，避免测试静默通过。

### 测试夹具

- `createTestHome()`：创建临时数据目录，设置 `KEPCUP_HOME`，测试结束删除。
- 钥匙串：`NODE_ENV=test` 且 `KEPCUP_KEYSTORE=memory` 时使用内存实现；**非测试环境下该变量无效**，启动时检测到则拒绝启动。
- `createCore(options)`：在测试进程内启动核心服务（不经过 Electron 主进程），返回可直接调用的 RPC 客户端与事件监听器。
- 工厂函数：`makeBot()`、`makeGroup()`、`sendBatch()`、`waitForRun()`、`waitForEvent()`。

## 原生模块

better-sqlite3-multiple-ciphers、`@napi-rs/keyring`、es-git 等原生模块需要同时在 Electron（核心服务运行于 `utilityProcess`）与测试中加载。

- 原生模块按 **Electron 的 ABI** 编译（`electron-builder install-app-deps` 或 `@electron/rebuild`，在 `postinstall` 中执行）。
- 需要加载原生模块的测试，**用 Electron 作为 Node 运行 vitest**：`ELECTRON_RUN_AS_NODE=1 electron ./node_modules/vitest/vitest.mjs run`。根目录提供 `pnpm test` 脚本封装。
- 不依赖原生模块的纯单元测试（例如 `packages/shared`）可以用普通 Node 运行。
- P00 必须验证以上方案在三个平台上可行；不可行时按 [README.md](README.md#偏差与问题) 记录。

## 安全用例集

`packages/core/test/security/` 维护一组**每个阶段都必须继续通过**的用例，随阶段补充：

| 用例 | 引入阶段 |
|---|---|
| API key 明文不出现在：日志文件、runs.db（解密后检索）、发给界面的任何 RPC 返回与事件、发给模型的请求 | P01 |
| 数据库文件无法用不带密钥的 SQLite 打开 | P00 |
| 沙箱内读取 `~/.ssh`、`~/.aws`、`~/.kepcup/main.db` 失败 | P02 |
| 沙箱内写入 workspace 以外的路径失败 | P02 |
| workspace 中指向外部的符号链接，经文件工具读取被拒绝 | P02 |
| 沙箱内访问内网地址与 `169.254.169.254` 失败（所有网络模式） | P02 |
| 同一 Bot 的两个对话，workspace 互相不可访问 | P02 |
| 沙箱初始化失败时命令不会在沙箱外执行（除非经逐条确认） | P02 / P03 |
| 未授权路径经文件工具访问时触发审批，拒绝后不可访问 | P03 |
| 授权只对申请的 Bot 与对话生效 | P03 |
| 无人值守模式下 `~/.kepcup` 仍不可访问 | P03 |
| 其他 Bot 的发言、工具输出中的“指令”不会导致记忆或画像写入（画像证据必须来自用户消息） | P07 |
| 已删除 Bot 的数据目录不存在，id 未被新 Bot 复用 | P01 |

## CI 矩阵

| 任务 | macOS（arm64） | Ubuntu 24.04（x64） | Windows（x64） |
|---|---|---|---|
| lint、类型检查、svelte-check | — | ✓ | — |
| 单元与集成测试 | ✓ | ✓ | ✓ |
| 沙箱测试 | ✓ | ✓（需先执行 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`） | P12 起（WSL2 需自建运行器，否则手工验证） |
| 端到端测试 | ✓ | ✓（`xvfb-run`） | ✓ |
| 打包冒烟 | P13 | P13 | P13 |

- CI 配置写在 `.github/workflows/`；仓库托管在其他平台时按同等内容改写。
- 端到端测试从 P01 开始加入 CI。

## 端到端测试约定

- 启动应用时设置：`KEPCUP_HOME`（临时目录）、`NODE_ENV=test`、`KEPCUP_KEYSTORE=memory`、`KEPCUP_MOCK_LLM_URL`（模拟模型服务地址，启动时自动配置为一个厂商）。
- 界面元素使用 `data-testid` 定位，命名形如 `composer-input`、`draft-queue-item`、`approval-card-approve`。
- 每个阶段的验收标准中凡是界面行为的，都要有对应的端到端测试。

## 手工冒烟清单（真实模型）

每个阶段结束时，用至少一个真实厂商（建议 Anthropic 或 OpenAI 各一个）执行本阶段新增的冒烟步骤，结果写入 PROGRESS.md。通用步骤：

1. 在设置中配置 API key，重启应用后仍有效。
2. 新建 Bot，发送消息，收到符合人设的回复。
3. 执行中追加消息，Bot 能根据新消息调整。
4. 取消执行，界面状态正确。
