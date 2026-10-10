# 01 工程规范

## 技术栈与版本

所有依赖锁定精确版本。下表中“版本要求”是选型约束，具体版本号在 P00 中确定并写入 `package.json`。

| 类别 | 选择 | 版本要求 |
|---|---|---|
| 包管理 | pnpm（workspace） | 10.x |
| 语言 | TypeScript，`strict: true`，ESM | 5.x 最新稳定版 |
| 桌面壳 | Electron | 最新稳定版，**其内置 Node 必须 ≥ 22.19**（pi 的要求） |
| 构建 | electron-vite（主进程、preload、界面）；核心服务作为主进程构建的第二个入口 | 最新稳定版 |
| 界面框架 | Svelte 5（runes）+ Vite，单页应用，不使用 SvelteKit 路由 | 最新稳定版 |
| 样式 | Tailwind CSS v4 | 4.x |
| 组件 | shadcn-svelte（CLI 添加）、bits-ui、svelte-sonner、`@lucide/svelte` 图标、shadcn-svelte-extras | 最新稳定版 |
| 聊天组件 | Svelte AI Elements（复制进项目）、streamdown-svelte、@humanspeak/svelte-virtual-list | 最新稳定版 |
| 代码与 diff | CodeMirror 6（svelte-codemirror-editor、`@codemirror/merge`）、@pierre/diffs | 最新稳定版 |
| Agent | `@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` | 0.87.x 或更新，三者版本一致 |
| 沙箱 | `@anthropic-ai/sandbox-runtime`（srt） | 最新版，锁定 |
| 数据库 | better-sqlite3-multiple-ciphers、sqlite-vec | 最新稳定版 |
| 钥匙串 | `@napi-rs/keyring` | 最新稳定版 |
| git 库 | es-git（备选 isomorphic-git） | 最新稳定版 |
| RPC | birpc | 最新稳定版 |
| 校验 | zod（RPC 契约与边界数据）；工具参数使用 pi 要求的 schema 库（需验证：pi 工具参数目前使用 TypeBox） | 最新稳定版 |
| ID | ulid | 最新稳定版 |
| 日志 | pino | 最新稳定版 |
| 测试 | vitest、Playwright（Electron 端到端） | 最新稳定版 |
| 代码质量 | ESLint（flat config）、Prettier（含 prettier-plugin-svelte）、svelte-check | 最新稳定版 |

## 仓库结构

```text
kepcup/
  package.json                 # 根：workspace 脚本
  pnpm-workspace.yaml
  tsconfig.base.json
  .github/workflows/           # CI（仓库托管在其他平台时按同等内容改写）
  apps/
    desktop/
      electron.vite.config.ts
      electron-builder.yml
      resources/               # 打包进应用的二进制与图标（rg、bwrap、socat、WSL rootfs 等）
      src/
        main/                  # Electron 主进程：窗口、托盘、看护核心服务、系统对话框、通知、电源事件、浏览器托管
        preload/               # 向界面暴露 MessagePort 与极少量安全 API
        core-entry/            # 核心服务进程入口（只做 import('@kepcup/core').start()）
        renderer/              # Svelte 界面
          index.html
          src/
            app.css
            App.svelte
            lib/
              components/ui/   # shadcn-svelte CLI 生成，不手改
              components/ai/   # Svelte AI Elements 等复制进来的组件
              features/        # 按功能组织：chat/、composer/、sidebar/、bot-panel/、settings/、approvals/ ...
              rpc/             # 调用核心服务的客户端与事件订阅
              stores/          # 界面状态（Svelte 5 runes）
              i18n/            # 界面文案（zh-CN）
  packages/
    shared/                    # 纯类型与契约，不依赖 Node 或浏览器 API
      src/
        rpc/                   # RPC 方法与事件的 zod 契约
        domain/                # 领域类型（Bot、Conversation、Message、Run ...）
        ids.ts                 # ID 前缀与生成
        errors.ts              # 错误码
        constants.ts           # 可调参数的默认值
    core/                      # 核心服务
      src/
        start.ts               # 启动：路径、日志、密钥、数据库、迁移、各服务、RPC
        infra/                 # paths、logger、crypto、keystore、db、migrate、events、clock
        rpc/                   # RPC 路由：把契约方法绑定到服务
        domain/                # bots、conversations、messages、drafts、attachments、projects、settings ...
        dispatch/              # 分发器：@ 解析、群聊判断、顺序执行、Bot 间连锁
        scheduler/             # 优先级调度、mailbox、厂商并发限制、定时触发
        agent/                 # AgentEngine（pi 封装）、上下文组装、提示词模板
        tools/                 # 工具定义与实现
        gateway/               # 工具网关：执行身份、路径检查、审批挂起、审计
        permissions/           # grants、审批请求、命令白名单、无人值守模式
        sandbox/               # 沙箱接口、srt 后端、策略生成、逐条确认执行器、WSL 与增强后端
        project/               # 写入租约、检查点、保护规则、project 上下文
        memory/                # 记忆、用户画像、检索、向量服务、各后台 loop 的业务逻辑
        wiki/  skills/  env/  browser/  usage/  schedule/
      migrations/
        main/NNNN_name.sql
        runs/NNNN_name.sql
        memory/NNNN_name.sql
      test/
    testkit/                   # 模拟模型服务、测试夹具、场景脚本
  docs/
```

规则：

- `packages/shared` 不得依赖 `packages/core` 或 Electron。
- `packages/shared` 与 `packages/core` 在运行时按包入口消费**编译产物**（`dist/`，主进程 externalize 依赖；vitest 经 alias 直测 src）。根目录 `pnpm dev` 已先重建两者再启动应用；dev 会话中途改动这两个包后，需 `pnpm --filter @kepcup/core run build`（shared 同理）并重启应用才生效，否则界面是新的而核心服务仍是旧产物。
- 界面（renderer）只能通过 `lib/rpc` 调用核心服务，不得直接访问文件系统、数据库或 Node API。
- `apps/desktop/src/main` 不包含业务逻辑，只做 Electron 平台能力的桥接（窗口、托盘、对话框、通知、电源事件、浏览器托管）。
- 核心服务内的模块依赖方向：`rpc → domain / dispatch / scheduler → agent / tools → gateway → permissions / sandbox / project → infra`。禁止反向依赖；需要反向通知时用事件总线（`infra/events`）。

## 编码规范

- 代码、标识符、代码注释使用英文；界面文案使用中文，统一放在 `renderer/src/lib/i18n/zh-CN.ts`，不在组件中硬编码。
- 文档使用中文。
- 注释只写代码本身无法表达的约束，不写“这一行做什么”。
- 优先纯函数与显式依赖注入（构造函数传入依赖），便于测试；不使用全局单例，`start.ts` 负责组装。
- 所有外部输入（RPC 参数、模型的结构化输出、导入的技能元数据、磁盘上的配置）在边界处用 zod 校验。
- 时间一律使用 UTC 毫秒整数（`number`）；显示时再按本地时区格式化。时间获取通过 `infra/clock`，测试中可替换。
- 路径一律先 `realpath` 再比较；比较前统一分隔符与大小写规则（Windows 与 macOS 默认文件系统不区分大小写）。
- 禁止在任何日志、执行记录、错误信息、RPC 返回中出现敏感数据明文（见下文“日志”）。

## ID 规范

使用 ULID，加类型前缀，全局唯一，**永不复用**。

| 实体 | 前缀 | 示例 |
|---|---|---|
| Bot | `bot_` | `bot_01J9Z...` |
| 对话 | `conv_` | |
| 消息 | `msg_` | |
| 附件 | `att_` | |
| 草稿（待发送队列项） | `drf_` | |
| 执行（Run） | `run_` | |
| 执行步骤 | `stp_` | |
| 记忆条目 | `mem_` | |
| 画像条目 | `prf_` | |
| Project | `prj_` | |
| 授权 | `grt_` | |
| 审批请求 | `apr_` | |
| 定时任务 | `sch_` | |
| 技能（库中版本） | `skl_` | |
| 敏感数据 | `sec_` | |
| 连锁（Bot 间触发链） | `chn_` | |
| 跨 Bot 委派（D71） | `dlg_` | |
| 外部副作用台账行（D78） | `eff_` | |
| 应用连接（D73） | `conn_` | 自定义 MCP server 的连接 id 固定为 `custom:{serverId}` |
| 共享浏览器资料（D77） | `bpf_` | |
| 网页监看（D79） | `wat_` | |

## 可调参数

所有文档中标注为“初始参考”的数值，集中定义在 `packages/shared/src/constants.ts`，禁止散落在代码中。初始值见各阶段文档；汇总如下：

| 常量 | 初始值 | 含义 |
|---|---|---|
| `RECENT_MESSAGES_MAX` | 30 | 注入的最近消息条数上限 |
| `RECENT_MESSAGES_TOKEN_BUDGET` | 4000 | 最近消息的 token 预算 |
| `SUMMARY_TRIGGER_UNSUMMARIZED` | 50 | 未被摘要覆盖的消息超过该数量时更新滚动摘要 |
| `BOT_CHAIN_MAX_DEPTH` | 3 | Bot 间 @ 连锁的最大层数 |
| `DELEGATION_MAX_DEPTH` | 1 | 跨 Bot 委派深度（D71；首期一律单跳，被委派 run 不能再委派） |
| `DELEGATION_RESULT_MAX_CHARS` | 2000 | 贴回 A 结果卡的截断长度（B 的终回复，或跟随任务时各任务结果拼接的总长） |
| `DELEGATION_FYI_MAX_PER_RUN` | 3 | A 的同一轮给同一个 Bot 最多发几条 `fyi` 告知（定义在 `dispatch/delegation.ts`） |
| `DELEGATION_TASK_MAX_CHARS` | 4000 | 单次 `delegate_to_bot` 的 task 文本上限 |
| `BUTLER_TEAM_SIZE_MIN` / `BUTLER_TEAM_SIZE_MAX` | 3 / 5 | 管家 `propose_team` 的建议 Bot 数量范围 |
| `TRIAGE_TIMEOUT_MS` | 20000 | 群聊判断超时 |
| `TRIAGE_RECENT_MESSAGES` | 10 | 群聊判断看的最近消息条数 |
| `MEMORY_TOPK` | 8 | 注入的相关记忆条数 |
| `RRF_K` | 60 | 混合检索的 RRF 参数 |
| `PROFILE_CARD_TOKEN_BUDGET` | 400 | 画像卡片预算 |
| `PERSONA_TOKEN_BUDGET` | 800 | 人设预算 |
| `MY_STATE_TOKEN_BUDGET` | 300 | “我的状态”预算 |
| `RELEVANT_MEMORY_TOKEN_BUDGET` | 600 | 相关记忆预算 |
| `WIKI_TOPICS_TOKEN_BUDGET` | 200 | Wiki 主题目录预算 |
| `SKILLS_LIST_TOKEN_BUDGET` | 500 | Skills 列表预算 |
| `PROJECT_CONTEXT_TOKEN_BUDGET` | 1500 | project 信息预算（含 AGENTS.md） |
| `TOOL_OUTPUT_MAX_CHARS` | 30000 | 单次工具输出返回给模型的最大字符数，超出截断并注明 |
| `RUN_MAX_TURNS` | 60 | 单次执行的最大轮数 |
| `SKILL_AUTHOR_REPEAT_THRESHOLD` | 2 | 同类任务成功多少次后建议自建技能 |
| `CHECKPOINT_RETENTION_DAYS` | 30 | 检查点保留天数 |
| `MAX_PROACTIVE_PER_DAY` | 5 | 每个 Bot 每天主动消息上限（Profile 可覆盖） |
| `TURN_MAX_TURNS` | 8 | 对话轮（D75）的最大轮数 |
| `TASK_CONCURRENCY_PER_CONVERSATION` / `TASK_CONCURRENCY_GLOBAL` | 3 / 8 | 任务并发：对话级 / 全局 |
| `TASK_START_MAX_PER_TURN` | 2 | 单个对话轮最多起的任务数 |
| `TASK_MAX_WALL_MS` | 4 小时 | 单个任务的墙钟上限（reaper 强制 `failed`） |
| `TASK_TOKEN_BUDGET` | 2000000 | 单个任务的 token 预算（输入 + 输出累计） |
| `TASK_SETTLE_SWEEP_MS` | 60000 | 任务结算对账 / reaper 周期 |
| `TASK_EVENT_CONTEXT_MAX_CHARS` | 600 | 最近窗口里任务进度与较早任务条目的截断长度 |
| `TASK_TRIGGER_RESULT_MAX_CHARS` | 12000 | 触发段里任务结果全文的硬顶 |
| `GRANT_ABSOLUTE_TTL_MS` | 10 分钟 | 一次性授权的绝对时限（D37 收紧） |
| `TURN_MCP_READ_TOOLS_MAX` | 20 | 进对话轮 / 只读子代理工具面的只读 MCP 工具数上限（D65） |
| `TURN_MCP_RESOLVE_TIMEOUT_MS` | 3000 | 对话轮等待解析 MCP 工具面的上限，超时本轮不带 MCP 工具（D65） |
| `BROWSER_NO_PROGRESS_LIMIT` | 3 | 同一浏览器动作连续几次页面不变后拦下下一次（D77） |
| `BROWSER_USER_CONTROL_IDLE_MS` | 600000 | 用户接管页面后无任何输入多久自动交还给 Bot（D77） |
| `BROWSER_HANDBACK_COALESCE_MS` | 30000 | 同一任务在该时长内只收到一次「用户已交还浏览器控制」注入（D77） |
| `BROWSER_PROFILE_NAME_MAX_CHARS` | 40 | 共享浏览器资料名称长度上限（D77） |
| `WATCH_MIN_INTERVAL_SEC` / `WATCH_MAX_INTERVAL_SEC` | 300 / 604800 | 网页监看检查间隔下限 / 上限（秒，D79） |
| `WATCH_MAX_PER_BOT` / `WATCH_MAX_GLOBAL` | 20 / 100 | 每个 Bot / 全局未停止（进行中 + 已暂停）的监看上限（D79） |
| `WATCH_PAUSE_AFTER_FAILURES` | 5 | 监看连续失败几次后暂停并发卡片（D79） |
| `WATCH_BACKOFF_MAX_MINUTES` | 60 | 监看失败退避上限：`max(5, min(60, 2^failures))` 分钟，即 5 / 5 / 8 / 16 / 32 / 60（重试不早于 `WATCH_MIN_INTERVAL_SEC`，D79） |
| `WATCH_HOST_UNAVAILABLE_RETRY_MS` | 60000 | 浏览器宿主未连接时监看的重试间隔（不计失败；宿主绑定后立即重查，D79） |
| `WATCH_MAX_ALERTS_PER_DAY` | 24 | 每个监看滚动 24 小时内的提醒上限；超出即暂停并发「提醒过于频繁」卡（D79） |
| `WATCH_FETCH_DEADLINE_MS` | 45000 | 后台页一次取正文的总时限（宿主侧，超时关页并计失败，D79） |
| `WATCH_DIFF_SUMMARY_MAX_CHARS` | 1500 | 监看提醒里增删改摘要的长度上限（D79） |
| `WATCH_FETCH_TEXT_MAX_CHARS` / `WATCH_STORED_TEXT_MAX_CHARS` | 200000 / 50000 | 后台页返回的正文上限 / 为下次 diff 保存的上一版文本上限（D79） |
| `WATCH_CONDITION_TEXT_MAX_CHARS` / `WATCH_SELECTOR_MAX_CHARS` | 200 / 300 | 监看条件文字 / CSS 选择器长度上限（D79） |

## 日志

- 使用 pino，输出到 `~/.kepcup/logs/`，按天滚动，保留 14 天；开发模式同时输出到控制台。
- 统一的脱敏器：键名匹配 `/(api[_-]?key|token|secret|password|authorization|cookie)/i` 的字段替换为 `[REDACTED]`；已知敏感值（从敏感数据表解密过的值）在输出前做字符串替换。
- 执行记录（run_steps）写入前经过同一个脱敏器。
- 日志中不记录消息正文与文件内容，只记录 id、长度、类型。

## 错误处理

- 错误码定义在 `packages/shared/src/errors.ts`，形如 `SANDBOX_UNAVAILABLE`、`LEASE_TIMEOUT`、`APPROVAL_DENIED`、`PATH_OUT_OF_SCOPE`、`STALE_FILE`、`PROVIDER_AUTH_FAILED`。
- 核心服务内部抛出 `AppError(code, message, details?)`；RPC 层把它序列化为 `{ code, message, details }` 返回，界面按错误码映射中文提示。
- 工具执行失败**不抛出到 loop 之外**：以工具结果的形式返回给模型（含错误码和可读说明），由模型决定下一步。
- 未预期的异常：记录日志，本次执行标记为 `failed`，在对话中给出用户可理解的失败提示（附重试入口）。

## 依赖管理

- 新增依赖前检查：是否已有依赖能做到；是否维护活跃；许可证是否为 MIT / Apache-2.0 / BSD / ISC。
- 本文与阶段文档未列出的**大型依赖**（框架、运行时、原生模块、数据库、UI 组件库）不得自行引入，需按 [README.md](README.md#偏差与问题) 记录并等待决定。
- 小型工具库（例如日期格式化、防抖函数）可以直接引入，在 PR / 提交说明中写明理由。
- 原生模块（better-sqlite3-multiple-ciphers、`@napi-rs/keyring`、es-git 等）必须同时能在 Electron 与测试运行器中加载，方案见 [05-testing.md](05-testing.md#原生模块)。

## 提交规范

- 提交信息使用 Conventional Commits：`feat(core): ...`、`fix(renderer): ...`、`test(...)`、`docs(...)`、`chore(...)`。
- 每个提交保持可构建、测试通过。
- 一个阶段可以有多个提交；阶段结束时 PROGRESS.md 的更新作为单独提交。
