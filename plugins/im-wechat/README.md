# im-wechat —— 微信插件（`im` 即时通讯能力首个插件）

> 实现文档 / 交接文档。机制设计（能力类型契约、入站管线、自动转发、同步开关）以 **[docs/design/54-im-channel.md](../../docs/design/54-im-channel.md)** 为唯一事实来源（决策 **D107–D111**）；插件体系背景见 [docs/design/51-plugin-system.md](../../docs/design/51-plugin-system.md) §15（能力类型注册表 / 宿主侧菜谱 / §15.7 路标）。

## 1 定位

把用户的**个人微信**接到 KepCup：

- **入站**：用户在微信上给 Bot 发消息 → Bot 私聊被唤醒处理（用户可以在微信上给 Bot 下指令）。
- **出站**：Bot 的回复由宿主**自动转发**到用户微信，**Bot 无感**——不设任何发消息工具（D110）。
- 绑定即入站；Bot 详情 → 插件 → 账号行的「同步消息到此微信」开关控制出站；开关关闭时收到微信消息会**自动补勾**（D111）。

通道协议：微信 2026 年开放的 **iLink Bot API**（D108）。企业微信不进本插件，未来独立 `im` 插件（transport `wecom-app`）。

## 2 当前状态与包内文件

**宿主 P1 + P2 已实现（2026-11-03，分支 `feat/im-wechat`）**：`validate` 通过（0 错误）；扫码建号 / 入站唤醒 / 自动转发 / 同步开关 / 自动补勾全部可用。

| 文件 | 说明 |
|---|---|
| `plugin.json` | 贡献声明（transport `ilink`、`setup: qrcode`）；宿主已支持 `im` 贡献类型，`node packages/app-validator/dist/cli.js validate plugins/im-wechat` **PASS（0 error）** |
| `icon.svg` | 占位图标（微信绿双气泡）；进市场前按 §8 复核 ≤64 KiB 与观感 |
| `README.md` | 本文档 |

## 3 iLink Bot API 协议卡（已核实，2026-11-03）

参考实现：[Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（协议表面 `docs/protocol.md`）、最小示例 [zhuweiyou/weixinbot](https://github.com/zhuweiyou/weixinbot)。

| 环节 | 要点 |
|---|---|
| API base | `https://ilinkai.weixin.qq.com`，HTTPS + JSON |
| 登录 | `get_bot_qrcode` → 微信扫码确认 → `confirmed` 返回 `bot_token` + `ilink_bot_id` + `baseurl`；token 本地保存（本插件存实例 secrets） |
| 收 | `getUpdates` 长轮询（约 35s 超时），独立端点 |
| 发 | `POST /ilink/bot/sendmessage`，`Authorization: Bearer <bot_token>`；媒体先传 CDN（AES-128-ECB）再引用；媒体与文字分请求 |
| 消息类型 | 文本 / 图片 / 语音 / 文件 / 视频 |
| 异常 | `ret`/`errcode = -14` → 一小时会话暂停；其余退避重试 |
| 发送上下文 | `sendmessage` 可带回复用的 `context_token`；**不带是否被服务器接受未证实**（PoC 第 1 项） |

### P0 PoC（已执行，2026-11-03——结果回填 54 号文档 §4 / §11-1）

照 `zhuweiyou/weixinbot` 写一次性脚本（`/tmp/im-poc/poc.mjs`，不进仓库；观察日志 `poc-observations.log`）验证 5 件事：

1. **主动发送**：**被拒**（无 / 空 `context_token` → `ret:-2 "prepare failed"`）→ **D110 降级生效**：转发走「无 context 失败 → 最近入站 `context_token` 重试」。
2. **token 存活期**：登录 >1h 探活正常；多天观察继续由日志跟踪；重扫流程宿主已实现（账号详情「重新扫码」）。
3. **会话范围**：待实测（第二个微信号对照；宿主已按「仅授权用户」过滤）。
4. 长度 / 频率上限：待实测（随 #3 一批带 context_token 测）；截断暂 2000 字符。
5. **协议稳定性**：错误面一致（-14 认证 / -2 参数 / -3 目标 / 404 端点），心跳 `ret:0`，与协议卡吻合。

## 4 宿主侧改动清单（实现即勾选）

### P1 —— `im` 能力类型 + 建号 + 入站

- [x] shared：`plugin-manifest.ts` — `pluginContributionKindSchema` 加 `'im'`、`PLUGIN_INSTANCE_KINDS` 加 `'im'`、新增 `pluginImContributionSchema`（transport 枚举 / setup / features / apiBase https / instanceFields 查重 / qrcode 禁 sensitive 字段）、manifest 级「im 贡献 ⇔ instances 双向配对、至多一份」、`pluginCapabilitySummary` 两处文案（54 §2）
- [x] shared：`domain/types.ts` `triggerReasonSchema` 加 `'im'`（jobType 加 `im_alert` / `im_forward`）；新 `domain/im.ts`（行 / 作业 / 事件 payload / 限流与去重键）
- [x] core 四个手工点：`plugins/kinds.ts` adapter + `imInstanceFields()` + `mergeConsentItems`、`plugins/instances.ts` `countsOf`、`ConsentItem` / `ProjectedKind` / `emptyOwned()` 扩展（54 §2.2）
- [x] core：`projectors/im.ts`（记账 + 同意视图）、`materializers/im.ts`（扫码两步 RPC → `im.accounts.create` 走 `plugins.instances.create`，pending 表消费 token → `im_accounts` 行 + token 入 secrets → 启动会话；`remove` 幂等级联；`reconcileImInstanceRows` 启动对账）、`start.ts` 装配（54 §2.3）。扫码 token 只存在于 core 内存 pending 表（10 分钟 TTL），永不出 core / 不进渲染层
- [x] 迁移 **0066**（0059–0065 已被占用）：`plugin_instances.kind` CHECK 加 `'im'`（重建表）+ `im_accounts` + `im_account_bots`（含 `forward_enabled`，54 §3）
- [x] core 通道：新 `packages/core/src/im/` — `ilink.ts`（协议客户端，transport 隔离点）、`session.ts`（每账号一条长轮询，退避重连；-14 一小时暂停自动重试、连续 3 轮失效转 auth_failed——计数在 hub 级跨重启累计）、`store.ts`、`service.ts`（ingest 去重 `im:{accountId}:{msgId}` → 按绑定扇出 → 作业 `im_alert`，dedupeKey 含 botId）
- [x] core：`dispatch/orchestrator.ts` `deliverImAlertToBot`（贴卡 `cardType:'im'` + `taint.mark` + `deliverEventToBot`，reason `im`，quiet hours 停放复用 event 机制）；`downgradeLabel` 加 im 文案；入站内容 `<untrusted>`（54 §5）
- [x] 渲染层：`ExtensionIm.svelte` 插件卡 im 管理视图（账号列表 / 扫码添加卡 / 详情 / 重扫）；`BotImBindings.svelte` Bot 详情账号绑定勾选 + D111 开关；`ImCard.svelte` 入站卡；`cardPreviewText` im 分支
- [x] app-validator：im 贡献校验（`plugin.im-api-base` 公网 https、`plugin.im-transport` 声明面报告、字段 default 复检；实测插件 validate PASS）
- [ ] settings-catalog：**零条目**（入口在插件卡与 Bot 详情，与邮件同理，勿登记）

### P2 —— 转发器 + 同步开关 + 自动补勾

- [x] core：`im/forwarder.ts` — 订阅 EventBus `message.created`（**core 内订阅**，窗口关闭 / headless 也要转发；只取 `role=assistant` 最终回复、私聊、非 internal / 非 delegation）→ 对 `forward_enabled=1` 且属主插件已启用的账号入队 `im_forward`（dedupeKey `im_forward:{messageId}:{accountId}`）→ Markdown 剥格式、截断（暂 2000 字）→ `sendmessage` → D78 外发台账（54 §6）
- [x] 失败退避 3 次放弃 + `app.notice`（连续失败才提示，恢复即清）；auth_failed / -14 暂停停转发并提示；每账号每小时转发上限（60，窗口存 config_json）；D110 降级路径内建（无 context → 最近 context_token 重试）；D78 台账走 `audit.recordSystem('im_forward')`
- [x] 渲染层：Bot 详情 im 绑定行内「同步消息到此微信」开关（`BotImBindings`）；一次性提示文案（54 §7）
- [x] **自动补勾**：ingest 事务内 `forward_enabled=0` → 置 1 + 对话内系统事件 + `app.notice`「检测到你从微信发来消息，已开启同步」；**永不自动取消**

### P3 —— 打磨（另行排期）

媒体转发（图片 / 文件经 iLink CDN 上传）、转发前缀（多 Bot 共用微信时区分）、绑定 0 Bot 账号的引导文案优化。

## 5 验收清单

1. 扫码添加微信账号：二维码 → 确认 → 账号卡出现、状态 `ready`；token 在 secrets（DB 不可见明文）。
2. 微信发「今天天气」→ Bot 私聊出现 `im` 卡并回复；回复（开关已自动补勾）出现在微信上。
3. 关闭开关 → 在应用里让 Bot 回复 → 微信**无**新消息；再从微信发一条 → 开关自动变勾 + 一次性提示。
4. 卸载插件 → 账号 / 绑定 / secrets 级联清除，长轮询停止。
5. Bot 未启用该插件时（`plugin_ids` 移除），绑定不产生唤醒与转发（启用集过滤）。
6. 杀进程重启 → 队列中 `im_alert` / `im_forward` 作业恢复，不丢不重。
7. `pnpm --filter @kepcup/shared build` 后定向测试全绿（manifest 契约 / kinds 覆盖率 / im store / forwarder 单测 / RPC 绑定）。

## 6 测试纪律（AGENTS.md）

迭代中只跑定向：`node scripts/run-tests.mjs run <文件>`；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`。全量 `pnpm test` 仅在阶段收口跑一次。kinds 覆盖率测试由 `CAPABILITY_KINDS` 派生，新 kind 注册后自动纳入——漏掉四个手工点会在这里爆。

## 7 发布

宿主支持后：`node packages/app-validator/dist/cli.js validate plugins/im-wechat` → `pack` → 按 [plugins/README.md](../README.md) 流程签名 + R2 + 索引（tier 建议 `verified`；icon 内联 ≤64 KiB）。`engines.kepcup` 对齐首个内置 `im` kind 的实际构建号（当前 `>=0.5.5`；发布版本若跳号到 0.5.6，上架前再改回并对齐）。

## 8 风险与回退

| 风险 | 处置 |
|---|---|
| iLink「官方」程度与协议演进（Tencent 组织仓库但 README 未明确背书） | 协议客户端隔离在 `im/ilink.ts` 单文件；PoC 第 5 项跟踪；接口变动只改一处 |
| 主动发送不被服务器接受 | D110 降级「入站窗口内转发」（54 §11-1），开关语义不变 |
| token 频繁失效 | `auth_failed` 状态 + 重扫流程（materializer update）；仍不可用则暂缓上架 |
| 微信侧封号 / 风控 | 转发限流 + 会话退避 + 告警上限三道护栏；不做任何高频自动化 |
