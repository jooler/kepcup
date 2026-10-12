# 35 邮件通道（Mail Channel）

Bot 可以接管用户邮箱：宿主用 IMAP 收信、SMTP 发信，新信到达时唤醒绑定的 Bot 私聊处理。这是与 D73「连接应用」并列的本机**通道（Channel）**——协议是 IMAP/SMTP，不是 MCP；入口在扩展中心「邮件」页签。决策：**D84**。

**状态：已定稿，待实施。** 产品拍板（2026-10-12）：扩展中心页签叫「邮件」；同一邮箱可被多个 Bot 接管；新信唤醒进**该 Bot 的私聊（DM）**；P0 必须收发都支持；优先做接近邮件客户端的近实时（IMAP IDLE），否则可配轮询间隔。

相关：D73（连接应用 / 污点 / 外发审批）、D75（对话轮 mailbox）、D79（网页监看：确定性轮询 → 持久作业 → 唤醒）、D37 / D78（审批与副作用）、D65（工具风险档）、[29 §16](29-connected-apps.md#16-扩展中心extension-center2026-10-10)（扩展中心信息架构）。

## 决策

- **D84 邮件通道**：
  1. **平行通道，不是 MCP Connector**。账号、凭据、收信会话、Bot 绑定与 `mail_*` 宿主工具自成模块；不进 `connectors/catalog.json`，不复用 `app_connections` / OAuth vault / MCP 工具锁定。将来 Gmail / Outlook 的官方 MCP（OAuth）仍走 D73「连接」；本通道覆盖 QQ / 163 / 自定义域名等以授权码登录的场景，二者可并存。
  2. **入口**：扩展中心新增第 4 页签 **「邮件」**（`ExtensionCenterTab = 'skills' | 'connections' | 'mcp' | 'mail'`）。设置里不单开「邮件」分区；需要时可在设置「应用」旁放一条指针跳转扩展中心（与现 Apps → 扩展中心指针同模式）。
  3. **收信优先 IDLE，轮询兜底**。登录后 `CAPABILITY` 含 `IDLE` → 对 INBOX 做 IDLE（近实时）；不含 → 按账号配置的间隔轮询。用户可强制「仅轮询」并改间隔。厂商预设给出默认间隔与是否尝试 IDLE（见 §4）。
  4. **多 Bot 可绑同一邮箱**。绑定存 `mail_account_bots`（或等价）；每个绑定的 Bot 在**自己的私聊**被唤醒（同一封信可唤醒多个 Bot；幂等按「账号 + UID + botId」去重）。
  5. **P0 = IMAP 收 + SMTP 发**。不做 POP3。读工具进对话轮（只读）；发信与改旗标等写操作只在任务里，走审批卡（完整收件人与正文）。
  6. **邮件正文不可信**：唤醒摘要与 `mail_read` 结果一律 `<untrusted>`；读过邮件的（Bot, 对话）进入与 D73 同类的污点，外发通道降级。

## 1 目标与非目标

**目标**

- 用户添加一个或多个邮箱账号（预设或手动 IMAP/SMTP），把账号交给一个或多个 Bot。
- 新信在秒级～分钟级内到达 Bot 私聊（IDLE 时接近客户端；纯轮询时取决于间隔）。
- Bot 能列信、读信、搜索、发信（回信 / 新写），发信可审批。
- 凭据只存本机 secrets；支持常见国内免费邮（QQ、163/126）与 Gmail / Outlook 的授权码或日后 OAuth 路径说明。

**非目标（本期不做）**

- POP3；完整邮件客户端 UI（文件夹树、本地全文镜像、会话线程 UI）。
- 把 IMAP 伪装成 MCP server 塞进「连接」。
- 企业 Exchange ActiveSync / Graph 专用协议（Outlook 个人邮 P0 可用 IMAP+OAuth 路径另排，见 §4.4）。
- 邮件市场 / 第三方插件；跨设备同步账号配置到云。
- 用 Bot 的 `schedule` 工具代替宿主收信（禁止引导；宿主 poller/IDLE 是唯一收信源）。

## 2 产品形态

### 2.1 扩展中心「邮件」

| 区块 | 内容 |
|---|---|
| 账号列表 | 地址、厂商徽标、连接状态（IDLE 中 / 轮询中 / 暂停 / 失败）、最近收信时间、绑定的 Bot 数 |
| 添加账号 | 预设（QQ / 163 / 126 / Gmail / Outlook / 自定义）→ 填地址与**授权码**（禁止引导填登录密码）→ 测连（IMAP LOGIN + 可选 SMTP）→ 保存 |
| 账号详情 | 服务器参数、收信模式（自动 IDLE / 仅轮询）、轮询间隔、绑定 Bot 多选、暂停 / 恢复 / 删除、最近错误 |
| 空态 | 「添加邮箱后，Bot 就能代你收发并处理新邮件」+ 授权码获取指引链接（各厂商帮助页） |

窄屏：扩展中心已是整页（D82）；「邮件」只是多一个 tab，不另做导航。

### 2.2 Bot 侧可见性

- Bot 详情 / 档案表单：可勾选已添加的邮箱（写入绑定表）；与「应用」勾选并列展示，文案区分「连接应用（MCP）」与「邮箱」。
- 对话上下文：绑定了邮箱的 Bot 在私聊上下文有 `<mail_accounts>` 段（账号标签、模式、未读概数——**不含正文**）。
- 新信卡：私聊里 `cardType: 'mail'`，事件 `arrived` / `paused` / `error`；用户可点开看摘要，不自动展开全文。

### 2.3 与「连接」的边界（对用户怎么说）

- 「邮件」= 用邮箱授权码走 IMAP/SMTP，适合 QQ、网易等。
- 「连接」里若将来上架 Gmail / Google Workspace MCP = OAuth 授权，适合已有 Google 账号且愿走官方 MCP 的用户。
- 同一 Gmail 地址**不建议**同时开 IMAP 通道与 MCP 连接（重复下载、配额加倍）；UI 在两边互相提示。

## 3 架构

```
扩展中心「邮件」 / Bot 绑定
        │
        ▼
┌───────────────────┐     secrets: mail:{id}:password
│ mail_accounts     │◄────（授权码 / 应用专用密码）
│ mail_account_bots │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ MailSessionHub    │  每账号至多 1 条 IMAP 长连接
│  · IDLE 循环      │  CAPABILITY → IDLE 或 poll
│  · poll 调度      │  UID 游标、失败退避
└─────────┬─────────┘
          │ 新 UID
          ▼
┌───────────────────┐
│ jobs: mail_alert  │  去重键 mail:{accountId}:{uid}:{botId}
│ → 私聊 mail 卡    │
│ → mailbox 唤醒    │  trigger_reason=mail
└─────────┬─────────┘
          │
          ▼
   该 Bot 的 DM 对话轮 → 可选 start_task → mail_* 工具
```

与 D79 的对应关系：监看是「按间隔取网页 → 边沿触发」；邮件是「IDLE/轮询发现新 UID → 每封（每 Bot）触发」。都是宿主确定性、不花模型；唤醒都进 mailbox。

## 4 厂商与收信策略

### 4.1 调研摘要（实施前仍以 CAPABILITY 实测为准）

| 厂商 | IMAP / SMTP | 凭据 | IDLE | 公开限制与注意 |
|---|---|---|---|---|
| **QQ 邮箱** | `imap.qq.com:993` SSL；`smtp.qq.com:465` SSL（或 `587`） | 网页开启 IMAP/SMTP 后生成 **16 位授权码**；第三方客户端禁止用 QQ 密码（[官方帮助](https://help.mail.qq.com/detail/108/1089/)） | **支持**（`CAPABILITY` 含 `IDLE`，社区与实测一致；官方帮助未单独写 IDLE） | 官方未公布轮询 QPS；IDLE 须按 RFC 2177 在约 29 分钟内结束并重发；连接空闲过久会被断开，客户端应重连。预设：优先 IDLE；若用户改轮询，默认间隔 **5 分钟**，下限 **2 分钟** |
| **163 / 126** | `imap.163.com` / `imap.126.com:993`；SMTP 同域 `:465` | 客户端授权码；**认证后、SELECT 前必须发 IMAP `ID`（RFC 2971）**，否则 `Unsafe Login` | **不支持**（CAPABILITY 无 IDLE） | 免费邮 IMAP 常只能拉近约 30 天邮件（网易侧限制，阿里迁移文档亦记载）；忌频繁新建连接。预设：**仅轮询**，默认 **5 分钟**，下限 **3 分钟**；实现必须发 `ID`（`name=KepCup` 等） |
| **Gmail** | `imap.gmail.com:993`；`smtp.gmail.com:465/587` | 推荐 OAuth2（[官方 IMAP 文档](https://developers.google.com/workspace/gmail/imap/imap-smtp)）；应用专用密码需开启两步验证 | **支持** | IMAP 会话约 24 小时（OAuth 会话约等于 access token 寿命，常 ~1 小时）后须重连；Workspace 有 IMAP 日带宽上限（如下载约 2500 MB/日）。IDLE 宜每 **≤10 分钟** 重发一次（Gmail 空闲超时短于 RFC 上限）。P0 可用应用专用密码；P1 再接 XOAUTH2 |
| **Outlook.com** | `outlook.office365.com:993`；`smtp-mail.outlook.com:587` STARTTLS | **Modern Auth / OAuth2**（[Microsoft 支持](https://support.microsoft.com/office/pop-imap-and-smtp-settings-for-outlook-com-d088b986-291d-42b8-9564-9c414e2aa040)）；须在设置中开启 IMAP | **支持**（CAPABILITY 含 IDLE） | 应用专用密码近年对 IMAP 不可靠的用户报告较多；并发连接有未公开节流（社区称约 15）。P0：**预设显示「需 OAuth，后续版本」或仅高级用户手填**；不把「密码登录」标为可用。P1 做 XOAUTH2 后再标可用 |

### 4.2 运行时策略（实现规则）

1. 连接成功后读 `CAPABILITY`：
   - 有 `IDLE` 且账号模式为 `auto` → IDLE 路径；
   - 否则 → poll 路径。
2. **IDLE**：
   - `SELECT INBOX`（只读会话即可；需要改旗标时另开短连接或升级，见 §6）；
   - 进入 IDLE；收到 `EXISTS` / `RECENT` 等 → `DONE` → UID 增量拉取 → 再 IDLE；
   - 定时（默认 9 分钟，且 ≤25 分钟）主动 `DONE` 并重发 IDLE，避免被服务器踢；
   - 断开 / BYE → 指数退避重连（封顶 15 分钟），成功后从 UID 游标补洞。失败计数在**连接就绪（SELECT 成功）时清零**，连上后才掉线的重试从 1 秒起（就绪不足 30 秒就又掉线算抖动，退避继续放大）；库在空闲时 emit 的连接级 `error` 由适配层接住并打断当前等待，立即走重连，绝不当作未处理异常；
   - **认证失败（服务器对 LOGIN/AUTHENTICATE 回 NO/BAD，且不是「登录太频繁」类限流）→ 停止重试**，账号置 `error` 并贴一张明确的错误卡，等用户在扩展中心更新授权码（`mail.accounts.update`）后自动重启会话；继续重试只会把 163/QQ 试到限流或锁号；
   - **UIDVALIDITY**：账号存 `uid_validity`。每次 SELECT 后与存储值比较，变了（服务器重建邮箱 / 账号改成另一个邮箱）或游标跑到 UIDNEXT 之前，旧游标作废，重新取基线（之前的邮件不当新信提醒）。改 IMAP 主机 / 端口 / 加密 / 登录名同样清空 `last_uid` 与 `uid_validity`；
   - 工具调用（`mail_*`）与收信循环共用一条连接并串行；有调用在排队时主循环不进 IDLE，避免后到的调用被 IDLE 堵到刷新间隔；
   - 停止 / 暂停 / 重启之后迟到的就绪回调与补拉结果一律丢弃，不改状态、不入库、不产生提醒。
3. **Poll**：
   - 按 `poll_interval_sec` 对 INBOX 做 `UID SEARCH` / `UID FETCH` 信封；
   - 复用长连接 + 周期性 `NOOP`，禁止每次新建 TCP（尤其 163）；
   - 间隔范围：全局硬限 **60 秒–6 小时**；厂商预设可提高下限（QQ 120s、163 180s）。
4. **用户可配**：模式 `auto | poll_only`；间隔（仅影响 poll 或 IDLE 失败后的 fallback）。改配置热更新该账号会话。
5. **多 Bot 绑定同一账号**：仍只保持 **一条** IMAP 连接；告警扇出到各 Bot，避免连接数打满（Outlook / Gmail 对多客户端敏感）。

### 4.3 诚实预期（写进 UI 说明）

- QQ / Gmail（IDLE）：通常数秒级感知新信，接近常见桌面客户端。
- 163 / 126：无推送，默认约 5 分钟一轮；把间隔拧到下限会增加封禁与「不安全登录」风险，UI 给出警告。
- 电脑休眠 / 关机：与定时任务、监看相同——唤醒后重连并补拉 UID 空洞；迟到信息写入唤醒载荷，由 Bot 决定是否仍处理。

## 5 数据模型（草案）

`main.db` 新表（迁移号实施时分配）：

```sql
CREATE TABLE mail_accounts (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL,           -- 登录用完整地址
  label           TEXT NOT NULL,           -- 用户可见名，默认=address
  provider        TEXT NOT NULL,           -- 'qq'|'netease_163'|'netease_126'|'gmail'|'outlook'|'custom'
  imap_host       TEXT NOT NULL,
  imap_port       INTEGER NOT NULL,
  imap_secure     TEXT NOT NULL,           -- 'ssl'|'starttls'
  smtp_host       TEXT NOT NULL,
  smtp_port       INTEGER NOT NULL,
  smtp_secure     TEXT NOT NULL,
  username        TEXT NOT NULL,           -- 通常=address
  mode            TEXT NOT NULL DEFAULT 'auto'
                  CHECK (mode IN ('auto','poll_only')),
  poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  status          TEXT NOT NULL DEFAULT 'idle'
                  CHECK (status IN ('idle','running','paused','error')),
  last_uid        INTEGER,                 -- INBOX 已处理最大 UID（按账号）
  uid_validity    INTEGER,                 -- 取 last_uid 时 INBOX 的 UIDVALIDITY（0034）；变了就重取基线
  last_error      TEXT,
  last_ok_at      INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE mail_account_bots (
  account_id      TEXT NOT NULL REFERENCES mail_accounts(id),
  bot_id          TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (account_id, bot_id)
);

-- 可选：每 Bot 已唤醒过的 UID，防重复（也可用 jobs 去重键单独保证）
CREATE TABLE mail_bot_cursors (
  account_id      TEXT NOT NULL,
  bot_id          TEXT NOT NULL,
  last_uid        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, bot_id)
);
```

- 密钥：`secrets` 名 `mail:{accountId}:password`（授权码）。删除账号时清除。
- Bot 删除：去掉 `mail_account_bots` 行；账号保留。
- 账号删除：停会话、取消未完成 `mail_alert`、清密钥与绑定。

不把整封邮件默认落库。唤醒载荷只带信封字段 + 短摘要；全文按需 `mail_read` 临时取，或 P1 再加可选「缓存 N 天加密正文」——P0 不做全文镜像。

## 6 工具面（`HOST_CAPABILITIES.mail`）

| 工具 | 对话轮 | 任务 | 说明 |
|---|---|---|---|
| `mail_list` | ✓ | ✓ | 列信封（账号、文件夹默认 INBOX、limit、未读过滤）；输出 `<untrusted>` |
| `mail_read` | ✓ | ✓ | 按 UID 读正文（纯文本优先，HTML 转可读文本）；附件只列元数据，P0 不自动下载到 workspace |
| `mail_search` | ✓ | ✓ | IMAP SEARCH 条件子集（from/to/subject/since/unseen） |
| `mail_send` | ✗ | ✓ | SMTP 发送；**写 / 外发**；审批卡展示完整 to/cc/bcc 与正文（复用 recipients 逻辑） |
| `mail_accounts` | ✓ | ✓ | 列出本 Bot 已绑定账号与状态（无密钥） |

- 风险：`mail_list` / `mail_read` / `mail_search` / `mail_accounts` = read；`mail_send` = write（外发）。P1 若加 `mail_set_flag` / `mail_move` 按写处理。
- 账号范围：工具参数 `account_id` 必须属于当前 Bot 绑定，否则 `MAIL_NOT_BOUND`。
- 对话轮只读：`mail_send` 在对话轮执行期 `RUN_READ_ONLY`。
- 污点：任一返回邮件内容的工具（`mail_read`，以及返回发件人 / 主题的 `mail_list` / `mail_search`，空结果除外）或新信唤醒进入对话后，该（Bot, 对话）打污点（与 D73 应用读同类），持续 24 小时；期间 `mail_send`、`web_fetch`、写 MCP 等外发即使「总是允许」也每次确认。

## 7 新信唤醒

1. SessionHub 发现 INBOX 新 UID（IDLE 或 poll）。
2. 拉取信封 + 摘要（subject / from / date / 纯文本前 N 字，上限例如 500 字）。
3. 对每个绑定 Bot：
   - 解析该 Bot 的私聊 `conversation_id`（不存在则创建，同现有 ensure-DM 路径）；
   - 入队 `mail_alert`，去重键 `mail:{accountId}:{uid}:{botId}`；
   - 作业：贴 `mail` 卡（`arrived`）→ 内部事件唤醒对话轮（`trigger_reason=mail`），消息含账号标签、UID，**发件人 / 主题 / 时间 / 摘要整块包在 `<untrusted>` 里**（入库与渲染前去换行、限长：发件人 200、主题 300 字符）；历史里的 `[系统]` 卡片行只陈述事实，不内嵌邮件字段。
4. 免打扰：与事件 / 监看相同——停放到时段结束；**不计入**每日主动消息上限（与 D79 一致）。
5. 提醒风暴：同一（account, bot）滚动 1 小时内超过 `MAIL_MAX_ALERTS_PER_HOUR`（建议 30）→ 暂停该绑定的唤醒并贴卡，用户确认后恢复；UID 游标仍前进，避免恢复后洪峰重放。

## 8 安全与隐私

1. UI / 文案只提「授权码 / 应用专用密码」，测连失败时若疑似登录密码，提示去网页开启 IMAP 并生成授权码。
2. 密钥不出本机；不进模型上下文、日志、卡片、外部智能体。
3. 唤醒与读信内容 `<untrusted>` + 密钥脱敏。
4. `mail_send` 审批：完整收件人与正文；台账按 D78 `external`。
5. SSRF：SMTP/IMAP 主机允许用户填自定义，但禁止连字面量本机环回与链路本地以外的「应用内部」地址无额外必要——自定义主机按用户意图连接公网邮件服务器；实现时复用现有出口策略能复用的部分，并在自定义预设旁警告。
6. 附件：P0 不自动落地；P1 下载到 Bot workspace 须用户或审批策略允许。

## 9 分期

| 阶段 | 范围 | 门禁 |
|---|---|---|
| **P0** | 扩展中心「邮件」页签；账号 CRUD + 测连；secrets；QQ / 163 / 126 / Gmail（应用专用密码）预设 + 自定义；SessionHub（IDLE + poll）；多 Bot 绑定；新信 → 各 Bot DM；`mail_list` / `mail_read` / `mail_search` / `mail_send` / `mail_accounts`；审批与污点；失败退避与暂停卡；定向单测 + 至少一条假 IMAP 服务器 e2e | QQ 实测 IDLE 收信；163 实测 ID + 轮询收信；SMTP 发信审批卡字段完整 |
| **P1** | Gmail / Outlook XOAUTH2（可复用系统浏览器 + loopback 经验，令牌仍本机）；附件下载到 workspace；已读旗标；文件夹切换（发件箱只读浏览）；右栏「邮箱」状态条 | OAuth 测连通过 |
| **P2** | 与 D73 Gmail MCP 的互斥提示；可选短周期正文缓存；邮件过滤规则（寄件人 / 标题 → 只唤醒某 Bot）；IDLE 指标进诊断 | — |

Outlook 个人邮：P0 预设可展示但标记「需要 OAuth，请等后续」或仅自定义高级；避免宣称密码可用。

## 10 RPC / 事件（草案）

- `mail.accounts.list` / `get` / `create` / `update` / `delete` / `test`
- `mail.accounts.setBots`（全量替换某账号的 Bot 列表）
- `mail.accounts.pause` / `resume`
- 事件：`mail.account_updated`、`mail.message_arrived`（可选，卡已够用时可只靠对话事件）

渲染：`features/extension-center/ExtensionMail.svelte` + `features/mail/`；`tabs.ts` 扩展第 4 项。

## 11 实现锚点（开工时读）

| 部分 | 位置 |
|---|---|
| 监看唤醒范式 | `packages/core/src/watch/service.ts`、`docs/design/02-execution.md` §网页监看 |
| mailbox / trigger_reason | `packages/core/src/scheduler/mailbox.ts`、D75 |
| secrets | `packages/core/src/infra/keystore.ts` 及现有 `provider:*` / `conn:*` 命名 |
| 扩展中心 tabs | `apps/desktop/.../extension-center/tabs.ts`（现三页签） |
| 外发审批 / recipients | `packages/core/src/mcp/recipients.ts`、gateway `mcpToolCall` |
| 污点 | `packages/core/src/apps/taint.ts`（邮件读应登记污点源，或平行 `mail` 源） |
| Bot 私聊 ensure | 现有 contacts / conversations 开 DM 路径（委派、管家建联同模式） |

IMAP/SMTP 客户端库选型实施期定：优先维护活跃、支持 IDLE 与自定义 `ID` 命令的 Node 库；不在渲染进程建连，只在 core（utilityProcess）。

## 12 验收要点

1. 扩展中心可见「邮件」；添加 QQ 授权码账号 → 状态「IDLE 中」→ 网页往该邮箱发一封 → 绑定 Bot 的私聊出现新信卡并开始对话轮。
2. 同一邮箱绑两个 Bot → 两个私聊都收到卡；去重键保证刷新不双开。
3. 163 账号不发 `ID` 的实现在测试中必须失败；发 `ID` 后轮询可列出新信。`ID` 只对网易系主机（163 / 126 / yeah.net / 188）强发并吞掉 BAD/NO；其余服务器仅在 CAPABILITY 广告了 `ID` 时由库自己发，不额外强发（Courier、hMailServer 等回 BAD）。
4. Bot 在任务里 `mail_send` → 审批卡含完整收件人与正文 → 同意后对方收到。
5. 撤销某 Bot 绑定后，新信不再唤醒该 Bot；其他绑定仍唤醒。
6. 休眠唤醒后 IDLE/轮询恢复，UID 空洞补拉不丢、不洪泛重放。

## 13 残留问题（不影响开工）

1. P0 是否在设置里放「邮件」指针条目（推荐做，成本低）。
2. 过滤规则（只把某寄件人交给某 Bot）是否升到 P1，还是 P0 就做简单 from 后缀过滤——**默认 P2**，P0 全量唤醒所有绑定 Bot。
3. Gmail XOAUTH2 与 D73 Google Workspace MCP 的令牌是否共用保险库命名空间——**建议分开**（`mail:` vs `conn:`），避免生命周期耦合。
