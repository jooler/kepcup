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

（执行智能体在此填写：分支、提交列表、`rg` 自检的例外说明、e2e 结果、偏差编号。）
