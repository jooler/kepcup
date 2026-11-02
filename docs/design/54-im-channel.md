# 54 即时通讯通道（IM Channel / `im` 能力类型）

> **状态：已实现（P1 + P2，2026-11-03）**，分支 `feat/im-wechat`。首个插件：个人微信（iLink Bot API），插件源与实现文档见 [plugins/im-wechat/README.md](../../plugins/im-wechat/README.md)。
>
> 决策：**D107**（`im` 能力类型）、**D108**（首发个人微信）、**D109**（入站管线）、**D110**（出站自动转发，Bot 无感）、**D111**（同步开关与自动补勾）。
>
> 相关：D84（邮件通道——实例型通道的机制范本）、D104/D105（插件系统，[51](51-plugin-system.md) §15 能力类型注册表与 §15.7「短信 / 电话 / 传感器」路标）、D73（污点 / 外发台账 / 审批）、D75（对话轮 mailbox）、D80（定时与主动消息护栏）、D91（能力目录与挂载）、D96（远程端点——哑中转与保活参考）、D102（Headless：通道必须无窗口可用）。

## 决策

- **D107 `im` 能力类型（即时通讯）**：在 `skill / connector / mcp / mail` 之外新增**通用**贡献类型 `im`，不设「微信」专用 kind——微信、企业微信、Telegram 等都是 `im` 插件，一个 kind 一套宿主机制，插件只声明「供给规范」。与 mail 同配方：`instances: ['im']` + 恰一份 `contributions.im`（双向配对强制），贡献声明 transport / 端点 / 建号方式 / 能力面 / 实例字段，账号由用户逐个添加、materializer 落地。`im` 进 §15.1 能力类型注册表（`CAPABILITY_KINDS`），走 write-a-plugin.md §9「宿主侧菜谱」全清单（含 4 个手工点与迁移，新迁移从 **0059** 起）。宿主为 `im` 提供的**不是工具面**（与 mail 的 `mail_*` 五件套不同），而是入站管线 + 出站转发器（见 D109/D110）——IM 的语义是「通道」，不是「Bot 的技能」。
- **D108 首发个人微信（iLink Bot API）**：首个 `im` 插件走微信 2026 年开放的 iLink Bot 通道（扫码登录 → `bot_token` → 长轮询收 / HTTPS 发，API base `https://ilinkai.weixin.qq.com`）。企业微信（自建应用 + 微信插件接收）作为**独立的后续 `im` 插件**（transport `wecom-app`，secret 表单建号），不混入首个插件。
- **D109 入站管线**：用户可以在微信上给 Bot 发指令。每账号一条长轮询会话（宿主确定性，禁止 Bot 自行轮询，同 D84 收信立场）→ ingest 去重 → 按 `im_account_bots` 绑定扇出 → 持久作业 `im_alert` → 私聊贴卡 + 唤醒对话轮。`triggerReasonSchema` 增加 `'im'`；入站内容整块 `<untrusted>`；账号绑定了 0 个 Bot 时消息丢弃并 `app.notice` 提示。
- **D110 出站 = 宿主自动转发，Bot 无感**：**不设** `im_send` 工具（Bot 工具面零新增）。Bot 最终回复落库后，宿主转发器对「该 Bot 名下开启了同步的 IM 账号」自动转发。转发是**通道镜像**不是工具调用：不走网关审批（用户开启同步即持续授权），但记 D78 外发台账、有每账号限流与失败退避。理由：IM 回复的目标固定是用户本人自己的微信账号，方向是「回复用户」而非「Bot 主动外发」；审批卡会打断「在微信上聊天」的闭环。
- **D111 「同步消息到此微信」开关 + 入站自动补勾**：绑定粒度上的转发开关 `forward_enabled`（Bot 详情 → 插件 → IM 账号行）。**绑定即入站**（微信永远能发消息给 Bot，与开关无关）；**勾选才出站**（Bot 回复自动同步到微信）。开关语义 =「现在没必要转发」（用户在电脑前）。**自动补勾**：开关关闭时收到该账号的微信入站消息 → 自动置为开启 + 一次性用户可见提示（「检测到你从微信发来消息，已开启同步」）——用户不在电脑前也用微信说话，转发应当跟上。**永不自动取消**（避免状态抖动；用户回电脑后手动关闭）。

## 1 目标与非目标

**目标**

- 用户新增一个（或多个）IM 账号（首发：个人微信），把账号交给一个或多个 Bot；同一账号可绑多个 Bot，各 Bot 独立开关同步。
- 用户在微信上给 Bot 发消息 → Bot 私聊被唤醒并处理（入站近实时，长轮询）。
- Bot 的回复在同步开启时自动出现在用户微信上，Bot 与提示词全程无感知、无需调用任何工具。
- 凭据只存本机 secrets；连接状态、失败、限流走 `app.notice`，不污染对话。

**非目标（本期不做）**

- Bot 主动给任意微信联系人 / 群发消息（`im_send` 类工具）；IM 通道只服务「用户 ↔ 自己的 Bot」。
- 群聊语义（把 Bot 拉进微信群）；企业微信（独立插件后置，D108）。
- 微信朋友圈 / 公众号交互；音视频通话。
- 机器人对多人会话的路由（首期只处理与授权用户本人的会话，其他来源丢弃并计数）。
- 跨设备同步 IM 账号配置到云。

## 2 能力类型契约（`im` 贡献）

### 2.1 清单形状

```jsonc
// plugin.json（节选；完整示例见 plugins/im-wechat/plugin.json）
{
  "instances": ["im"],
  "contributions": {
    "im": [{
      "id": "wechat",                      // 贡献 id，≤1 份且必须与 instances 双向配对
      "label": "微信",
      "transport": "ilink",                // 通道协议，决定宿主会话实现与建号 UI
      "apiBase": "https://ilinkai.weixin.qq.com",  // transport 要求端点时必填且锁定（https 公网）
      "setup": "qrcode",                   // 建号方式：'qrcode' 扫码授权 | 'secret' 密钥表单（企业微信等）
      "features": {
        "inbound": true,                   // 收：可唤醒 Bot
        "outbound": true,                  // 发：可转发 Bot 回复
        "media": ["text", "image", "voice", "file", "video"]  // 声明面；宿主按 transport 实际实现裁剪
      },
      "instanceFields": []                 // 与 mail 同 schema（pluginFieldSchema，≤16）；qrcode 建号通常为空
    }]
  }
}
```

- `pluginContributionKindSchema` 加 `'im'`；`PLUGIN_INSTANCE_KINDS` 加 `'im'`（`packages/shared/src/domain/plugin-manifest.ts:30,42`）。
- 新增 `pluginImContributionSchema`（严格对象，仿 `pluginMailContributionSchema`：transport 枚举白名单、`apiBase` https 校验与 trim 纪律、`instanceFields` 查重、`features.media` 与 transport 相交校验）。校验规则：`setup: 'qrcode'` 时 contribution **不得**声明 sensitive 实例字段（扫码流程没有表单）；`setup: 'secret'` 时至少声明一个 sensitive 字段作为密钥。
- manifest 级配对校验同 mail：有 `contributions.im` ⇔ `instances` 含 `'im'`，且至多一份。

### 2.2 注册表与四个手工点（§15.1 菜谱）

1. `packages/core/src/plugins/kinds.ts`：`CAPABILITY_KINDS` 追加 im adapter（`contributionSchema: pluginImContributionSchema`、`consentKey: 'im'`、`hasInstances: true`、`instanceFields: imInstanceFields()`、`createProjector: () => new ImProjector()`）。
2. `PluginInstanceStore.countsOf` 的 kind 计数列表加 `'im'`（`instances.ts:246`）。
3. `pluginCapabilitySummary` / `pluginCapabilitySummaryFromCategories` 加 im 文案与标签（`plugin-manifest.ts:298`）。
4. `mergeConsentItems` 的 consent 收口 switch 加 `'im'`（`kinds.ts:239`）；`ConsentItem` / `CapabilityConsentKey` / `ProjectedKind` / `emptyOwned()` 同步扩展。

### 2.3 projector → materializer

- **Projector**（`projectors/im.ts`）：只记账（`ledger.add('im', …)`）+ 同意视图（label、transport、端点主机、inbound/outbound），零运行时状态。
- **Materializer**（`materializers/im.ts`）：
  - `create`：按 `setup` 分流——`qrcode`：宿主弹扫码卡（`get_bot_qrcode` → 用户微信扫码确认 → 轮询到 `confirmed` 取 `bot_token` / `ilink_bot_id`）；`secret`：渲染实例表单收集字段。随后连接测试（长轮询握手）→ `im_accounts` 落行（带 `instance_id`）→ 凭据入 secrets → 启动会话。
  - `update`：token 失效重扫 = 更新流程重跑扫码；sensitive 留空读存量 secret（`ctx.readStoredSecret`，同 mail）。
  - `remove`：`im.deleteByInstance()` 级联删账号 / 绑定 / secrets / 停会话（幂等）。
  - 启动对账 `reconcileImInstanceRows`（仿 `reconcileMailInstanceRows`，清孤儿行）。
- 装配：`start.ts` `pluginInstances.registerMaterializer('im', createImMaterializer(im))`。

### 2.4 transport 路标

| transport | 建号 | inbound | outbound | 插件 |
|---|---|---|---|---|
| `ilink` | 扫码 | ✔ 长轮询 | ✔ sendmessage | **im-wechat（本迭代）** |
| `wecom-app` | corpid / agentid / secret 表单 | 回调 / 轮询（待设计） | ✔ 应用消息 | 后续独立插件 |
| `telegram-bot` | bot token 表单 | ✔ getUpdates | ✔ sendMessage | 后续 |
| `webhook` | webhook URL 表单 | ✘ | ✔ 单向推送（钉钉 / 飞书群机器人） | 后续（只有 outbound 的账号不能绑 Bot 入站，仅转发） |

## 3 数据模型与凭据

- **迁移 0059**（`plugin_instances.kind` CHECK 加 `'im'` 重建表）+ 新表：
  - `im_accounts`：`id` / `plugin_id` / `instance_id`（FK `plugin_instances`，卸载级联）/ `transport` / `label`（显示名，微信取 Bot 昵称或「微信」）/ `api_base` / `status`（`connecting | ready | paused | auth_failed | error`）/ `last_error` / `last_inbound_at` / `last_outbound_at` / `config_json`（非敏感会话元数据：`ilink_bot_id`、登录时间等）。
  - `im_account_bots`：`account_id` / `bot_id` / `forward_enabled`（默认 0）/ `forward_updated_at` / `created_at`，唯一 `(account_id, bot_id)`。**绑定与开关都是账号级、可多对多**；多 Bot 绑同一账号时各自独立开关，转发互不影响（同一账号的入站消息仍可唤醒多个 Bot，幂等键含 botId）。
- secrets：`plugin:{pluginId}:instance:{instanceId}:bot_token`（sensitive；命名转义同 `instances.ts:33`）。token 只在 core 发请求那一刻取用，**永不进模型上下文与对话内容**。
- 无 settings 目录条目：入口在扩展中心插件卡与 Bot 详情（per-binding 状态，非全局标量），与邮件同一立场。

## 4 个人微信通道（iLink Bot API 摘要）

已核实（2026-11-03）：官方生态插件 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（OpenClaw 微信渠道，MIT）与最小示例 [zhuweiyou/weixinbot](https://github.com/zhuweiyou/weixinbot) 均基于同一 iLink Bot API；协议表面见其 `docs/protocol.md`。

| 环节 | 事实 |
|---|---|
| 登录 | `get_bot_qrcode` 出二维码 → 用户微信扫码确认 → `confirmed` 返回 `bot_token` + `ilink_bot_id` + `baseurl`；token 本地保存 |
| 收 | `getUpdates` 长轮询（约 35s 超时），独立于发送端点 |
| 发 | `POST /ilink/bot/sendmessage`（HTTPS JSON，`Authorization: Bearer <bot_token>`）；媒体先传 CDN（AES-128-ECB）再引用 |
| 消息类型 | 文本 / 图片 / 语音 / 文件 / 视频；媒体与文字分请求发送 |
| 异常 | `ret`/`errcode = -14` 触发一小时会话暂停；其余按退避重试 |

**协议待实测清单（P0 PoC）**——**实测结果（2026-11-03 回填；脚本 /tmp/im-poc/poc.mjs，观察日志 poc-observations.log，授权 bot_id 9ce8ca851f68@im.bot）**：

1. **主动发送**：**被拒绝**——不带 `context_token` 直接 `sendmessage` 返回 `ret:-2 "prepare failed"`（空 `context_token` 字段同样被拒）。**D110 按预案降级**：出站转发必须有可用的会话上下文，实现为「无 context 发送失败 → 自动用该账号最近一次入站的 `context_token` 重试」（§6 转发器内建降级路径）。开关「默认关」的体验语义不变。
   - **实机首测补充（2026-11-03，用户实测）**：带最近入站 `context_token` 的回复仍被拒 `ret:-2 "invalid arguments"`——根因是宿主客户端此前只在长轮询请求带 `X-WECHAT-UIN`，`sendmessage` 缺该头会被**更早的参数校验层**打回（与 #5「参数缺失 → invalid arguments」归类吻合，早于 context 校验的 `prepare failed`）。修复：所有请求都带 `X-WECHAT-UIN`（`im/ilink.ts`；weixinbot 参考实现同为每请求携带）。带 context_token 的回复链路本身待复测确认（首次真实触达）。
2. `bot_token` 有效期：登录后 >1 小时 `msg/notifystart` 探活 `ret:0`；多天观察与 `-14` 暂停行为由 PoC 日志继续跟踪；失效重扫已实现（`im.accounts.reauthorize` → materializer update 消费扫码 pending）。
3. 会话范围：**待实测**（需第二个微信号给 Bot 发消息对照；宿主已按「只处理与授权用户本人的会话」实现过滤，见 §5）。
4. 消息长度 / 频率上限：**待实测**（主动发送被拒，须随 #3 一批带 context_token 测）；截断阈值暂按 2000 字符实现（`IM_FORWARD_MAX_CHARS` + 尾注「完整内容见 KepCup」）。
5. 协议稳定性：错误面小而一致——未认证 `errcode:-14 "session timeout"`（token 缺失、方法错用都归到这里）、参数缺失 `ret:-2 "invalid arguments"`、目标无效 `ret:-3`、未知端点 HTTP 404；`msg/notifystart|notifystop` 心跳 `ret:0`。与 openclaw-weixin 协议卡一致，接口命名与错误码可依赖；iLink 客户端隔离在 `im/ilink.ts` 单文件不变。

## 5 入站管线（用户微信 → Bot）

```
ImSessionHub（每账号 1 条长轮询，指数退避重连；auth 失败停试 → status='auth_failed' + notice）
  → ingest()（幂等去重键 im:{accountId}:{msgId}；只处理与授权用户的会话，其余丢弃计数）
    → 按绑定扇出（im:{accountId}:{msgId}:{botId}）
      → jobs.enqueue(type:'im_alert', priority:2, dedupeKey)   ← 持久作业，崩溃可恢复
    → 自动补勾（D111）：绑定存在且 forward_enabled=0 → 同事务置 1 + 一次性提示
  → jobs-runner 调 runAlertJob()：
      → Bot 私聊贴卡（cardType:'im'，事件 'arrived'：渠道、摘要；幂等查重）
      → taint.mark(botId, conversationId)                        ← 读过外部内容即污染
      → deliverImAlertToBot → deliverEventToBot(internal)        ← orchestrator 新增，同 mail_alert
      → mailbox.deliver({ reason:'im' })
```

- `triggerReasonSchema` 加 `'im'`（`packages/shared/src/domain/types.ts:1614`）+ mailbox 用户可见判定 + 上下文渲染分支。
- 唤醒消息整块 `<untrusted>`（微信文本是外部内容，注入风险高于邮件：联系人名、表情、引用都可能藏指令）。
- 入站目标会话 = 该 Bot 的私聊（DM）；不存在则按 `openDirect` 语义创建。
- 限流：每账号每小时入站告警上限（仿 `MAIL_MAX_ALERTS_PER_HOUR`），超限合并为一条摘要；TriggerBatch 既有合并与 quiet-hours 停放机制原样生效。
- 绑定 0 个 Bot 的账号收到消息：入站不建立绑定，丢弃 + `app.notice`（「微信消息已到达，但该账号尚未绑定任何 Bot」）。
- 账号属主插件未 ∈ Bot 有效启用集（`effectivePluginIds`）时，绑定对唤醒与转发同样不可见（与 mail 三处同源过滤同一纪律）。

## 6 出站：自动转发（Bot → 微信，Bot 无感）

**转发器（forwarder）**：core 内服务，订阅 EventBus `message.created`（与 D106 语音播报同一事件信号；**在 core 订阅而非渲染层**——窗口关闭、后台、headless（D102）都必须转发）。

- **触发过滤**：`role = assistant` 的**最终**回复（不转发流式中间态 / internal 系统消息 / delegation 代发 / Bot 私有时间线）且会话为「用户 ↔ 该 Bot」的私聊。
- **选账号**：该 Bot 名下 `forward_enabled=1` 且属主插件已启用的 im 账号 → 每账号入队一个持久作业 `im_forward`（dedupeKey `im_forward:{messageId}:{accountId}`，进程崩溃不丢不重）。
- **内容规则**：Markdown → 纯文本（首期剥格式，不渲染）；超长截断（阈值按 PoC §4-4 定，暂 2000 字符 +「…（完整内容见 KepCup）」）；卡片 / 附件 / 媒体首期给降级文案（「Bot 生成了{卡片|文件}，请在 KepCup 中查看」）。
- **发送**：作业内取 token → `sendmessage`；成功更新 `last_outbound_at` 并记 **D78 外发台账**（channel=`im-{transport}`、目标=账号 label、messageId 关联）。
- **失败**：退避重试 3 次后放弃 + `app.notice`（连续失败 3 轮才提示一次，恢复撤提示，同 mail 通知纪律）；`auth_failed` 停转发并提示重扫。
- **限流**：每账号每小时转发上限（暂 60 条），超限合并降级（防 Bot 高频短回复刷屏微信）。
- **不做的事**：不转发审批卡正文（审批必须在应用内完成，防「在微信上批准危险操作」的降级路径）；不做污点联动的特殊处理——转发目标固定为用户本人的账号且内容源自用户自己的对话，泄露面等同于应用内回复，照转 + 台账（若 PoC 发现陌生人可触达 Bot 会话，重新评估并收紧 §5 过滤）。
- **与主动消息护栏的关系**：转发跟随消息本身，不另设 quiet hours（用户开启同步即同意接收）；定时 / 监看触发的主动消息在进入对话前已被 D80 护栏裁决，转发不再重复裁决。

## 7 「同步消息到此微信」与自动补勾（D111）

| 状态 | 入站（微信 → Bot） | 出站（Bot → 微信） |
|---|---|---|
| 绑定 + 未勾选 | ✔ 永远可用 | ✘ 不转发 |
| 绑定 + 勾选 | ✔ | ✔ 自动转发全部回复 |
| 未绑定 | ✘（消息丢弃 + notice） | ✘ |

- **开关位置**：Bot 详情 → 插件 → IM 账号行内（每账号一个），文案「同步消息到此微信」，副文案「Bot 的回复将自动同步到该微信；关闭后你在微信发消息时仍会自动开启」。
- **自动补勾**：仅一种触发——`forward_enabled=0` 的绑定收到入站消息。同事务置 1，并向用户发一次性提示（对话内系统事件 + `app.notice` 各一，文案「检测到你从微信发来消息，已开启同步」）。
- **永不自动取消**：用户在应用内的任何活动都不改写开关（防状态抖动）；回电脑后由用户手动关闭。开关变更记 `forward_updated_at` 供排障。
- **多 Bot**：同一微信账号绑定 N 个 Bot，各自开关独立；用户在微信发的一条消息会唤醒所有绑定的 Bot 并分别补勾各自的绑定。

## 8 产品形态与 UI

| 位置 | 内容 |
|---|---|
| 扩展中心插件卡「管理」（im 账号领域视图，仿 §15.5 邮件） | 账号列表（label、transport 徽标、状态、最近收发时间、绑定 Bot 数）；「添加账号」→ 扫码卡（二维码 + 状态 + 失败重试）；账号详情（端点、`ilink_bot_id`、最近错误、暂停 / 删除） |
| Bot 详情 → 插件 | im 账号勾选绑定（与邮箱并列）；绑定行内「同步消息到此微信」开关（§7） |
| 应用状态 | 连接中断 / 认证失效 / 限流 / 转发失败走 `app.notice`（不落库不进上下文），连续失败才提示、恢复撤销——全部沿用 mail 通知纪律 |
| 对话 | 入站消息卡 `cardType:'im'`（事件 `arrived`，摘要不自动展开全文）；Bot 回复无任何 IM 痕迹（无感转发） |

## 9 安全与隐私

1. 凭据：token 只在 core 取用瞬间存在；实例 secrets 命名与转义沿用 `instances.ts:33`；日志与错误信息一律脱敏（`secrets.redact`）。
2. 入站 `<untrusted>`：微信文本、联系人名、引用消息全部视为不可信内容；污点机制照常生效。
3. 外发台账：每次转发记 D78 台账（谁、何时、转发哪条消息到哪个账号）。
4. 限流三道：入站告警上限、转发上限、会话退避（-14 暂停），防刷屏与封号风险。
5. 插件体系零代码执行不变：`im` 插件只携带声明，transport 实现（iLink 客户端等）全部是宿主内建代码，随应用签名分发、可审计。

## 10 实现锚点

| 层 | 文件 |
|---|---|
| shared | `packages/shared/src/domain/plugin-manifest.ts`（kind 枚举 / `PLUGIN_INSTANCE_KINDS` / `pluginImContributionSchema` / capabilitySummary）、`packages/shared/src/domain/types.ts`（`triggerReasonSchema` 加 `'im'`）、新 `packages/shared/src/domain/im.ts`（行类型 / 作业 payload / 事件 payload） |
| core 插件 | `packages/core/src/plugins/kinds.ts`（adapter + `imInstanceFields` + consent）、`projectors/im.ts`、`materializers/im.ts`、`plugins/instances.ts`（countsOf / materializer 接口不动）、`start.ts`（装配与对账） |
| core 通道 | 新 `packages/core/src/im/`：`store.ts` / `service.ts`（ingest / runAlertJob / 转发排队）/ `session.ts`（ImSessionHub）/ `ilink.ts`（协议客户端，transport 隔离点）/ `forwarder.ts`（订阅 `message.created`）；`dispatch/orchestrator.ts`（`deliverImAlertToBot`）；`scheduler/mailbox.ts`（reason 渲染）；作业类型 `im_alert` / `im_forward` |
| 迁移 | `0059_plugin_im`（`plugin_instances.kind` CHECK + `im_accounts` + `im_account_bots`） |
| 渲染层 | 插件卡 im 管理视图与扫码卡、Bot 详情插件区绑定 + 同步开关（`apps/desktop` 设置卡体系零新增条目） |
| 校验 | `packages/app-validator`：im 贡献校验（transport 白名单、setup/features 交叉规则、apiBase https） |
| 测试（定向） | shared manifest 契约测试、`CAPABILITY_KINDS` 派生的覆盖率测试（自动纳入新 kind）、im store / service / forwarder 单测（转发过滤、补勾、幂等、限流）、RPC 绑定测试 |

实施顺序：**P0 PoC（纯脚本验证 §4 待实测清单）→ P1 能力类型 + 建号 + 入站 → P2 转发器 + 开关 + 补勾 → P3 打磨（媒体转发、多账号体验）**。

## 11 开放问题

1. **PoC §4 的 5 项协议事实——已执行（2026-11-03，结果回填 §4 清单）**。**主动发送被拒（`ret:-2 prepare failed`）→ D110 降级生效**：转发走「无 context 发送失败 → 最近入站 `context_token` 重试」的保守模式（`im/service.ts#runForwardJob`）。**实机首测又定位一处协议事实：`sendmessage` 每个请求都必须带 `X-WECHAT-UIN`，缺失即 `ret:-2 invalid arguments`（详见 §4 #1 补充）**。context_token 的复用窗口（单次 vs 多次、多久过期）随 #3/#4 实测定案；token 存活期多天观察继续（PoC 日志）。
2. 转发是否需要 per-bot 自定义前缀（如「【{botName}】」）以区分多个 Bot 共用同一微信——待多账号实机体验后定。
3. `wecom-app` transport 的入站形态（企业微信回调需要公网 URL，桌面端不成立；可能走轮询或经 headless 服务端，D102）——独立插件立项时另行设计。
4. 媒体双向转发（Bot 生成图片 → 微信）在 P3 评估，取决于 iLink CDN 上传流程的稳定性。
