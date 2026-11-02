# 54. Bot 微应用运行时（Bot Micro-Apps / KepCup 微应用）

> 状态：**草案（2026-11-02，四项产品决策已拍板）**。决策编号 **D107**（已登记 README 决策表）。
> 已拍板（2026-11-02）：**默认允许联网**；**模型等用量计入编写该微应用的 Bot**；**不做发音评分**；**统一命名为「微应用」**（宿主仍称「主应用」，代码前缀 `MicroApp*`）。
> 关系：[32-bot-widgets.md](32-bot-widgets.md) 定义「组件」这一形态与制作流程；本文把同一套运行时**升级为微应用平台**，取代 32 号 §5（渲染管线）/§6（能力桥）/§8（安全清单）中关于「组件能力面」的结论。32 号作为组件形态、版本化确认与制作流程的历史设计继续有效。
> 执行方案待本稿确认后另立 `todo/bot-micro-app-platform.md`。

---

## 0. 一句话结论

今天的「组件」是一个**由 Bot 写死的单页界面 + 宿主提供的六个窄接口**；而用户期待的是「**AI 编写、依托主应用能力独立运行的微应用**」——像微信小程序，界面、会话状态、模型调用、麦克风与扬声器都由平台提供，AI 只写业务。

两者不是同一层东西。差距不在「再多加两个 API」，而在五个结构性缺口：

1. **没有能力声明与授权模型**：能力桥是固定白名单，微应用不能声明「我要麦克风和模型」，用户也无法按微应用授予/撤销。
2. **没有模型平面**：`window.kepcup` 没有 `ai.*`，AI 写的微应用无法自己调用模型做多轮对话。
3. **没有音频平面**：iframe `allow=""`，`getUserMedia` 被权限策略拦死；现有麦克风采集只在宿主渲染层的传感器层里。
4. **没有事件通道**：桥只有「请求 → 回执」，没有流式增量、订阅、取消——流式对话与实时电平都做不了。
5. **没有包与生命周期**：产物是单文件 HTML，打开覆盖层即生、关闭即灭，没有多文件资产、没有会话恢复、没有前后台。

本文给出把「组件」演进为「微应用平台」的目标架构、SDK 契约、权限模型、音频与模型链路、制作流程升级和分期验收。四项已拍板决策贯穿全文：默认联网（§3.3）、用量归编写该微应用的 Bot（§8.3）、不做发音评分（§16）、统一命名「微应用」（§1.2）。

---

## 1. 产品模型

### 1.1 心智模型

把主应用看成 **运行平台**，把 Bot 写的东西看成 **平台上的微应用**：

| 角色 | 类比 | 在 KepCup 里的位置 |
|---|---|---|
| 平台 | 微信客户端 | 桌面 renderer：对话、卡片、微应用外壳、权限与授权 UI |
| 运行时 | 小程序基础库 | `kepcup-app://` 协议 + sandbox iframe + 桥 + SDK 垫片 |
| 能力服务 | 微信开放能力 | core：模型网关、ASR/TTS、数据库、文件；renderer：麦克风/摄像头、播放 |
| 微应用 | 小程序 | Bot 编写并交付的 `micro-app.json` + 页面 + 资源 |
| 开发者 | 第三方开发者 | **Bot**（经制作 loop） |
| 微应用中心 | 小程序商店 | 后续：Bot 级微应用、模板导出、插件市场 |

关键约束与微信小程序一致：**代码在沙箱里，能力由平台代理，数据按微应用隔离，用户可见授权**。

### 1.2 术语

- **微应用（micro-app）**：带 `micro-app.json` 清单、可声明能力、可多文件、有独立会话状态的产物。本文的主角；用户可见文案统一用「微应用」。
- **组件（widget）**：只有一个 `index.html`、不声明任何能力（或只声明 `storage.kv`）的退化微应用。32 号的存量资产全部属于这一类。
- **微应用实例（instance）**：某张卡片在某个用户会话里的一次运行。状态不跨实例共享，数据按微应用隔离。
- **能力（capability）**：平台暴露给微应用的一组命名 API，声明在清单里，由宿主在执行期强制。
- **宿主 / 主应用**：KepCup 桌面客户端本身；不随本次改名变化。

> 命名约定：用户可见与文档统一用「微应用」；代码新增模块用 `MicroApp*` 前缀；SDK 命名空间保留 `kepcup.app`（实例 API）与 `kepcup.*`（能力 API）。数据库表暂时保留 `widget_*` 命名（见 §13.2），避免在契约未稳定前做数据迁移。

### 1.3 与现有「交付形态分层」的关系

32 号 §12 的三层仍然成立，本文补第四层：

| 层 | 形态 | 谁写代码 | 适用 |
|---|---|---|---|
| L1 | `present` 声明式展示卡 | 宿主 | 表格、图表、指标 |
| L2 | `ask_user` 表单 | 宿主 | 让用户选/填 |
| L3 | 组件（单页 HTML，无能力或仅存储） | Bot | 计算器、追踪器、小游戏 |
| **L4** | **微应用（清单 + 多文件 + 能力声明）** | Bot | 英语口语陪练、连续对话、需要麦克风/模型的工具 |

判断标准不是「复杂不复杂」，而是**是否需要平台能力与持续会话**。只需要展示就用 L1；需要用户点几下用 L3；需要听、说、调模型、跨会话记住进度，才升到 L4。

---

## 2. 现状盘点（2026-11-02 读代码）

### 2.1 已经有的

| 能力 | 现状 | 代码位置 |
|---|---|---|
| 产物 | 单文件 HTML ≤2MB，版本只增不改 | `packages/core/migrations/main/0028_widgets.sql` |
| 运行 | `kepcup-app://widget-{hash24}/{resourceId}` + sandbox iframe | `apps/desktop/src/renderer/src/lib/features/widgets/WidgetRuntime.svelte:275-291` |
| 档位 | 完整 WebApp 档（可联网、localStorage、表单、弹框） | `packages/shared/src/domain/apps-ui.ts:202-207` |
| 确认 | 按 `HTML sha256 + queries sha256` 逐版本确认，含 SQL 的版本强制预审 | `features/widgets/consent.svelte.ts`、`core/widgets/service.ts:587-621` |
| 能力桥 | `storage` / `query` / `openLink` / `reply` / `theme` / `setHeight` | `packages/core/src/widgets/sdk-injection.ts:164-201` |
| 数据 | 每微应用 KV（`widget_docs`）+ 预审命名只读 SQL | `core/widgets/service.ts:973-1012`、`query-gate.ts:50-79` |
| 制作 | SPEC→BUILD→GATE→REVIEW→DELIVER 状态机，草稿目录 + 静态检查 + 离线预览 | `core/widgets/craft/service.ts`、`craft/prompts.ts` |
| 语音（宿主侧） | 录音、`media.transcribeSpeech`、`media.synthesizeSpeech` | `features/sensors/hub.ts`、`core/rpc/bindings.ts:664-672` |
| 传感器 | 麦克风/摄像头统一抽象、总闸、设备选择 | `docs/design/31-sensors.md` |

### 2.2 能力矩阵：用户要的 vs 现在有的

| 英语口语微应用需要 | 今天能做什么 | 缺口 |
|---|---|---|
| 角色头像、对话气泡、课程页 | 单文件 HTML 自己画 | 无（够用） |
| 多页 / 路由 / 资源拆分 | 只能单文件内 SPA | 多文件包与相对资源 |
| 调模型生成回复 | **不能** | `ai.chat`（含流式） |
| 麦克风采集 | **不能**（iframe 无权限） | 宿主代理采集 + 分段 |
| 语音识别 | 只有宿主语音输入 | `media.listen` |
| 语音播报 | 只有宿主语音对话模式 | `media.speak` |
| 打断（barge-in） | 无 | 播放控制 + 半双工状态机 |
| 记住孩子的进度 | KV 1MB | 够用；缺结构化集合与配额展示 |
| 长会话恢复 | 关掉即丢 | 会话快照 / 恢复 |
| 声明「我要麦克风」 | 无 | 清单 + 授权卡片 |
| 用户撤销麦克风 | 只能关掉整个微应用 | 能力级撤销 |
| 流式字幕 / 实时电平 | 无事件通道 | 桥升级为 call/stream/event |
| 成本可见 | 无 | 用量记账 + 预算 |

### 2.3 五个结构性缺口（按影响排序）

1. **能力面是硬编码的**：`window.kepcup` 是固定对象，桥白名单固定（`widget-bridge-guard.ts`）。新增一种能力要同时改垫片、桥、core、提示词、检查器五处，且无法按微应用授权。
2. **没有事件通道**：桥协议是 `{id, type, payload}` 请求/回执。流式 token、录音电平、播放进度、VAD 事件都需要宿主主动推。
3. **没有模型平面**：core 的对话能力绑定在 run/会话模型上，没有「给微应用用的、隔离上下文、可限额」的调用入口。
4. **没有音频平面**：安全设计（`allow=""`）正确，但平台没有补上代理通道；麦克风只能在宿主 UI 里用。
5. **产物与生命周期太窄**：单文件、无资源、无恢复、无前后台；微应用只是「一张卡片的附属界面」。

---

## 3. 目标架构

### 3.1 分层

```
┌────────────────────────── Desktop renderer ──────────────────────────┐
│  对话流                                                                 │
│   MicroAppCard（海报 / 能力清单 / 按版本确认）                          │
│      └─ MicroAppView（覆盖层）                                           │
│           ├─ MicroAppChrome（标题 / 能力徽标 / 麦克风状态 / 关闭）         │
│           └─ MicroAppRuntime（iframe, kepcup-app://widget-{hash}/{id}）    │
│                    │ postMessage：call / stream / event / cancel          │
│           MicroAppBridgeHost（唯一来源校验 + 能力路由 + 配额 + 审计）      │
│                    ├─ 免审能力：storage / theme / ui / event              │
│                    ├─ 会话能力：sensors hub（麦克风）→ ASR                │
│                    ├─ 播放能力：TTS 音频队列（可打断）                     │
│                    └─ RPC：core.call('microApps.ai.*') 等                │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ core RPC
┌──────────────────────────────▼───────────────────────────────────────┐
│ core                                                                   │
│  MicroAppService（版本 / 清单 / 能力 / 配额 / 用量）                     │
│  MicroAppAiGateway（模型策略 / 上下文隔离 / 流式 / 记账）                 │
│  MediaGateway（asr / tts，沿用 media.* 适配器）                          │
│  better-sqlite3（微应用数据 / 版本 / 用量）                                │
└──────────────────────────────────────────────────────────────────────┘
```

不变量（沿用并强化 32 号）：

- **生成代码永不接触 Node、文件系统、Electron API、core 内部**。
- **能力只在宿主侧执行**，iframe 只持有一份窄接口。
- **数据按微应用隔离**，跨微应用不可见。
- **授权按版本 + 能力**，能力扩大即新代码，重新确认。
- **模型调用与音频外发都必须可见、可限额、可撤销**。

### 3.2 为什么保留 iframe，而不是原生组件

原生 Svelte 组件由 Bot 生成会把生成代码放进宿主进程，直接推翻 32 §2 的信任模型。iframe + 独占协议源 + 桥是同类产品的共识（Claude Artifacts、ChatGPT Apps、MCP Apps）。代价是「不能用宿主原生控件」，用 SDK 的 `ui` kit 与 MicroAppChrome 补偿。

### 3.3 运行档位

沿用 32 §13 的完整 WebApp 档，按清单可收紧、不放宽到宿主之外：

| 档位 | CSP `connect-src` | 适用 |
|---|---|---|
| `net: open`（**默认**） | `*`（同 32 §13 完整 WebApp 档） | 默认形态；与 32 号当前实现一致 |
| `net: allowlist` | 清单声明的 https 域 | 作者主动收紧，或儿童/敏感场景模板推荐 |
| `net: none` | `'none'` | 完全离线的微应用；所有数据经 `kepcup.*` |

默认允许联网（2026-11-02 决策）：微应用可用 `fetch` / `WebSocket` / 外链资源，与现有组件运行时档位一致；确认卡必须明示「可联网」。三档都写进清单（缺省 `open`），确认指纹包含网络档位与域名清单；从宽松档改到收紧档同样产生新版本。

---

## 4. 微应用包与清单

### 4.1 包结构

```
english-corner/
  micro-app.json        # 清单（唯一入口，宿主独占校验）
  index.html            # 入口页
  main.css              # 可选，相对路径引用
  main.js               # 可选，相对路径引用
  assets/avatar.png     # 可选，≤ 单文件 1MB
  queries.json          # 可选，只读查询模板（沿用 32 §6.1）
  acceptance.json       # 可选，制作期验收步骤
```

- 包内所有文件经同一协议源提供，相对路径可直接用；`..`、绝对路径、跨微应用路径一律拒绝。
- 单版本总字节 ≤ 8MB，文件数 ≤ 64；入口必须存在且为 HTML。
- 仍然只允许静态资源，不允许服务端代码。

### 4.2 清单

```json
{
  "spec": "kepcup-micro-app/1",
  "slug": "english-corner",
  "name": "小小英语角",
  "description": "和虚拟角色用英语聊天的口语练习微应用",
  "entry": "index.html",
  "display": { "mode": "immersive", "minWidth": 360, "minHeight": 520 },
  "permissions": ["storage.kv", "ai.chat", "media.listen", "media.speak"],
  "ai": { "profile": "micro-app.light", "maxTokensPerSession": 20000 },
  "net": { "mode": "open" },
  "queries": "queries.json"
}
```

规则：

- `spec` 未知 → 拒绝交付。
- `permissions` 是**闭合枚举**（§5.1）；出现未知项 → 拒绝交付，不静默忽略。
- `ai.profile` 只是「请求档位」，最终模型由宿主策略裁决（§6.2），微应用不能指定厂商或模型 id；用量与费用计入**编写该微应用的 Bot**（§8.3）。
- `net.mode` 缺省 `open`（默认联网）；`allowlist` / `none` 是作者主动收紧。`allowlist` 必须给出域名数组，且每个域名在确认卡上可见。
- 清单变化（尤其权限、网络档位）→ 新版本 → 重新确认。

### 4.3 数据模型增量

在 32 号四张表之上：

```sql
-- 版本清单与包摘要（HTML 之外的文件放 micro_app_files）
ALTER TABLE widget_versions ADD COLUMN manifest_json TEXT NOT NULL DEFAULT '';
ALTER TABLE widget_versions ADD COLUMN bundle_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE widget_versions ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';

-- 包内非入口文件
CREATE TABLE micro_app_files (
  widget_id  TEXT NOT NULL,
  version    INTEGER NOT NULL,
  path       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  content    BLOB NOT NULL,
  PRIMARY KEY (widget_id, version, path)
);

-- 用量记账（按微应用 / 日；归属 Bot 由 widgets.bot_id 决定）
CREATE TABLE micro_app_usage (
  widget_id   TEXT NOT NULL,
  day         TEXT NOT NULL,          -- YYYY-MM-DD（本地时区）
  ai_calls    INTEGER NOT NULL DEFAULT 0,
  ai_tokens   INTEGER NOT NULL DEFAULT 0,
  asr_ms      INTEGER NOT NULL DEFAULT 0,
  tts_chars   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (widget_id, day)
);
```

- `bundle_sha256` = 清单 + 入口 + 全部文件按路径排序后的规范化摘要，是确认指纹的一部分。
- 现有 `sha256` 保留为入口 HTML 摘要，兼容旧卡。
- `micro_app_files` 随版本修剪一起删（沿用 `BOT_WIDGET_VERSIONS_KEPT`）。
- 存量 `widget_*` 表暂不改名：契约稳定后再做一次纯改名迁移（§13.2）；新增表用 `micro_app_*` 前缀。

---

## 5. 能力与权限

### 5.1 能力枚举

| id | 运行时 API | 授权档 | 限额 | 说明 |
|---|---|---|---|---|
| `storage.kv` | `kepcup.storage.*` | 免审 | 1MB / 1000 键 | 已有，命名空间 = 微应用 |
| `storage.collection` | `kepcup.collections.*` | 免审 | 5MB | P2，结构化文档集合 |
| `ai.chat` | `kepcup.ai.chat` / `ai.session` | 打开时确认（含预算） | 每会话 / 每 Bot 每日 token 预算 | 上下文与微应用私有，不进对话；用量计入编写该微应用的 Bot |
| `media.listen` | `kepcup.media.listen` | **每次运行会话授权** | 单段 ≤15s，可随时撤销 | 宿主采集 + 分段 + ASR，微应用只拿文本与电平 |
| `media.speak` | `kepcup.media.speak` | 免审（仅播放宿主合成音频） | 队列 ≤3 段 | 可打断 |
| `host.reply` | `kepcup.reply` | 每次确认 | ≤2000 字 / 5s | 已有 |
| `host.openLink` | `kepcup.openLink` | 每次确认 | https-only | 已有 |
| `net.fetch` | 浏览器原生 fetch | **默认开放**（作者可收紧为 `allowlist` / `none`） | 按清单档位 | 不写入 `permissions`，由 `net.mode` 控制；确认卡明示「可联网」 |
| `files.pick` | `kepcup.files.pick` | 用户手势 + 系统选择器 | 单文件 20MB | P3，只读副本 |
| `notify` | `kepcup.notify` | 免审 | 每 10 分钟 1 条 | P3，系统通知，需用户开总闸 |

永不开放（任何版本、任何确认都不行）：文件系统、子进程、shell、Electron/IPC、任意 SQL、读取 `secrets`、其他微应用数据、当前对话全文（只给现有 `conversation_messages` 作用域视图）。

`net.fetch` 是平台默认能力，**不出现在 `permissions` 枚举里**：缺省 `net.mode = open`，声明 `none` / `allowlist` 是作者收紧。其余能力必须在 `permissions` 里声明才可用。

### 5.2 授权模型

三层：

1. **清单声明**（作者意图）——只写进版本，不生效。
2. **用户确认**（按版本）——确认卡列出能力的人话描述与预算；指纹 = `bundle_sha256`（含权限集与网络域）。权限只增不减也算新代码。
3. **执行期授权**（按会话）——麦克风、外链、回传这类敏感能力，每次运行会话重新授权；关闭微应用即释放麦克风。

确认卡示例（不是最终文案）：

```
小小英语角 · 第 3 版（由 Bot「Emma 老师」编写）
它可以：
  · 保存练习进度（本机，仅此微应用）
  · 调用模型生成对话（预计每次练习 ≤2 万 token，计入 Bot「Emma 老师」的模型额度）
  · 使用麦克风听你说话（录音只用于转写，不保存）
  · 播放语音
可联网。
[查看代码]  [打开]
```

### 5.3 执行期强制

- 桥在分派前按 `version.permissions` 校验；未声明 → `MICRO_APP_CAPABILITY_DENIED`，并记一条审计。
- 声明了但用户在本会话拒绝 → `MICRO_APP_CAPABILITY_DENIED`（不同 code，文案区分「微应用未声明」与「你已拒绝」）。
- 每次敏感能力调用写 `micro_app_audit`（微应用、版本、能力、结果、时长）；不记内容。
- 能力集变化时，正在运行的实例立即降级：撤销麦克风 = 停止采集并通知微应用 `capability.revoked`。

---

## 6. SDK

### 6.1 单一事实来源

现在的 `widget-sdk` 是手工维护的：垫片在 `sdk-injection.ts`，API 说明在 `craft/prompts.ts`，检查规则在 `check/rules.ts`，模板在 `widget-templates.ts`——四处容易漂移。

新 SDK 以**一份 TypeScript 描述**为源：

```
packages/shared/src/micro-app-sdk/
  spec.ts        # 能力、API 签名、限额、错误码（唯一事实）
  generate.ts    # 由 spec 生成下述产物
  ...
```

生成物：

| 产物 | 消费方 |
|---|---|
| 注入垫片 JS | 运行时（`sdk-injection` 改为读生成结果） |
| `kepcup-micro-app.d.ts` | 制作 loop 的 `read` 工具可读，模型写 TS 时有类型 |
| `sdk.md`（≤4KB） | 制作 loop 系统提示（替代手工 API 清单） |
| 检查器规则 | `GATE` 校验「只用了声明过的能力」「参数形状正确」 |
| 预览 mock | S2 预览里模拟 AI / ASR / TTS |
| 能力文案 | 确认卡与设置页 |

这条与仓库既有的「设置目录是唯一事实来源」同构，避免「文档说能做、运行时没实现」。

### 6.2 API 形状

```ts
window.kepcup = {
  app: {
    ready(): Promise<void>;
    on(event: 'pause' | 'resume' | 'capability.revoked' | 'theme', cb: (v?: unknown) => void): () => void;
    close(): void;
    setTitle(title: string): void;
  },

  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    list(): Promise<string[]>;
  },

  // 微应用私有的多轮模型会话；上下文不进入主对话
  ai: {
    chat(input: {
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
      stream?: boolean;
      signal?: AbortSignal;
    }): Promise<{ text: string }> | AsyncIterable<{ delta: string }>;
    session(input: {
      id?: string;
      system?: string;
      maxTurns?: number;
    }): Promise<{
      send(text: string, opts?: { stream?: boolean }): Promise<{ text: string }>;
      history(): Promise<{ role: string; content: string }[]>;
      reset(): Promise<void>;
    }>;
  },

  media: {
    listen(input?: {
      lang?: string;              // 'en-US' | 'zh-CN' …
      mode?: 'push-to-talk' | 'vad';
      silenceMs?: number;
    }): Promise<{
      start(): Promise<void>;
      stop(): Promise<void>;
      on(event: 'level' | 'speech-start' | 'partial' | 'final' | 'error' | 'end', cb: (v: unknown) => void): () => void;
    }>;
    speak(input: { text: string; voice?: string; rate?: number }): Promise<void>;
    stopSpeaking(): Promise<void>;
  },

  ui: {
    theme(): Promise<'light' | 'dark'>;
    toast(text: string): void;
    confirm(text: string): Promise<boolean>;
    format(value: number, opts?: { decimals?: number; percent?: boolean; currency?: boolean }): string;
    // 以及 32 §11.13 的 kit：bar / line / pie
  },

  reply(text: string): Promise<boolean>;
  openLink(url: string): Promise<void>;
};
```

设计约束：

- **全部异步能力返回 Promise，错误带 `code`**；垫片不抛裸字符串。
- **流式用 `AsyncIterable` 或事件**，不轮询；桥侧 `stream` 帧带 `streamId`、`seq`、`done`。
- **取消**：`AbortSignal` 映射为 `cancel` 帧；关闭微应用即取消全部在途调用。
- **不暴露 resourceId、不暴露宿主路径、不暴露模型 id**。

### 6.3 桥协议 v2

```ts
type BridgeOut =
  | { k: 'call';    id: number; method: string; params: unknown }
  | { k: 'stream';  id: number; streamId: string }
  | { k: 'cancel';  id: number; target: number | string }
  | { k: 'ack';     id: number; result: unknown }
  | { k: 'error';   id: number; code: string; message: string }
  | { k: 'event';   subId: string; name: string; data: unknown }
  | { k: 'event-ack'; subId: string; seq: number }
  | { k: 'close' };
```

- 仍然是 `postMessage` + `event.source === iframe.contentWindow` 唯一来源校验。
- 二进制（音频、图片）用结构化克隆的 `ArrayBuffer`，不走 base64，减少 33% 膨胀。
- 每条请求恰好一条终态回执（`ack` / `error`），流式另有 `event`；心跳用于回收挂死的 promise。
- 事件订阅有上限（每微应用 32 个）与背压（seq 丢失即断开并通知微应用重连）。

---

## 7. 音频链路（关键设计）

### 7.1 为什么必须由宿主代理

1. iframe 是 `allow=""`，Permissions-Policy 直接拒绝 `getUserMedia`；改成 `allow="microphone"` 等于把任意生成代码变成可录音程序。
2. `MediaStreamTrack` 不能跨 `postMessage` 转移。
3. 即使能传流，AI 写的代码可以联网，原始音频就是可直接外带的隐私数据。

因此：**麦克风只在宿主渲染层打开，音频不出宿主进程；微应用只收到文本、电平和状态。**

### 7.2 半双工对话环

```
微应用: listen.start()
宿主: sensors.open('microphone') → 16kHz mono → VAD 分段（silenceMs 默认 700ms，单段 1.5–15s）
宿主: 段结束 → media.transcribeSpeech → { text }
宿主: event 'partial'（可选） / 'final' → 微应用
微应用: ai.session.send(text) → 流式 delta → 渲染字幕 → 段结束
微应用: media.speak(reply) → 宿主 TTS → 播放；播放前暂停采集（防回声）
用户: 插话 → 宿主停止播放 + 丢弃未播队列 → 回到采集
```

- **不做全双工**：当前 ASR 适配器是「整段转写」（`media.transcribeSpeech` 非流式），全双工需要厂商流式 ASR，列为后续（§16）。
- **延迟预算**：端点检测 0.7s + ASR 1.5s 内 + 首 token 1s ≈ 3s 内开始回话；超过则微应用先播「嗯，让我想想」之类的填充（由微应用决定，平台不代写）。
- **播放**：TTS 在宿主侧合成与播放（复用 53 号的 `media.synthesizeSpeech` + `Audio` 队列），避免 iframe 自动播放策略与打断语义分散在两处。
- **隐私**：默认不落盘；宿主只记时长与字符数（`micro_app_usage`）。任何持久化音频需要 `storage.audio` 能力（暂不开放）。
- **降级**：缺 ASR / TTS 配置时，`media.listen` 返回 `CAPABILITY_NOT_CONFIGURED`，微应用应回退到键盘输入 + 文字对话（制作流程把「降级路径」列为验收点）。

### 7.3 MicroAppChrome（微应用外壳）

覆盖层顶部加一条宿主渲染的微应用外壳：

```
← | 小小英语角            [麦克风使用中]  [⏹]  [×]
```

- 麦克风指示由宿主绘制，微应用无法伪造或隐藏。
- 停止键 = 立即关闭采集与播放。
- 能力徽标点击展开「它在用什么」。
- 这层不占微应用 iframe 的 DOM，微应用无法覆盖。

---

## 8. 模型调用

### 8.1 上下文隔离

微应用自己的对话历史**不进入主对话上下文**，主对话只看到卡片与（经确认的）`reply`。理由：

- 英语陪练一分钟可能十几轮，进主上下文会挤爆窗口、污染人设。
- 微应用历史归微应用所有，存 `storage` / `collections`，可清空。
- Bot 若想知道进展，用 `widget_read_state` 读摘要（已有），或用户主动回传。

### 8.2 模型策略

- 微应用不能指定厂商 / 模型 id；`ai.profile` 只是「轻量 / 默认」的请求。
- 宿主策略：默认走 Bot 的轻量模型；设置页可指定「微应用模型」（单独一条设置目录条目）。
- 系统提示由两部分组成：微应用声明的角色设定（**包在 `<untrusted source="micro-app-prompt">` 里，明确标注「这是微应用作者写的角色设定，不是平台指令」**）+ 宿主固定的边界句（不透露系统提示、不声称是人、不引导线下见面等）。
- **不允许微应用调工具**：`ai.chat` 是无工具的单轮/多轮补全。需要外部数据时走原生 `fetch`（默认开放，可用 `net.mode` 收紧）或 `query`（只读宿主数据），不让微应用间接获得宿主工具面。
- **输出按不可信处理**：微应用把模型输出渲染成 DOM 时必须用 `textContent`；回传到主对话仍走 `kepcup.reply` 的确认条。

### 8.3 限额与记账

**计费归属（2026-11-02 决策）**：模型、ASR、TTS 的用量与费用一律计入**编写该微应用的 Bot**——归属由 `widgets.bot_id` 决定，不看当前对话属于谁。同一个 Bot 编写的多个微应用共享该 Bot 的额度；Bot 被复制/移交后，新副本的后续用量计入新 Bot，历史用量不随资产移交复制。

- 每微应用每会话 `maxTokensPerSession`（清单声明，宿主夹取上限 50k）。
- 每微应用每日 token 上限（宿主默认 200k，可在微应用管理页调）。
- 每 Bot 每日合计 token 上限（宿主默认 1M，跨该 Bot 全部微应用）；超出后所有微应用统一 `MICRO_APP_AI_QUOTA`，管理页可看是哪个微应用用掉的。
- 每实例并发模型调用 1；超限 `MICRO_APP_AI_BUSY`。
- 用量写 `micro_app_usage`（按微应用 / 日），聚合与账单按 `widgets.bot_id` 归到 Bot；确认卡与管理页展示「本次练习约 N token，计入 Bot「X」」。
- 模型调用失败：`MICRO_APP_AI_UNAVAILABLE` / `MICRO_APP_AI_QUOTA`，微应用必须能显示可读错误并保留练习进度。

### 8.4 提示词注入面

- 用户语音 → ASR 文本 → 微应用 → 模型：转写文本是用户内容，进入微应用上下文没问题；但微应用可能把它拼进系统提示，宿主无法阻止。因此宿主在 `ai.chat` 前做一次轻量检查：如果 `system` 里出现明显的「忽略以上指令」类模式，标记为 warning（不阻断，记审计）。
- 模型输出 → 微应用 → 用户：微应用负责渲染；平台只保证回传通道有确认。

---

## 9. 生命周期与状态

### 9.1 状态机

```
卡片（海报 + 确认）
  └─ open ──► preparing（登记资源、注入垫片、分配实例 id）
                └─► running ⇄ suspended
                      └─ close / 崩溃 ──► closed（资源释放、麦克风关闭、在途调用取消）
```

- **suspended**：微应用视图仍打开但窗口不可见（最小化、切到别的 tab、系统休眠）。宿主推 `app.pause`，微应用保存快照；恢复推 `app.resume`。
- **closed**：销毁 iframe。再次打开 = 新实例，从 `storage` 恢复。
- **崩溃**：iframe `error` / 无响应 3s → 显示「微应用无响应」+ 重新打开；不自动循环重试。
- **不做后台常驻 / 定时唤醒**：AI 写的定时代码是电量与安全的双重风险；需要提醒就用 Bot 的定时任务（`schedules`），由 Bot 发消息，不靠微应用自己活着。

### 9.2 会话恢复

- 微应用在 `app.pause` 与 `visibilitychange` 时把必要状态写 `storage`（键前缀 `session:`）。
- 再次打开时微应用自己读回；平台不代存 DOM。
- 平台提供 `kepcup.app.instanceId`（只读），用于区分「同一张卡片的多次打开」。

### 9.3 多实例

- 同一微应用可在不同对话各开一个实例，数据共享（按微应用隔离），会话状态按实例分开。
- 管理页可「在新对话打开」；不做同一对话多窗口。

---

## 10. 数据平面

| 类型 | 方案 | 配额 |
|---|---|---|
| 键值 | 现有 `widget_docs` + `kepcup.storage` | 1MB / 1000 键 |
| 结构化集合（P2） | `kepcup.collections`（文档 + 主键 + 简单索引），底层同表或新表 | 5MB / 10 集合 |
| 只读宿主数据 | 现有命名查询模板（两张作用域视图） | 沿用 32 §6.1 |
| 包内只读资源 | `micro_app_files`，经协议源同路径取 | 8MB / 64 文件 |
| 用户选择的文件（P3） | `files.pick` 返回只读副本句柄 | 单文件 20MB |

不支持：任意 SQL、跨微应用查询、写宿主表、直接读用户工作目录。

---

## 11. 制作流程升级（复用 32 §11）

状态机不变（SPEC → BUILD → GATE → REVIEW → FIX → DELIVER），改动在每阶段的产物与检查：

| 阶段 | 组件（今天） | 微应用（目标） |
|---|---|---|
| SPEC | `spec.md` + 验收点 | 增「能力清单与理由」「降级路径」「每轮对话成本估算」 |
| BUILD | 单 `index.html` + 模板 | `micro-app.json` + 多文件 + 从模板起步（语音陪练模板、表单模板、看板模板） |
| GATE S0/S1 | HTML/JS 静态检查 | 增清单校验、权限最小性、SDK 一致性（只调用声明能力）、资源路径与体积 |
| GATE S2 | 离线真实预览 + 冒烟 | 宿主能力 mock：`ai.chat` 返回脚本化回复、`media.listen` 注入 fixture 转写、`media.speak` 记录不发声；跑通「一轮完整对话」 |
| REVIEW | 结构化 P0–P2 | 增：儿童内容安全、隐私（录音/外传）、成本、无麦克风时的降级 |
| DELIVER | 写版本 + 发卡 | 写清单 + 包 + 用量预算，卡片展示能力清单 |
| 基准 | 10 条需求 | 增 3 条语音/对话类需求；门槛「无阻断交付 ≥8/10」不变 |

- 预览仍**离线**：mock 的 `ai.chat` 不联网，`net.fetch` 直接失败并归 `preview.offline-network`。
- 检查器新增规则（示例）：`app.manifest-invalid`、`app.permission-undeclared`、`app.permission-overbroad`（声明了 `media.listen` 但代码从未调用 → warning）、`app.cost-estimate-missing`、`app.fallback-missing`（声明了 `media.listen` 但没有文字输入回退 → warning）。
- 制作提示由 `sdk.md` 生成，禁止手写第二份 API 清单。

---

## 12. 安全与隐私

### 12.1 威胁模型

| 威胁 | 入口 | 对策 |
|---|---|---|
| 生成代码做恶意事 | 微应用 JS | iframe 沙箱 + 能力白名单 + 无 Node/FS/IPC |
| 越权拿数据 | 桥 | 按版本能力校验 + 数据按微应用隔离 + 只读作用域视图 |
| 偷录 | 麦克风 | 宿主代理采集 + 常驻指示 + 会话授权 + 关闭即释放 |
| 录音外带 | 网络 | 原始音频不出宿主（只给转写文本）；默认允许联网，确认卡明示 |
| prompt 注入 | 语音转写 / 模型输出 | 微应用上下文隔离、回传确认、输出按不可信渲染 |
| 成本放大 | `ai.chat` | 每会话 / 每微应用 / 每 Bot 每日 token 预算 + 并发 1 + 用量可见（计入所属 Bot） |
| 供应链 | 清单/资源 | 闭合枚举 + 包摘要 + 按版本确认 + 可选域名白名单 |
| 伪装平台 UI | DOM | MicroAppChrome 在 iframe 外，微应用无法覆盖 |
| 崩溃拖垮宿主 | iframe | 独立进程（Chromium 站点隔离）+ 无响应检测 + 单实例关闭 |

### 12.2 儿童场景的额外约束（本例）

- 平台默认允许联网；**儿童向模板建议在清单里主动收紧为 `net: none` 或 `net: allowlist`**，并在确认卡上突出网络范围。
- 不收集姓名/位置/学校等字段；微应用使用 `files.pick` 或把网络收紧为 `none` / `allowlist` 时，确认卡按对应范围提示。
- 录音默认不保存；微应用若声明保存，必须在确认卡上单独一行。
- 模型系统提示加「与儿童对话」边界（不索要个人信息、不引导线下见面、遇到不当内容引导找家长）。
- 这些是**产品策略**，不是安全边界；安全边界仍是沙箱 + 能力 + 授权。

### 12.3 审计

- `micro_app_audit(widget_id, version, capability, outcome, duration_ms, at)`：只记能力与结果，不记内容。
- 用户可在微应用管理页看「它用过什么」；异常调用（如 1 分钟内 50 次 `ai.chat`）在管理页标红。

---

## 13. 与现有设计与资产的关系

### 13.1 文档关系

- 32 号：保留组件形态、版本确认、制作流程；§5–§8 的能力面结论由本文取代。已在 32 号头部加了指针。
- 31 号：麦克风仍由传感器层负责；本文只新增「传感器 → 微应用桥」的代理路径，不改传感器抽象。
- 53 号：语音对话模式是**宿主自己的**语音交互；本文的 `media.listen/speak` 是**微应用侧**的同一套底层能力，两者共用 `media.*` 与播放队列，但状态机分开（宿主语音条 vs 微应用实例）。
- 16 / 40 号：模型与能力挂载语义不变；`ai.chat` 是新的调用入口，不走工具面。
- 37 号（资产移交）：微应用作为 Bot 资产复制时，连同清单、全部版本、`micro_app_files`、KV 一起复制；用量不复制。

### 13.2 命名与迁移

- 用户可见：统一叫「微应用」（2026-11-02 决策）；宿主仍叫「主应用」。
- 代码：新增模块目录用 `micro-apps/`、类型前缀 `MicroApp*`、RPC 命名空间 `microApps.*`、清单 `micro-app.json`、SDK 路径 `micro-app-sdk/`。
- 数据库：存量表暂留 `widget_*`（`widgets.bot_id` 仍是计费归属的锚点），新增表用 `micro_app_*`；契约稳定后做一次纯改名迁移，并在 `docs/dev/03-data-model.md` 注明「历史命名，语义为微应用」。
- 存量组件：`manifest_json` 为空即按「单文件、无能力」处理，行为完全不变。
- 不做双运行时：同一套 `MicroAppService` / 桥 / 卡片，避免两套确认与两套安全检查。

---

## 14. 分期与验收

### P0：契约与骨架（不改变用户可见行为）

- `micro-app.json` 清单、能力枚举、`bundle_sha256`、确认卡能力清单、桥协议 v2（call/stream/event/cancel）。
- SDK spec 单一事实来源 + 生成垫片 / d.ts / sdk.md / 检查规则 / mock 的骨架。
- 存量组件按「无清单」继续工作。
- 验收：带 `storage.kv` 的清单微应用能打开；未声明能力调用被拒；确认卡显示能力；旧卡行为零变化。

### P1：语音与模型（本次需求的核心）

- `ai.chat` / `ai.session`（流式、隔离、限额、记账）。
- `media.listen`（宿主采集 + VAD + ASR）、`media.speak`（TTS + 打断）。
- MicroAppChrome、麦克风指示、能力撤销、降级路径。
- 验收：英语口语陪练示例可完成「角色问候 → 用户说话 → 转写 → 模型回复 → 播报 → 插话打断」整轮；关掉麦克风权限后回退文字输入；用量在管理页可见且计入所属 Bot；缺 ASR 配置时给设置引导。

### P2：包、数据与生命周期

- 多文件包与 `micro_app_files`、相对路径、资源配额。
- `collections`、会话恢复、前后台事件、崩溃恢复。
- 微应用管理页（列表 / 能力 / 用量 / 删除 / 发到当前对话）。
- 验收：多文件微应用可正常加载（相对资源、子目录、资产）；关闭再打开恢复进度；崩溃不拖垮宿主。

### P3：制作流程与微应用生态前身

- 制作 loop 支持多文件项目、清单检查、能力最小性、能力 mock 预览、儿童安全审查项。
- 模板：语音陪练、表单收集、数据看板。
- 基准：13 条需求（含 3 条语音/对话），门槛不变。
- 验收：非一线模型经制作流程交付的语音微应用无阻断、可通过 S2 全流程。

### P4：分发与共享

- 微应用模板导出 / 导入、Bot 间移交、开发者模式（本地目录迭代）。
- 微应用市场**只做评估，不实施**（与 51 号插件市场的关系另行设计）。

---

## 15. 验收标准（以示例为准）

用户需求：*「帮我创建一个微应用，小朋友要练习英语口语，一个虚拟人物与小朋友用英语持续对话。」*

必须全部满足：

1. Bot 经 `widget_craft` 交付，任务上下文只收回执，不见代码。
2. 卡片显示：微应用名、版本、能力清单（存储 / 模型 / 麦克风 / 播报）、网络范围（默认「可联网」或声明的收紧档）、预计成本与计费 Bot。
3. 首次打开需确认；代码或权限变化需重新确认。
4. 打开后：虚拟角色用英语问候（TTS 播报），字幕同步。
5. 点麦克风（或自动 VAD）说话 → 转写文本出现在对话流 → 模型用英语回复 → 播报。
6. 用户插话 → 立即停止播报，进入下一轮。
7. 关闭再打开 → 继续上次的练习进度与角色设定。
8. 拒绝麦克风 → 自动切到键盘输入，微应用仍可用。
9. 每次练习结束展示「本次约 N token，计入 Bot「X」」；管理页可看该 Bot 的累计用量。
10. 断网 / 模型失败 → 可读错误 + 进度保留，不白屏。
11. 预览（S2）离线跑通一整轮（mock ASR / 模型 / 播报），不依赖真实网络。
12. 检查器无阻断项；自检状态如实上卡，不暗示「安全」。

---

## 16. 明确不做 / 开放问题

### 不做

- 微应用代码进宿主进程、`nodeIntegration`、core 内执行生成 JS（永久不做）。
- 宿主能力越界：任意 SQL、文件系统、子进程、读取 `secrets`（永久不做）。
- **发音评分**（2026-11-02 决策）：`media.listen` 只返回转写文本，不提供音素 / 发音打分；如将来需要，单独立项（依赖厂商评分 API）。
- 微应用后台常驻 / 定时唤醒 / 开机自启（需要提醒走 Bot 定时任务）。
- 全双工实时语音（依赖厂商流式 ASR，单独立项）。
- 微应用间互相调用、共享数据、读取彼此存储。
- 微应用市场（P4 只评估）。

### 已拍板（2026-11-02）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 默认是否允许联网 | **允许**：`net.mode` 缺省 `open`，作者可收紧为 `allowlist` / `none`；确认卡明示 |
| Q2 | 模型费用归属 | **计入编写该微应用的 Bot**（`widgets.bot_id`）；每微应用每日 200k token、每 Bot 每日合计 1M token 起步，管理页可调 |
| Q3 | 是否给原始音频做发音评分 | **不做**；只给转写文本与电平 |
| Q4 | 用户可见命名 | **微应用**；宿主仍叫「主应用」，代码前缀 `MicroApp*` |

### 仍待决策

| # | 问题 | 建议 |
|---|---|---|
| Q5 | 多文件 vs 单文件 | 多文件（清单 + 资源），单文件作为退化形态保留 |
| Q6 | 微应用能否被其他 Bot 使用 | 先只做同 Bot 内 + 移交复制；跨 Bot 共享后议 |
| Q7 | 是否允许微应用发系统通知 | P3，默认关，用户总闸 |

---

## 附录 A：英语口语陪练示例

### A.1 清单

```json
{
  "spec": "kepcup-micro-app/1",
  "slug": "english-corner",
  "name": "小小英语角",
  "description": "和 Emma 老师用英语聊天，练口语",
  "entry": "index.html",
  "display": { "mode": "immersive", "minHeight": 560 },
  "permissions": ["storage.kv", "ai.chat", "media.listen", "media.speak"],
  "ai": { "profile": "micro-app.light", "maxTokensPerSession": 20000 },
  "net": { "mode": "none" }
}
```

> 本例面向儿童，清单主动收紧为 `net: none`；平台默认是 `net: open`（2026-11-02 决策）。

### A.2 微应用侧伪代码（约 60 行）

```js
const system = `You are Emma, a friendly English teacher for a 7-year-old Chinese kid.
Speak simple English (A1), one or two short sentences per turn, then ask one question.
Never ask for personal information.`;

const session = await kepcup.ai.session({ system, maxTurns: 40 });
const mic = await kepcup.media.listen({ lang: 'en-US', mode: 'vad' });

mic.on('level', drawWave);
mic.on('final', async ({ text }) => {
  if (!text.trim()) return;
  appendBubble('child', text);
  const reply = await session.send(text, { stream: true });
  for await (const { delta } of reply) appendDelta('emma', delta);
  await kepcup.media.speak({ text: reply.text });
});
mic.on('speech-start', () => kepcup.media.stopSpeaking());

await kepcup.media.speak({ text: 'Hi! I am Emma. What is your name?' });
await mic.start();

document.querySelector('#keyboard').onclick = () => {
  // 降级路径：没有麦克风权限时仍可练
};
```

### A.3 时序

```
用户点开卡片 ──► 确认（能力清单）──► MicroAppRuntime 启动
  └─ 微应用: kepcup.media.listen()
       └─ 宿主: sensors.open('microphone') → VAD
  └─ 微应用: ai.session(system) → 首句问候 → media.speak()
用户说话 ──► 宿主: 端点检测 → transcribeSpeech → event 'final'
  └─ 微应用: ai.session.send(text) ──► core: microAppChat(stream)
       └─ event 'delta' × N ──► 微应用渲染字幕
  └─ 微应用: media.speak(reply) ──► 宿主: TTS → 播放
用户插话 ──► 宿主: stopSpeaking + 丢弃队列 ──► 新一段采集
关闭 ──► pause → 写 storage → iframe 销毁 → 麦克风释放
```

### A.4 成本粗算（用于确认卡文案，不是报价）

一轮（用户 8 秒语音 + 模型 80 token + 播报 40 字）：

- ASR：1 段 × 8s
- 模型：输入约 600 token（系统 + 历史 6 轮）+ 输出 80 token
- TTS：40 字

10 分钟约 12–15 轮，累计约 1.2 万 token。与清单的 2 万/会话预算一致；全部计入编写该微应用的 Bot（本例为「Emma 老师」）。

---

## 附录 B：差距索引（现状 → 目标）

| 缺口 | 现状锚点 | 目标 |
|---|---|---|
| 能力白名单硬编码 | `core/widgets/sdk-injection.ts:164-201`、`features/widgets/widget-bridge-guard.ts:20-31` | 清单声明 + 桥按版本校验 |
| 无事件通道 | `widget-bridge-host.ts` 请求/回执 | 协议 v2：stream / event / cancel |
| 无模型调用 | `window.kepcup` 无 `ai.*`；`rpc/bindings.ts` 无微应用模型入口 | `ai.chat` / `ai.session` + 记账 |
| 无麦克风 | `WidgetRuntime.svelte:285` `allow=""`；采集在 `features/sensors/hub.ts` | `media.listen` 宿主代理 |
| 无播报 | 53 号语音模式仅宿主 UI | `media.speak` + 打断 |
| 单文件 | `0028_widgets.sql` `html TEXT` | `micro_app_files` + 清单 + 资源 |
| 无生命周期 | `WidgetViewer.svelte` 关闭即卸载 | pause/resume/恢复/崩溃处理 |
| SDK 多处漂移 | `sdk-injection.ts` / `craft/prompts.ts` / `check/rules.ts` / `widget-templates.ts` | `micro-app-sdk/spec.ts` 单一事实来源 |
