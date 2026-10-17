# WP8 · 文案收尾、协作暂停卡、审批卡与 e2e（T1a 收口）

> 依赖：WP3（`project.turn`、触发原因）、WP4（管家 / 设置目录 / `episode` 契约）、WP5–WP7（界面）全部已合入。分支：`feat/project/wp8-copy-e2e`。
> **本 WP 结束即 T1a 收口**：跑一次全量单测 + 全部相关 e2e。先读 [README.md](README.md) §1、§4.9、§4.12；设计依据 [41 §7.3、§9、§11](../../docs/design/41-project-team.md)。

## 1. 范围

1. **渲染层改名与文案收尾**：`GroupTurnStatusLine` → `ProjectTurnStatusLine`、剩余 `group` 命名的 i18n key / `data-testid` / 文案；「群聊」措辞统一为「项目组」。
2. **协作暂停卡**（熔断的界面，后端在 WP2）：`episode_paused` 系统消息渲染成带「继续 / 停止」的卡。
3. **管家审批卡**：`propose_project` 的卡显示负责人，用户可改；`suggest_route` 的路由卡改名。
4. **测试缝**：`start.ts` 增 e2e 用的熔断阈值覆盖（仅 test hooks 构建）。
5. **e2e**：helper、重写 / 改名旧 spec、新增 spec、修依赖旧 testid 的其它 spec。
6. T1a 收口验证。

## 2. 固定契约

- testid：README §4.12（含 `project-turn-*`、`episode-paused-card` / `episode-resume` / `episode-stop`）。
- 组件：`features/chats/ProjectTurnStatusLine.svelte`（`git mv` 自 `GroupTurnStatusLine.svelte`）、`features/chats/EpisodePausedCard.svelte`、`stores/episodes.svelte.ts`。
- `stores/episodes.svelte.ts`：`byId = $state<Record<string, Episode>>({})`；`load(id)`（调 `episodes.get`，找不到忽略）；`resume(id)` / `stop(id)`（调 `episodes.resume` / `episodes.stop`，成功后写入 `byId`，失败 toast）；订阅 `episode.updated` 事件写入 `byId`；`pausedCount(conversationId)`（`byId` 里该会话 `status==='paused'` 的个数）。
- i18n（原样使用）：

| key | 文案 |
|---|---|
| `episode.resume` | 继续 |
| `episode.stop` | 停止 |
| `episode.resumed` | 已继续协作 |
| `episode.stopped` | 已停止协作 |
| `episode.pendingHint` | 有 {count} 条待投递 |
| `approvals.butlerProjectTitle` | 管家提议：建项目组 |
| `approvals.butlerProjectName` | 项目组名称 |
| `approvals.butlerProjectGoal` | 项目目标 |
| `approvals.butlerProjectLead` | 项目负责人 |
| `approvals.butlerProjectMembers` | 成员 |
| `route.openProject` | 打开项目组「{name}」 |
| `schedules.workbenchProject` | {name}（项目组） |
| `usage.loop.triage` | 路由判断（值改写，key 不变） |
| `composer.mentionProject` | 项目组 |
| `agents.background.projectMentionOnly` | 项目组里只在被 @ 或回复时响应 |

## 3. 开工前核对

```bash
rg -n "GroupTurnStatusLine|group-turn-|groupTurn" apps/desktop -g '!node_modules' -g '!**/dist/**'
rg -n "approvals\.butlerGroup|route\.openGroup|route-open-group|approval-butler-group|groupMentionOnly|background-tasks-group-mention-only|schedule-receipt-group|self-schedule-group|schedules\.workbenchGroup|composer\.mentionGroup|workbench.*[Gg]roup" apps/desktop/src -g '!**/dist/**'
rg -n "群聊|群成员|群里|本群|群内|建群|解散群|新建群" apps/desktop/src -g '!**/dist/**'
ls apps/desktop/test/e2e apps/desktop/test/e2e/helpers
```

必读：`features/chats/MessageBubble.svelte`（系统事件渲染分支）、`features/chats/GroupTurnStatusLine.svelte`（37 行）、`features/approvals/ApprovalCard.svelte`（`butler_proposal` 的分支，WP4 已做编译修复）、`stores/permissions.svelte.ts`（`decide` 入参）、`features/chats/RouteCard`（`rg -n "route.openGroup" apps/desktop/src` 定位）、`start.ts` 里 `__KEPCUP_TEST_HOOKS__` 的使用模式、`apps/desktop/test/e2e/{group-chat,group-compose}.spec.ts`（全文）、`helpers/create-group.ts`、`packages/testkit/src/mock-llm.ts` 与 `index.ts`（`startMockLlm`、`step`）。

## 4. 步骤

### 步骤 1：改名与文案收尾

1. `git mv features/chats/GroupTurnStatusLine.svelte features/chats/ProjectTurnStatusLine.svelte`；testid `group-turn-status` / `group-turn-queue` / `group-turn-single` → `project-turn-status` / `project-turn-queue` / `project-turn-single`；`MessageList.svelte` 里的引用同步。
2. **判断规则**：下面这些是「聊天群」含义，改；其余含 `group` 的**不是**，不要动：

   | 改 | 不改（别的含义） |
   |---|---|
   | `approvals.butlerGroup*`、`approval-butler-group*`、`route.openGroup`、`route-open-group`、`agents.background.groupMentionOnly*`、`background-tasks-group-mention-only`、`schedules.workbenchGroup`、`schedule-receipt-group`、`self-schedule-group`、`composer.mentionGroup`（Composer 里 `buildMentionTargets` 的 `kind: 'group'` 已在 WP4 改 `'project'`，对应徽标文案 key 本 WP 改） | `handover.group.*` 与 `handover-group-*`（交接卡里的「资产分组」）、`profile-groups`、`apps-connected-group-*`、`apps.tier.communityGroup`、`contacts.engineGroup*`、`section-header-*` / `section-count-*`（侧栏「对话分组」）、`bot-apps-${group.connectorId}*` |

   key 与 testid 的新名：`approvals.butlerProject*`（见 §2 表）、`approval-butler-project*`、`route.openProject`、`route-open-project`、`agents.background.projectMentionOnly*`、`background-tasks-project-mention-only`、`schedules.workbenchProject`、`schedule-receipt-project`、`self-schedule-project`、`composer.mentionProject`。
3. `usage.loop.triage` 的**值**改为「路由判断」。
4. 中文措辞扫描：`rg -n "群聊|群成员|群里|本群|群内|建群|解散群|新建群" apps/desktop/src`——凡指「聊天群」的改「项目组」（`contacts.bioPlaceholder`「一句话介绍（用于群聊名片）」→「一句话介绍（用于项目组成员名片）」等）；侧栏「对话分组」相关的「分组」不改。
5. `MessageKey` 是类型检查的：删 / 改 key 后 `pnpm --filter @kepcup/desktop typecheck` 会指出所有遗漏。

### 步骤 2：协作暂停卡

1. `stores/episodes.svelte.ts`（§2）。在应用启动订阅事件的位置（参照 `stores/` 下其它 store 的 `core.onEvent` 订阅方式）注册 `episode.updated`。
2. `features/chats/EpisodePausedCard.svelte`：props `{ message: Message }`（取 `content.episodeId`、`content.text`）；挂载时 `episodes.load(episodeId)`；根节点 `data-testid="episode-paused-card"`，`data-status={episode?.status ?? 'unknown'}`：
   - `paused`：文案（`content.text`）+ `pendingCount > 0` 时显示 `episode.pendingHint` + 两个按钮「继续」`episode-resume`、「停止」`episode-stop`（点击 → `episodes.resume` / `episodes.stop`，请求中禁用）；
   - `active`（已继续）：显示 `episode.resumed`，无按钮；`stopped`：显示 `episode.stopped`；`unknown`（尚未加载或该回合已不存在）：只显示文案、无按钮。
3. `MessageBubble.svelte`：`system_event` 且 `event === 'episode_paused'` → 渲染 `EpisodePausedCard`（放在系统消息分支里，样式与其它居中系统卡一致）。
4. **沟通 tab 徽标计入暂停**：WP6 的 `ProjectHeader` 里 `chatTabBadge` 的 `pendingApprovals` 入参改为 `permissions.pendingOf(id).length + episodes.pausedCount(id)`（暂停的协作也需要用户处理）。
5. 单测：`episodes.svelte.test.ts`（`desktop-svelte` 项目，参照 `stores/app-detail.svelte.test.ts`）——事件写入、`pausedCount`、`resume` / `stop` 成功后状态更新、失败不改状态。

### 步骤 3：管家审批卡与路由卡

1. `ApprovalCard.svelte` 的 `butler_proposal` + `proposalType === 'project'`：显示项目组名称、项目目标、**项目负责人**（一个下拉：选项 = `payload.memberBotIds` 对应的 Bot，默认 `payload.leadBotId`，`data-testid="approval-butler-project-lead"`）、成员列表（只读，负责人带标记）。「批准」时若用户改了负责人，`permissions.decide` 带 `leadBotId`（WP4 已加该入参；类型在 `stores/permissions.svelte.ts`）；没改则不带。文案用 §2 的 `approvals.butlerProject*`。**`proposalType === 'bots'`**（原 team）的分支文案若仍写「建群 / 团队」，按「批量创建 Bot」措辞核对。
2. 路由卡（`route.openProject`）：`route.openGroup` 改名，文案「打开项目组「{name}」」，testid `route-open-project`。

### 步骤 4：e2e 测试缝（core）

`packages/core/src/start.ts`：仿照现有 `__KEPCUP_TEST_HOOKS__` 的写法，新增

```ts
const episodeLimits = __KEPCUP_TEST_HOOKS__ === true ? episodeLimitsFromEnv(env) : undefined;
// KEPCUP_TEST_EPISODE_LIMITS="hops,pair"（例如 "2,2"）；非法值忽略；打包产物里整段被折叠掉
```

并传给 `EpisodesService` 的 `limits`（WP2 已留好该依赖）。`episodeLimitsFromEnv` 放在 `dispatch/episodes.ts` 旁并单测（合法 / 缺省 / 非法 / 非正数）。**只在 `__KEPCUP_TEST_HOOKS__` 为真时生效**，不要写成任何用户可见配置。

### 步骤 5：e2e

**helper**：`git mv apps/desktop/test/e2e/helpers/create-group.ts helpers/create-project.ts`，导出 `createProjectViaUi(page, title, memberNames, leadName = memberNames[0])`：
1. 点 `new-chat-button` → `start-chat-create-project` → 等 `project-compose-menu` 可见；
2. **第一轮**：在菜单里点 `leadName`（`menu.locator('button', { hasText: leadName })`），等 `project-compose-phase` 的 `data-phase` 变 `members`；
3. **第二轮**：对 `memberNames` 里除 `leadName` 外的每个名字点选；`project-compose-input` 按 Enter；
4. 等顶栏 `project-title` 含默认标题（`projectTitleFromMemberNames([leadName, …其余成员])`，从 `@kepcup/shared` 导入）；
5. 若 `title` 不等于默认标题：点 `project-settings-button` → `project-title-input` 填 `title` 回车 → 等 `project-title` 含 `title` → 点 `project-tab-chat` 回到沟通。

**重写 / 改名 / 新增**（用例标题与要点；断言用 `data-testid`，等待用 `expect(...).toBeVisible({ timeout })`，沿用现有 spec 的启动 / 关闭 / `waitReady` 模板与 `startMockLlm` 写法）：

| 文件 | 用例 |
|---|---|
| `project-chat.spec.ts`（由 `group-chat.spec.ts` 改名） | ① `project chat: create, @ mention, reply-quote, turn status`（去掉 no-claim 点选；`@` 与回复引用保留；状态行断言 `project-turn-status`，阶段文案「正在确认由谁回复」对应路由阶段）；② `project settings: rename, goal, members, set lead, delete`（经 ⚙ 打开详情页：改名；写项目目标并保存；添加 / 移出成员；「设为负责人」；移出负责人被置灰；删除项目组两步确认回到空态 `chat-empty`） |
| `project-compose.spec.ts`（由 `group-compose.spec.ts` 改名） | `project compose: Esc cancels; lead phase needs a lead; pick lead enters members phase; Backspace returns to lead phase; needs 1 member; Enter creates a Bot as lead; empty Enter creates the project`；并断言**候选里没有管家**（通讯录里有管家时 `project-compose-menu` 不含它）、第二轮的候选不含负责人 |
| `project-shell.spec.ts`（新） | ① 项目组顶栏两行：`project-title` 与 `project-tabs`；`project-tab-chat` 激活、`project-tab-wiki` 可点（本 WP 时点开是占位）、`project-tab-board` / `okr` / `calendar` 为 `data-disabled="true"` 且点击无效；② **不渲染右栏**：`right-panel` 与 `right-panel-toggle` 均为 0；③ ⚙ 打开 `project-settings-page`（`project-view` 的 `data-view="settings"`、所有 tab 无激活态），再点 tab 返回；④ **草稿保留**：在 `composer-input` 输入未发送文字 → 切到 Wiki tab → 切回沟通，文字还在；⑤ 头像堆叠：`project-members-trigger` 点开 `project-members-menu`，成员行含「负责人」标记，搜索并添加成员，点外部关闭、Esc 关闭；⑥ 授权撤销一步可达：⚙ → `project-settings-nav-grants` → 有授权时 `project-grant-revoke-*` 可点（构造授权的方式参照 `browser.spec.ts` / `sandbox.spec.ts` 里已有的授权夹具；没有现成夹具就只断言空态 `project-grants-empty` 并在实施记录说明）；⑦ **窄屏**（`page.setViewportSize({ width: 600, height: 800 })`）：`narrow-back-button`、tab 行可横向滚动、`project-settings-button` 可用；⑧ 单聊不受影响：`right-panel-toggle` 仍在、右栏照旧 |
| `project-routing.spec.ts`（新） | 项目组：负责人 L，成员 M、N；mock LLM 脚本（参照 `group-chat.spec` 里原 triage 脚本化的做法，改为**网关**的结构化输出）：① 没有 `@`、无上一位回话者：网关 `route [M]` → M 回复；断言消息列表里**只有用户消息与 M 的回复**（没有 L 的任何消息、没有系统消息 / 卡片）；② 续接：M 先回复一次，再发无 `@` 消息，续接判断 `respond` → M 回复，网关未被调用（mock 请求计数）；③ 网关 `self` → L 回复；④ 网关 `none`（「谢谢」）→ 无回复、输入框可继续发送；⑤ 显式 `@N` → 只有 N 回复，没有路由 / 续接调用 |
| `episode-breaker.spec.ts`（新） | 启动时带 `KEPCUP_TEST_EPISODE_LIMITS=2,2`：L 与 M 脚本化互相 `@` 超过阈值 → 沟通里出现 `episode-paused-card`（`data-status="paused"`，沟通 tab 在别的 tab 时出现徽标）；点「继续」→ 卡变 `active`、被暂停的触发被投递；再触发熔断后点「停止」→ `data-status="stopped"`、不再有新的往返 |
| 既有 spec 修改 | `setting-card.spec.ts`（群成员 / 群名卡 → `project-card-*`；约 l.174 的 `createGroupViaUi` → `createProjectViaUi`）、`memory.spec.ts`（约 l.237 建群 → `createProjectViaUi`；约 l.268 `context-group-settings` → `context-project-settings`，删除走详情页 `project-delete-begin` / `project-delete-confirm`）、`browser.spec.ts`（约 l.129 `group-info` → ⚙ 详情页成员分区里的成员行与「显示」按钮；约 l.586 建群）、`workbench.spec.ts`（约 l.447 建群；约 l.487 的 `no-claim-bots` 断言：派给项目组的事项现在**总是带对负责人的 `@`**，不再有「无人认领」点选——改成断言事项卡 / 派发卡落到负责人、或负责人回复为空时事项退回草案且 `blocked_reason` 为「项目里无人回应」）、`butler-proposal.spec.ts`（`propose_team` / `propose_group` → `propose_bots` / `propose_project`；新增：批准前把负责人改成另一个成员，建出的项目组负责人是改后的）、`narrow-layout.spec.ts`（涉及群聊详情的部分改走 ⚙；单聊部分不变）。`avatar.spec.ts`、`direct-chat.spec.ts`、`bot-setup.spec.ts` 里的 `right-panel-toggle` 是**单聊**，不用改。 |

## 5. 验证（T1a 收口）

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/core run build
pnpm typecheck && pnpm lint
node scripts/run-tests.mjs run --project desktop
pnpm build
pnpm --filter @kepcup/desktop test:e2e test/e2e/project-compose.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/project-chat.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/project-shell.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/project-routing.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/episode-breaker.spec.ts
pnpm --filter @kepcup/desktop test:e2e test/e2e/butler-proposal.spec.ts test/e2e/setting-card.spec.ts test/e2e/memory.spec.ts test/e2e/workbench.spec.ts test/e2e/browser.spec.ts test/e2e/narrow-layout.spec.ts
pnpm test                       # T1a 收口：全量跑一次，失败集合不得超出基线
```

e2e 在本机若因沙箱 / 浏览器环境（`browser.spec.ts` 等）有既有的环境性失败，对照基线判断；**新增与改名的 spec 必须全绿**。

## 6. 验收清单

- [ ] 渲染层不再有聊天群含义的 `group` 命名：

```bash
rg -n "GroupTurnStatusLine|group-turn-|group-compose|group-info|group-settings|group-setup|group-member|context-group-settings|createGroupViaUi|create-group|groupCompose|groupSetup|route-open-group|approval-butler-group|butlerGroup|route\.openGroup|mentionGroup|groupMentionOnly" apps packages -g '!node_modules' -g '!**/dist/**'
rg -n "群聊|群成员|群里|本群|群内|建群|解散群|新建群" apps/desktop/src -g '!**/dist/**'
```

  两条均应为空（第二条里指「对话分组」等非聊天群含义的除外，需在实施记录逐条说明）。
- [ ] 协作暂停卡：暂停 / 继续 / 停止三态、沟通 tab 徽标计入暂停；`episodes` store 单测通过。
- [ ] 管家 `propose_project` 卡显示并可改负责人；`proposalType==='bots'` 文案核对。
- [ ] 测试缝 `KEPCUP_TEST_EPISODE_LIMITS` 仅在 test hooks 构建生效，有单测。
- [ ] e2e：§4 步骤 5 表里的新增 / 改名 / 修改 spec 全部通过；`group-*` 旧 spec 与旧 helper 已不存在。
- [ ] `pnpm typecheck`、`pnpm lint`、全量 `pnpm test` 通过（失败集合不超出基线）。
- [ ] 实施记录已填。

## 7. 陷阱

- **不要把 `handover.group.*`、`profile-groups`、`apps-connected-group-*`、侧栏「对话分组」当成聊天群去改。**
- e2e 里的等待要给足 `timeout`（沿用现有 spec 的 15–60 秒惯例），不要用固定 sleep。
- `episode-breaker.spec.ts` 依赖测试缝；没有设 `KEPCUP_TEST_EPISODE_LIMITS` 时阈值是 12 / 8，e2e 跑不到。
- 改完 `create-project.ts` 后，所有调用点的签名保持 `(page, title, memberNames, leadName?)`——`memberNames` 里的**第一个**默认是负责人，调用方通常不用改。
- 路由 e2e 的 mock 脚本里，**网关**与**续接判断**都是 `loop_type='triage'` 的结构化调用：用请求体里的系统提示词关键字区分（续接是「last member who spoke」，网关是「project lead」），不要按调用顺序假设。
- 不要为了让 e2e 过而删除断言；`workbench.spec.ts` 里 `no-claim-bots` 那条是**语义变了**（不再存在），要换成新语义的断言，不是删掉。

## 8. 实施记录

**2026-10-18 · 直接在集成分支 `feat/project/migration` 上开发（调度方指定，T1a 收口 WP）。**

### 提交列表（自 `9449dba` 起）

| 提交 | 内容 |
|---|---|
| `ffea525` | refactor(desktop)!: `git mv GroupTurnStatusLine.svelte → ProjectTurnStatusLine.svelte` + testid `group-turn-status/queue/single → project-turn-*` + MessageList 引用同步（纯改名独立提交，步骤 1.1） |
| `adb1941` | refactor(desktop,shared,core)!: 文案收尾（步骤 1.2–1.5）——i18n `approvals.butlerGroup* → butlerProject*`（§2 表逐字）、`route.openGroup → openProject`、`composer.mentionGroup → mentionProject`、`agents.background.groupMentionOnly* → projectMentionOnly*`、`usage.loop.triage` 值 →「路由判断」、`butlerTeamTitle` →「管家提议：批量创建 Bot」；testid `background-tasks-group-mention-only → background-tasks-project-mention-only`、`route-open-group → route-open-project`；设置字段 `backgroundTasks.groupMentionOnly → projectMentionOnly`（shared schema + settings.update 入参 + core llm-router + 两处 core 测试 + 渲染端，语义不变）；中文措辞清扫（含注释：群聊/群成员/建群等 → 项目组措辞，逐文件人工核对非聊天群含义未动） |
| `8916aa4` | feat(desktop): 协作暂停卡（步骤 2）——`stores/episodes.svelte.ts`（byId/load/resume/stop/pausedCount + `episode.updated` 订阅，App.svelte start）、`EpisodePausedCard.svelte`（paused/active/stopped/unknown 四态、pendingHint、请求中禁用）、MessageBubble `episode_paused` 分支、ProjectHeader 徽标 `pendingOf + pausedCount`、i18n `episode.*` 5 键、单测 `episodes.svelte.test.ts` 6 例 |
| `dc96550` | feat(desktop): 审批卡负责人下拉（步骤 3）——`proposalType==='project'` 待决卡渲染 `select`（选项 = memberBotIds，默认 payload.leadBotId，testid `approval-butler-project-lead`）、成员列表只读带负责人标记、批准时改过才带 `leadBotId`（decide 第 8 参）、已决卡显示 decision.leadBotId ?? payload.leadBotId；路由卡改名已随 `adb1941` 完成 |
| `6ddbf86` | feat(core): 测试缝（步骤 4）——`episodeLimitsFromEnv`（`dispatch/episodes.ts` 旁，`KEPCUP_TEST_EPISODE_LIMITS="hops,pair"`，逐段忽略非法/非正数）+ start.ts 仅 `__KEPCUP_TEST_HOOKS__` 为真时读取、优先于 WP2 的 `KEPCUP_EPISODE_HOP_BREAKER/PAIR` 单项缝（integration 测试继续用后者）；单测 4 例 |
| `7f84790` | refactor(desktop)!: `git mv helpers/create-group.ts → create-project.ts`、`createProjectViaUi(page, title, memberNames, leadName = memberNames[0])` 双轮流程 + 4 个既有 spec 的机械调用点同步（纯改名提交） |
| `ed2808f` | test(desktop)!: `git mv group-chat.spec.ts → project-chat.spec.ts`（去 no-claim 点选、状态行断言 `project-turn-*`、详情页改名/目标/成员/设负责人/移出置灰/两步删除）+ `git mv group-compose.spec.ts → project-compose.spec.ts`（双轮全键盘流 + 候选无管家 + 成员轮候选无负责人） |
| `c6b15b6` | test(desktop): 新增 `project-shell.spec.ts`（§4 步骤 5 表 ①–⑧）／`project-routing.spec.ts`（网关 route/self/none、续接 respond/not_mine、显式 @ 旁路，请求计数区分「你的名片：」vs「成员名册：」）／`episode-breaker.spec.ts`（`KEPCUP_TEST_EPISODE_LIMITS=2,2`、暂停卡三态、徽标、resume 补投、stop 后 M 无新回合）；同提交修 `ProjectTurnStatusLine` 可见性：路由阶段（phase='routing' 且无目标）此前被 `currentBotId/queue` 条件挡死，「正在确认由谁回复」永不显示——改为 routing 阶段即显示（§4 步骤 5 表 ① 的必经改写，见下「落地决定」） |
| `0cf42cc` | test(desktop): 既有 spec 适配——setting-card（mode-reason 断言 群聊→项目组）、memory（删除走 `context-project-settings` → 详情页两步删除）、browser（`bindWorkdir` 项目组走 ⚙ 概览分区、绑定断言移到回沟通后）、workbench（no-claim 语义换成「@ 总落负责人 + skip_reply → 草案 +『项目里无人回应』+ 无 no-claim 卡 + 指定负责 Bot 送达」，断言未删）、butler-proposal（新增 propose_project 改负责人批准用例）、external-agents（mention-only testid 一处） |
| `6d1ebe7` | test(desktop): 首轮实跑修正——@ 弹层必须先点选再补文本（连续 pressSequentially 会把候选过滤空）、详情页成员行断言收窄到 `project-member-row-*`（picker 候选 `<li>` 同容器）、窄屏 ⚙ 从沟通视图出发（切换键语义）、新用例关首启向导、tab 横向滚动在 420px 断言（600px 五个 tab 可能放得下） |
| `517c8c1` | docs(desktop): SchedulesPanel 过期注释（group-info section → 项目详情页分区；§6 rg#1 命中） |
| （本提交） | docs(todo): 本实施记录 + README §7 进度行 |

每个提交均通过 `pnpm --filter @kepcup/desktop typecheck`（shared/core 改动先行 `run build`）。

### `rg` 自检例外说明（§6 两条）

- rg#1（`apps packages`，排除 node_modules/dist）：加 `-g '!**/migrations/**'` 后**为空**。按 §6 原样命令（不排 migrations）剩 1 处：`packages/core/migrations/main/0014_conversation_setup.sql:1` 注释「群创建 / group-setup 文档名」——**历史迁移 SQL，README §1.7 明令不改**（WP8 §3 核对时已知）。
- rg#2（中文措辞扫描 `apps/desktop/src`）：**为空**，无例外。「对话分组」（sidebar 分组）、`handover.group.*`、`profile-groups` 等非聊天群含义未动（逐一核对过命中列表）。

### 新名字与落地决定登记（§4 未列出者）

- **设置字段 `backgroundTasks.groupMentionOnly → projectMentionOnly`**：WP8 §4 步骤 1.2 的表只列了 i18n key 与 testid，但 §6 rg#1 的模式 `groupMentionOnly` 会命中 shared schema / settings.update 入参 / core llm-router / 两处 core 测试；该字段语义就是「项目组仅 @ 响应」，按「聊天群含义的 group 改掉」规则一并改名（无行为变化，`.catch` 默认吸收旧值）。
- **`ProjectTurnStatusLine` 路由阶段可见性修正**（`c6b15b6`）：原条件 `phase!=='idle' && (currentBotId!==null || queue.length>0)` 使 `turn.routing`（「正在确认由谁回复…」，WP6 落的文案）永不显示——路由阶段恰是 currentBotId=null、queue=[]。§4 步骤 5 表 ① 明确要求断言该阶段的 `project-turn-status` + 阶段文案，属 UI 与 WP 契约的既有缺陷，改为 routing 阶段恒显示。
- e2e 落地细节（不涉命名）：Electron 下 `page.setViewportSize` 不生效，窄屏用既有 `resizeWindow`（BrowserWindow.setSize，narrow-layout.spec 同法）；tab 横向滚动断言在 420px 做（600px 五个 tab 实测可能放得下，420 与 WP6 冒烟口径一致）；§4 步骤 5 表 ⑥ 授权区按 WP 允许的兜底路径只断言空态 `project-grants-empty`（无现成授权夹具：grants 只能经 access 审批流产生，browser.spec 的授权在单聊右栏），「一步可达」以 ⚙ → nav-grants 两击结构断言。
- 新 i18n key：`episode.resume/stop/resumed/stopped/pendingHint`（§2 表）、`approvals.butlerProject*` 5 键、`route.openProject`、`composer.mentionProject`、`agents.background.projectMentionOnly(+Hint)`、`schedules.workbenchProject`（前序 WP 已落，本 WP 核对文案一致）。

### 验证（T1a 收口，§5 顺序）

- `pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/core run build`：通过；`pnpm typecheck`（三包）：0 errors；`pnpm lint`：通过。
- `node scripts/run-tests.mjs run --project desktop`：86 文件 800 例全绿；`--project desktop-svelte`：14 文件 88 例全绿（新增 episodes store 6 例）；core 定向：`episode-limits-from-env` 4、`episodes-breaker` 2、`episodes-rpc` 3、`llm-router` 15、`external-agent-p6` 4 全绿。
- `pnpm build` 后逐个 e2e：`project-compose` 1/1、`project-chat` 2/2、`project-shell` 1/1、`project-routing` 1/1、`episode-breaker` 1/1、`butler-proposal` 2/2、`setting-card` 1/1、`memory` 4/4、`browser` 14/14、`narrow-layout` 2/2、`external-agents` 4/4 全绿；`workbench` 12 过 1 败——败的是既有用例 `layout: long text does not overflow; tabs below the width threshold`（900px 折 tab 形态之争，本机窗口尺寸语义），**与 WP8 无关已实证**：把该 spec 换回 `9449dba`（WP8 之前）版本单跑同样失败（本 WP 改的是同文件另一个用例 group dispatch，12 过里含它）。
- 全量 `pnpm test`（收口一次）：**499 文件 5526 通过 / 0 失败 / 23 skip**（1 spec 文件 skip），不超基线。
- 旧 `group-*` spec 与 `helpers/create-group.ts` 已不存在（§6 清单末项）。

### 偏差

无新增 DEVIATIONS（编号未推进，仍停在 DEV-035）。两处按 WP 字面会走不通的落地（`page.setViewportSize` 在 Electron 不生效 → resizeWindow；600px 下 tab 可能不溢出 → 420px 断言）与 rg#1 的历史迁移 SQL 命中，均已在上文登记，属 §1.3「由你判断」范畴，不构成设计冲突。

### 遗留（顺延）

- WP10：Wiki tab 真实视图（`project-shell.spec` ① 对 wiki 仍断言占位 `project-module-placeholder`）、删除确认框补 wiki 来源数 / 页面数。
- WP11：文档同步（`docs/dev/01-conventions.md` 常量 / ID 表、PROGRESS）；另有 `backgroundTasks.groupMentionOnly` 旧字段名残留在 `docs/dev/03-data-model.md`、`docs/dev/04-agent-runtime.md`、`docs/design/28-external-agents-acp.md`、`todo/acp-external-agents.md`（D92 只改了代码，文档同步归 WP11；审查补登）。
- 既有环境项：`workbench.spec` 的 layout 宽度形态用例在本机失败（WP8 前即失败，见上）；browser / sandbox 等沙箱类按 05-testing 基线口径本机未复跑全部。

### 审查修订（2026-10-18，T1a 收口审查）

- **P1 修复 `cc9c1f2`**：`6d1ebe7` 把提及流收进 `mentionAndSend` 后，`episode-breaker.spec.ts` 的局部 `composer` 不再被使用，HEAD 上 `pnpm lint` 失败——上文验证段「`pnpm lint`：通过」跑在该提交之前，收口口径与 HEAD 不符。已删除该死变量（无断言 / 行为改动），lint 复跑通过、该 spec 单跑通过。
- **补记 DEV-036**：`c6b15b6` 对 `ProjectTurnStatusLine` 路由阶段可见性的行为修正按 README §1.6 属「WP 假设与代码现实不成立」，执行时只登记在 §8，审查补齐 DEVIATIONS（路由阶段 `currentBotId=null`、`queue=[]`，对照 `dispatch/project-turn.ts` 载荷构造核实缺陷真实）。
- **设置字段 `groupMentionOnly→projectMentionOnly` 不需 DEV**（审查判定）：属 README §1.2「§4 没写到的新名字」的实施记录登记路径（§8 已登记判断依据）；WP8 §6 rg#1 自身含 `groupMentionOnly` 模式且扫描范围是 `apps packages`，跨包改名是该验收命令的必然要求；无迁移、无行为变化（存储读取走同一 zod schema，旧 JSON 缺省字段被 `.default(true)` 吸收，符合「不迁旧数据」的既定政策）。全部引用点（shared schema、`settings.update` 入参、core llm-router、两处 core 测试、渲染端）核对一致，其余 `backgroundTasks` 触点均为整对象展开无字段名引用，迁移 SQL 零命中。
- 审查复核结论：§2 i18n 表逐字一致（`usage.loop.triage` 只改值不改 key）；判断规则表「不改」侧（`handover.group.*`/`handover-group-*`、`profile-groups`、`apps-connected-group-*`、`apps.tier.communityGroup`、`contacts.engineGroup*`、侧栏「对话分组」）在 `9449dba..HEAD` 全量 diff 中零触碰；暂停卡四态 / 徽标 / 请求中禁用、审批卡负责人下拉与 decide 第 8 参「改了才带」、测试缝 `__KEPCUP_TEST_HOOKS__ === true` 门控、e2e 五路由场景 + `2,2` 阈值 + shell ①–⑧ 逐项落实；workbench no-claim 为语义替换断言（`no-claim-bots` 计 0 + `项目里无人回应` + run 计数不增），非删除；`6d1ebe7` 的成员行断言收窄是收紧非放宽；§6 两条 rg 复跑与登记一致（例外仅历史迁移 SQL 注释 1 处）；episodes store 6 例与 `episodeLimitsFromEnv` 4 例为真实行为断言；`ffea525`/`7f84790` 无悬挂引用、无生产行为夹带。验证复跑：`pnpm typecheck` 三包 0 错、`pnpm lint` 通过（修复后）、desktop 86 文件 800 例、desktop-svelte 14 文件 88 例、core 定向（episode-limits-from-env 4、llm-router 15）全绿、`episode-breaker.spec` 单跑通过。
