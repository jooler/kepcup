# WP7 · 项目详情页、成员编辑与设置卡内嵌

> 依赖：WP6 已合入（外壳、过渡壳 `ProjectSettingsPage`、`shell.openProjectSettings`）、WP4 已合入（设置目录 `project.*`、`PROJECT_DETAIL_SECTIONS`）。分支：`feat/project/wp7-ui-settings`。
> 先读 [README.md](README.md) §1、§4.11–§4.12；设计依据 [41 §11.3](../../docs/design/41-project-team.md)。

## 1. 目标

1. 用**真实的项目详情页**替换 WP6 的过渡壳（内容区页面，不是弹框）：概览 / 成员 / 授权 / 定时与监看 / 危险区五个分区，**补上 DEV-030 缺的「项目目标」编辑入口**。
2. 旧右栏 `GroupInfo` 与弹框 `GroupSettingsDialog` 的全部功能迁入详情页，然后**删除这两个文件**。**访问授权的撤销必须保持一步可达**（顶栏 ⚙ → 授权分区）。
3. 设置卡（对话内设置，D89）里的项目条目改用新的内嵌组件，深链 `project-detail` 生效。
4. 删除 Bot 的确认框：Bot 若是某些项目组的负责人，**阻止删除**并给出「去更换」入口。

不做：e2e 与文案收尾（WP8）、项目 wiki 的来源数 / 页面数展示（WP10 补）。

## 2. 固定契约

- 详情页分区 = `PROJECT_DETAIL_SECTIONS`：`overview` / `members` / `grants` / `schedules` / `danger`。testid、`data-settings-anchor`：README §4.12。
- 新组件（`features/project/`）：`ProjectSettingsPage.svelte`（重写）、`ProjectMembersEditor.svelte`（成员分区）、`ProjectMemberPicker.svelte`（搜索 + 候选，**WP6 的 `ProjectMembersMenu` 也改用它**，消除重复）；（`features/settings-card/`）：`ProjectTitleCard.svelte`、`ProjectGoalCard.svelte`、`ProjectLeadCard.svelte`、`ProjectMembersCard.svelte`；`settings-card/group-members.ts` → `project-members.ts`（`proposedMemberIds` 保留，`groupMemberPlan` → `projectMemberPlan`，`GroupMemberPlan` → `ProjectMemberPlan`；测试同步改名）。
- store（`chat.svelte.ts`，WP1 已建 / WP6 视情补）：`renameProject(conversationId, title)` / `updateProjectGoal(conversationId, goal)` / `setProjectLead(conversationId, botId)` / `addProjectMembers(conversationId, botIds)` / `removeProjectMember(conversationId, botId)`，均返回 `Promise<boolean>`（失败 toast 并返回 `false`），内部调 `projects.update` / `projects.setLead` / `projects.addMembers` / `projects.removeMember`。
- i18n（原样使用；`group.*` 中被删组件用到的 key 全部删除，`MessageKey` 类型检查会指出遗漏）：

| key | 文案 |
|---|---|
| `projectSettings.title` | 项目详情 |
| `projectSettings.nav.overview` | 概览 |
| `projectSettings.nav.members` | 成员 |
| `projectSettings.nav.grants` | 授权 |
| `projectSettings.nav.schedules` | 定时与监看 |
| `projectSettings.nav.danger` | 危险区 |
| `projectSettings.name` | 项目名称 |
| `projectSettings.save` | 保存 |
| `projectSettings.goal` | 项目目标 |
| `projectSettings.goalHint` | 告诉成员这个项目要达成什么；它会写进每位成员的上下文。 |
| `projectSettings.goalPlaceholder` | 例如：在十一月底前完成官网改版并上线 |
| `projectSettings.goalCount` | {count} / {max} |
| `projectSettings.workdir` | 工作目录 |
| `projectSettings.lead` | 项目负责人 |
| `projectSettings.leadBadge` | 负责人 |
| `projectSettings.makeLead` | 设为负责人 |
| `projectSettings.removeMember` | 移出项目组 |
| `projectSettings.removeLeadBlocked` | 请先更换负责人 |
| `projectSettings.memberDetailTitle` | 成员名片 |
| `projectSettings.expertise` | 擅长 |
| `projectSettings.responsibilities` | 职责 |
| `projectSettings.grantsTitle` | 各成员的授权 |
| `projectSettings.grantsEmpty` | 当前项目组没有有效授权。 |
| `projectSettings.revoke` | 撤销 |
| `projectSettings.grantWrite` | 读写 |
| `projectSettings.grantRead` | 只读 |
| `projectSettings.schedulesTitle` | 定时任务 |
| `projectSettings.dangerTitle` | 危险区 |
| `projectSettings.delete` | 删除项目组 |
| `projectSettings.deleteBody` | 项目组的消息、附件、定时任务和工作目录绑定将被删除，无法恢复；工作目录里的文件不受影响。 |
| `projectSettings.deleteConfirm` | 确认删除 |
| `projectSettings.cancel` | 取消 |
| `settingCard.project.noBots` | 没有可选的 Bot |
| `settingCard.project.willAdd` | 将加入：{names} |
| `settingCard.project.willRemove` | 将移出：{names} |
| `settingCard.project.leadHint` | 更换负责人后，没有 @ 的消息会先交给新的负责人判断 |
| `contacts.deleteBlockedLead` | 该 Bot 是 {count} 个项目组的负责人，需先更换负责人才能删除： |
| `contacts.deleteGoReplace` | 去更换 |

## 3. 开工前核对

```bash
rg -n "GroupInfo|GroupSettingsDialog|groupMemberPlan|group-members|group-title|settingCard\.group" apps/desktop/src -g '!**/dist/**'
rg -n "Transitional shell" apps/desktop/src                 # WP6 的过渡壳，本 WP 替换
rg -n "PENDING_DESKTOP_ANCHORS" packages/shared             # WP4 登记的四个锚点，本 WP 删
rg -n "deletionPreview|ledProjects" apps/desktop/src packages/shared/src -g '!**/dist/**'
```

必读：`features/project/ProjectSettingsPage.svelte`（过渡壳）、`features/right-panel/GroupInfo.svelte`（350 行全文：授权分组、成员行、浏览器「显示」按钮、成员详情弹框）、`features/chats/GroupSettingsDialog.svelte`（358 行：`embedded` 模式的标题 / 成员计划逻辑与解散流程）、`features/settings-card/{SettingCardEmbed.svelte,card-components.ts,open-deep-link.ts,deep-link.ts,group-members.ts,apply.ts}`（`applySettingItem` 的签名与 `expected` / `messageId` 语义）、`features/workdirs/WorkdirSelector.svelte`（WP0-2 后的名字；props `{ conversationId, workdirId, disabled }`）、`features/right-panel/SchedulesPanel.svelte`、`features/watches/WatchesPanel.svelte`、`stores/{permissions,contacts,browser-pages}.svelte.ts`、`features/handover/RetireBotButton.svelte`、`features/contacts/ContactsSection.svelte`、`features/settings/anchor-scroll.ts`（`revealDialogAnchor`）。

## 4. 步骤

### 步骤 1：store 方法

WP1 已把 `renameGroup` / `addGroupMembers` / `removeGroupMember` 改成 `renameProject` / `addProjectMembers` / `removeProjectMember`（调 `projects.*`）；本 WP 在 `chat.svelte.ts` **新增** `updateProjectGoal`、`setProjectLead`（§2）。若开工时发现某个仍是旧名，说明 WP1 没做完——补上并在实施记录说明。失败统一 `toast.error(errorText(errorCode(error), …))`；`PROJECT_LEAD_REQUIRED` 错误码在 `chats.errorCode` 里加一条文案「请先更换项目负责人」。成功后依赖 `conversation.updated` 事件刷新 `chat.current`（不要手工拼状态）。

### 步骤 2：`ProjectMemberPicker.svelte`（共享的「搜索 + 候选」）

props：`{ excludeIds: string[]; onPick: (botId: string) => void | Promise<void>; testid: string }`。内容：搜索输入（`placeholder={t('project.members.search')}`）+ 候选列表（`composePool(contacts.bots)` 去掉 `excludeIds`，用 WP5 的 `composeCandidates` 按输入过滤；空列表显示 `project.members.noAddable`）；点候选调 `onPick` 并清空输入。输入框 `keydown` 一律 `stopPropagation`。**WP6 的 `ProjectMembersMenu` 里内联的那一块改用本组件**（`excludeIds` = 现有成员；testid 保持 `project-member-add`）。

### 步骤 3：`ProjectSettingsPage.svelte`（重写，替换过渡壳）

根节点 `data-testid="project-settings-page"`；布局：窄屏单栏，宽屏左侧窄导航（`project-settings-nav-<section>` 五个按钮）+ 右侧可滚动内容（五个 `<section data-testid="project-settings-section-<section>">` 依次排列）。**`shell.projectSettingsSection` 驱动滚动**：`$effect` 在它变化（含首次挂载）时 `scrollIntoView({ block: 'start' })` 到对应分区；点导航按钮也 `scrollIntoView` 并同步该字段。内容区读 `chat.current`（必须 `conversation.type === 'project'` 且 `id` 为当前会话；否则显示空态并 `shell.projectView = 'chat'`）。

**概览**（`overview`）：
- 项目名称：`Input`（`data-testid="project-title-input"`，`data-settings-anchor="project-title"`，`maxlength={PROJECT_TITLE_MAX}`），失焦或回车保存（空串还原；与当前相同不提交；回车后紧跟的 blur 不重复提交，沿用 `GroupInfo` 的 `renaming` 防抖写法）→ `chat.renameProject`；旁边「保存」按钮 `project-title-save`（可选，键盘用户用）。
- 项目目标：`Textarea`（`project-goal-input`，`data-settings-anchor="project-goal"`，`maxlength={PROJECT_GOAL_MAX_CHARS}`），下方 `projectSettings.goalHint` 与计数 `projectSettings.goalCount`；失焦保存（内容 trim 后与当前相同不提交；清空 = 清除目标，传 `null`）+「保存」按钮 `project-goal-save` → `chat.updateProjectGoal`。
- 工作目录：容器 `data-testid="project-workdir"`，里面放 `WorkdirSelector`（`conversationId`、`workdirId={conversation.workdirId}`、`disabled={conversation.readOnly}`）；标题 `projectSettings.workdir`。
- 项目负责人：只读一行（头像 + 名字 + 徽标，`data-testid="project-lead-badge"`），旁边文字链接「更换」→ 滚动到成员分区。

**成员**（`members`）：`<ProjectMembersEditor conversationId=… />`。

**授权**（`grants`）：照搬 `GroupInfo` 的授权块（按 Bot 分组、路径、读写标签、撤销按钮）：`permissions.grants` 的分组逻辑、`permissions.revokeGrant(grant.id)`；testid：容器 `project-grants-list`、空态 `project-grants-empty`、撤销按钮 `project-grant-revoke-<grantId>`；文案用 `projectSettings.grants*`。**这是安全控制，必须一步可达**：顶栏 ⚙ 直接进入详情页，授权分区在导航里就是一个按钮。

**定时与监看**（`schedules`）：`<SchedulesPanel {conversationId} testid="project-schedules" />` 与 `<WatchesPanel {conversationId} testid="project-watches" />`（原 `group-schedules` / `group-watches`），小标题 `projectSettings.schedulesTitle` 与 `watches.title`。

**危险区**（`danger`）：「删除项目组」按钮 `project-delete-begin` → 展开确认框 `project-delete-confirm-box`（`projectSettings.deleteBody` + 「确认删除」`project-delete-confirm` + 「取消」）→ `chat.deleteConversation(conversationId)`，成功后回到会话列表（沿用 `GroupSettingsDialog` 的 `deleteGroup` 后续处理）。WP10 会在确认框里补 wiki 来源数 / 页面数。

### 步骤 4：`ProjectMembersEditor.svelte`

根节点 `data-testid="project-member-list"`，`data-settings-anchor="project-members"`。读 `chat.current.members`（`conversation.leadBotId` 判断谁是负责人，负责人排第一）。

- 成员行（`data-testid="project-member-row-<botId>"`）：头像 + 名字 + 职责一行；负责人带徽标（`projectSettings.leadBadge`，**负责人行加 `data-settings-anchor="project-lead"`**）；点行主体打开**成员名片弹框**（`data-testid="project-member-detail"`，内容移植 `GroupInfo` 的成员详情：名字、简介、擅长 / 职责、浏览器「显示」按钮及其显隐规则——沿用 `browserPages` / `hasBrowserPage` / `showBrowser` / `BROWSER_SHOW_BTN_CLASS`）。成员名片是小弹框，允许（只有「详情页本身」不用弹框）。
- 行内操作：非负责人 →「设为负责人」按钮（`project-make-lead-<botId>`）→ `chat.setProjectLead`；每行一个移出按钮（`project-member-remove-<botId>`，`X` 图标）→ `chat.removeProjectMember`；**负责人行的移出按钮置灰**，`title={t('projectSettings.removeLeadBlocked')}`（后端也会以 `PROJECT_LEAD_REQUIRED` 拒绝，这里只是提前提示）。
- 行下方「添加成员」：`ProjectMemberPicker`（`excludeIds` = 现有成员；`onPick` → `chat.addProjectMembers(conversationId, [botId])`；testid 前缀 `project-member-add`）。

### 步骤 5：设置卡内嵌

1. **从 `GroupSettingsDialog.svelte` 的 `embedded` 分支迁出**逻辑（保持行为一致，包括：`expected` 冲突检测与 `onConflict`、`prefill` 的处理、`messageId`、`cardBusy` 防重入、`applySettingItem` 调用、成功 `toast.success(t('settingCard.appliedToast'))`）：
   - `ProjectTitleCard.svelte`：根节点 `data-testid="project-card-embedded"` 内一个输入 `project-card-title` 与保存按钮 `project-card-title-save`；`applySettingItem({ itemId: 'project.title', values: { title }, expected, target: { conversationId }, messageId })`。
   - `ProjectGoalCard.svelte`：`project-card-goal`（`Textarea`）/ `project-card-goal-save`；`itemId: 'project.goal'`，`values: { goal }`；预填取 `prefill.goal`。
   - `ProjectLeadCard.svelte`：成员单选列表（`project-card-lead-<botId>`，当前负责人预选；预填 `prefill.botId` 优先）、保存 `project-card-lead-save`；`itemId: 'project.lead'`，`values: { botId }`；显示 `settingCard.project.leadHint`。
   - `ProjectMembersCard.svelte`：成员勾选计划卡，逻辑来自原 `embedded` 成员分支与 `project-members.ts`（`projectMemberPlan`：现有成员默认勾选、预填只会多勾、移出只来自用户亲手取消勾选；「将加入 / 将移出」分列，`project-card-will-add` / `project-card-will-remove`；保存 `project-card-members-save` 调 `chat.addProjectMembers` / `removeProjectMember`；**候选名册不含管家**）。每个成员勾选 `project-card-member-<botId>`；无可选 Bot 显示 `settingCard.project.noBots`。
2. `SettingCardEmbed.svelte`：`'group-title'` / `'group-members'` 两个分支替换为四个：`'project-title'` → `ProjectTitleCard`、`'project-goal'` → `ProjectGoalCard`、`'project-lead'` → `ProjectLeadCard`、`'project-members'` → `ProjectMembersCard`；删除 WP4 留下的临时映射与 `link` 兜底及 `// WP7 replaces` 注释。
3. `card-components.ts`：`SETTING_CARD_COMPONENTS` 里 `'group-title'` / `'group-members'` 两行换成上述四个键 → 组件名；`card-components.test.ts` 通过（它核对 shared 的 `CARD_KEYS` 全部有组件、且 `SettingCardEmbed.svelte` 确实 import 了这些组件）。
4. **深链**：`settings-card/deep-link.ts` 的 `settingDeepLinkAction` 新增分支：`surface === 'project-detail'` → `{ kind: 'project-detail', section: ProjectSettingsSection, anchor: string | null, conversationId: string | null }`（`conversationId` 取 `target.conversationId`；`section` 不在 `PROJECT_DETAIL_SECTIONS` 里 → 报错分支，参照现有对未知 section 的处理）；`open-deep-link.ts` 对应分支：若 `conversationId` 与当前会话不同先 `await chat.select(conversationId)`，然后 `shell.openProjectSettings(section)`，等页面渲染后用 `revealDialogAnchor(document, anchor)`（或同目录的 `anchor-scroll.ts` 里适合页面的变体）把锚点滚入视野并闪一下。`deep-link.test.ts` 增 `project-detail` 用例，并保证其中「每个目录条目的 `deepLink.surface` 都能解析成对应 `kind`」的遍历断言通过。
5. **锚点登记**：把 WP4 登记到 `PENDING_DESKTOP_ANCHORS`（`packages/shared/src/settings-catalog/coverage.ts`）的 `project-title` / `project-goal` / `project-members` / `project-lead` **删除**（本 WP 已在页面里加了真正的 `data-settings-anchor`；设置目录的 UI 扫描测试会同时检查「列在 pending 里的锚点确实还不存在」，所以必须同步删）。
6. 原 `GroupSettingsDialog` 的 `settingCard.group.*` i18n（`noBots` / `willAdd` / `willRemove`）→ 上表的 `settingCard.project.*`。

### 步骤 6：删除旧文件与引用

- 删除 `features/right-panel/GroupInfo.svelte`、`features/chats/GroupSettingsDialog.svelte`，以及它们独占的 i18n key（`group.*` 里：`namePlaceholder`、`settings`、`settingsTitle`、`renameLabel`、`renameSave`、`addMembersLabel`、`addMembersButton`、`removeMember`、`deleteGroup`、`deleteBody`、`memberCount`、`addMember`、`searchBots`、`noAddableBots`、`membersTitle`、`grantsTitle`、`grantsEmpty`、`memberDetailTitle`、`responsibilities`、`expertise`、`schedulesTitle`；逐个用 `rg` 确认无引用再删）。
- `group-members.ts` / `group-members.test.ts` → `project-members.ts` / `project-members.test.ts`（`git mv` + 改名，测试断言不变）。
- `sidebarDialogs` store 里 WP6 已删的 `groupSettings*` 状态确认已清干净。

### 步骤 7：删除 Bot 的确认框（阻止负责人被删）

`bots.deletionPreview` 现在返回 `ledProjects: Array<{ id: string; title: string | null }>`（WP1）。`contacts.svelte.ts` 的 `deletionPreview` 类型同步；在使用它的三处（`features/contacts/ContactsSection.svelte`、`features/right-panel/RightPanel.svelte`、`features/handover/RetireBotButton.svelte`）：`ledProjects.length > 0` 时，确认框**不显示「确认删除」按钮**（或置灰），改显示 `contacts.deleteBlockedLead`（`{count}` = 个数）与项目名列表，每项一个「去更换」按钮（`contacts.deleteGoReplace`）→ 关闭确认框、`await chat.select(project.id)`、`shell.openProjectSettings('members')`。后端 `deleteBot` 仍会以 `PROJECT_LEAD_REQUIRED` 拒绝（WP1），这里是提前拦截的体验层。

## 5. 测试

- 单测：`project-members.test.ts`（改名）；`deep-link.test.ts`（`project-detail`）；`card-components.test.ts`；一个针对页面逻辑的纯函数测试——把「标题 / 目标保存的判定」（trim、与当前相同不提交、空标题还原、空目标 → `null`、超长截断）抽成 `features/project/project-settings-model.ts` 并单测，组件只调用它。
- 设置目录的 UI 扫描 / 覆盖测试（`packages/shared/test/unit/settings-catalog*.test.ts`）必须通过：确认四个锚点已从 pending 删除且在渲染层源码里真实存在。
- **不写、不改 e2e**（WP8）。
- 手工冒烟（写进实施记录）：① ⚙ → 详情页五分区、导航滚动；② 改名 / 改目标并保存，顶栏标题即时变化，Bot 下一轮上下文里看到新目标（可看 `<conversation_info>`）；③ 设为负责人、移出成员、移出负责人被置灰；④ 授权撤销一步可达且生效；⑤ 定时任务与监看列表正常；⑥ 删除项目组两步确认；⑦ 在对话里让 Bot 出 `project.members` / `project.title` / `project.goal` / `project.lead` 设置卡，卡内嵌组件可用、点「在设置中打开」跳到详情页对应锚点；⑧ 删除一个正在担任负责人的 Bot：确认框被替换为「去更换」入口。

## 6. 验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/desktop typecheck && pnpm lint
node scripts/run-tests.mjs run --project desktop
node scripts/run-tests.mjs run packages/shared
```

## 7. 验收清单

- [ ] 详情页五分区齐全，内容区页面（非弹框）；项目目标可编辑（DEV-030 已解决）；授权撤销一步可达。
- [ ] `GroupInfo.svelte`、`GroupSettingsDialog.svelte`、`group-members.*` 已删除 / 改名；自检为空：

```bash
rg -n "GroupInfo|GroupSettingsDialog|groupMemberPlan|GroupMemberPlan|group-members|group-title|settingCard\.group|Transitional shell|WP7 replaces|renameGroup|addGroupMembers|removeGroupMember" apps packages -g '!node_modules' -g '!**/dist/**' -g '!**/migrations/**'
```

- [ ] 四个设置卡（title / goal / lead / members）内嵌可用；`project-detail` 深链生效；四个锚点已从 `PENDING_DESKTOP_ANCHORS` 删除且设置目录扫描测试通过。
- [ ] 顶栏成员弹层与成员分区共用 `ProjectMemberPicker`。
- [ ] 删除负责人 Bot 被前端拦截并引导去更换。
- [ ] desktop `typecheck` / `lint` / 单测与 shared 测试绿；实施记录已填。

## 8. 陷阱

- 标题 / 目标的「失焦保存」要防重复提交（回车后紧跟 blur）与「还原空标题」，沿用 `GroupInfo` 里 `renaming` 的写法，**不要重新发明**。
- `embedded` 卡的 `expected` / `onConflict` / `messageId` 是 D89 的并发语义，行为必须与旧实现一致，否则设置卡的冲突检测会失效。
- 成员名册要**排除管家**（候选池与卡片勾选都是）。
- 设置目录的 UI 扫描测试会核对锚点：加了 `data-settings-anchor` 就一定要删 pending 里的登记，反之亦然。
- 页面里的 `ProjectMembersEditor` 与顶栏弹层是两个入口、一份候选逻辑——别复制 `ProjectMemberPicker`。
- 不要给详情页再套 `Dialog`；只有「成员名片」「删除确认」这类小弹框允许。

## 9. 实施记录

（执行智能体在此填写：分支、提交列表、手工冒烟结果、偏差编号。）
