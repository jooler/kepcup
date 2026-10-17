# WP6 · 项目组外壳：两行顶栏、模块 tab、成员头像堆叠、撤右栏

> 依赖：**WP5 已合入**（`composePool` / `composeCandidates` / `composingProject`；二者都改 `ChatView` / `ChatsArea` / `NarrowShell` / `AppSidebar`，不得并行）、WP1 已合入。可与 core 链（WP2–WP4）、WP9 并行。分支：`feat/project/wp6-ui-shell`。
> 先读 [README.md](README.md) §1、§4.11（store 契约）、§4.12（testid）、§4.13（模块注册表）；设计依据 [41 §7.2、§11.2–§11.4](../../docs/design/41-project-team.md)。

## 1. 目标

项目组会话（`conversation.type === 'project'`）的主区域改为：

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 项目名称                                                  (👑)(👤)(👤)+2   ⚙  │
│ [沟通 ●]  Wiki  看板  OKR  日历                                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                    当前模块的内容（沟通 / Wiki / 占位 / 项目详情页）            │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **顶栏是实心块**（不再是浮动渐隐药丸），左侧两行（项目名 / 模块 tab），右侧一行（重叠头像堆叠 + 设置按钮）。**单聊保持原样**（药丸 + 右栏）。
- 沟通 tab = 现有 `ChatView` 主体（消息列表 + 输入坞）；Wiki tab 本 WP 先放占位（WP10 接真实视图）；看板 / OKR / 日历 tab **灰显**、不可点。
- 点右侧 ⚙：**项目详情页显示在内容区**（tab 行不新增项，⚙ 呈选中态）；再点任一 tab 或再点 ⚙ 返回沟通。本 WP 的详情页只是**过渡壳**（里面先放旧的 `GroupInfo`，WP7 替换）。
- **项目组会话不再渲染右栏**，右栏只服务单聊。
- 沟通 tab 带徽标：用户在别的 tab 时不会漏掉新消息与待确认。
- 侧栏的群头像堆叠、右键「群设置」改名并改行为。

不做：详情页真实内容（WP7）、Wiki 视图（WP10）、e2e / 文案收尾（WP8）、`GroupTurnStatusLine` 改名（WP8）。

## 2. 固定契约

- `shell.svelte.ts`：`type ProjectView = 'chat' | 'wiki' | 'board' | 'okr' | 'calendar' | 'settings'`；`projectView = $state<ProjectView>('chat')`；`projectSettingsSection = $state<ProjectSettingsSection>('overview')`（`ProjectSettingsSection` = `typeof PROJECT_DETAIL_SECTIONS[number]`，常量由 WP4 放在 shared 并导出，值 `'overview' | 'members' | 'grants' | 'schedules' | 'danger'`）；方法 `openProjectModule(id: ProjectModuleId)`（`status !== 'available'` 的模块直接忽略）、`openProjectSettings(section?: ProjectSettingsSection)`。
- `chat.select()` 完成时把 `shell.projectView` 重置为 `'chat'`、`projectSettingsSection` 重置为 `'overview'`（与 `mainView` 的「收口不变式」同一处，约 `chat.svelte.ts` l.355）；`leaveCurrent()` 同样重置。
- 新组件（目录 `apps/desktop/src/renderer/src/lib/features/project/`）：`ProjectView.svelte`、`ProjectHeader.svelte`、`ProjectTabs.svelte`、`ProjectMembersMenu.svelte`、`ProjectSettingsPage.svelte`（本 WP 为过渡壳）、`ModulePlaceholder.svelte`、`project-tabs.ts`（纯逻辑）、`project-chat-badge.ts`（纯逻辑）。
- testid：README §4.12「顶栏」「内容」两组；`project-settings-page` 由过渡壳承担。
- i18n（文案原样）：

| key | 文案 |
|---|---|
| `project.untitled` | 未命名项目组 |
| `project.module.chat` | 沟通 |
| `project.module.wiki` | Wiki |
| `project.module.board` | 看板 |
| `project.module.okr` | OKR |
| `project.module.calendar` | 日历 |
| `project.module.soon` | 即将推出 |
| `project.module.soonBody` | 该模块将在后续版本推出 |
| `project.module.wikiSoon` | 项目 wiki 正在开发中 |
| `project.header.settings` | 项目详情 |
| `project.header.membersTrigger` | 查看成员 |
| `project.members.title` | 项目成员 |
| `project.members.leadBadge` | 负责人 |
| `project.members.count` | {count} 位成员 |
| `project.members.add` | 添加成员 |
| `project.members.manage` | 管理成员… |
| `project.members.search` | 搜索 Bot |
| `project.members.noAddable` | 没有可添加的 Bot |
| `project.tab.badgeNew` | {count} 条新消息 |
| `project.tab.badgePending` | 有待确认的操作 |
| `sidebar.projectDetail` | 项目详情 |

## 3. 开工前核对

```bash
rg -n "type === 'project'" apps/desktop/src/renderer/src | head -30            # WP1 改过的位置
rg -n "GroupInfo|GroupSettingsDialog|groupSettingsId|openGroupSettings|context-group-settings" apps/desktop/src -g '!**/dist/**'
rg -n "GroupAvatarStack|group-avatar-layout|group-avatar-stack" apps/desktop -g '!node_modules' -g '!**/dist/**'
```

必读：`features/chats/ChatView.svelte`（全文 290 行）、`ChatsArea.svelte`（40 行）、`features/chats/MessageList.svelte`（顶部 `pt-14` 在约 l.159，`bottomInset` 在 l.15 / 160 / 205）、`features/right-panel/RightPanel.svelte`（`isGroup` 分支约 l.39–40、l.327–328；手写 tablist 的注释约 l.78–81 解释了为什么不用组件库 Tabs）、`stores/shell.svelte.ts`、`stores/chat.svelte.ts` 的 `select()`（约 l.316–372）与 `leaveCurrent`、`features/shell/{NarrowShell.svelte,narrow-layout.svelte.ts}`、`features/shell/BotDetailOverlay.svelte`、`features/sidebar/{AppSidebar,SidebarDialogs}.svelte`、`avatars/{GroupAvatarStack.svelte,group-avatar-layout.ts}`、`stores/permissions.svelte.ts`（`pendingOf(conversationId)`）、`components/ui/`（有 `dropdown-menu`、`dialog`、`tooltip`、`badge`、`avatar`、`separator`；**没有** `popover` 与 `scroll-area`）。

## 4. 步骤

### 步骤 1：shell store 与 `chat.select()` 重置

按 §2 实现状态与两个方法。`openProjectSettings(section)`：设 `projectView = 'settings'`、`projectSettingsSection = section ?? 'overview'`。`openProjectModule(id)`：`PROJECT_MODULES` 里该模块 `status === 'available'` 才切换，否则忽略；切换前若 `projectView` 已是它，不动。`chat.select()` 重置位置见 §2。

**单测**（`stores/shell-project.svelte.test.ts`，参照 `stores/app-detail.svelte.test.ts` 的 `desktop-svelte` 写法）：默认 `'chat'`；`openProjectSettings('members')` 同时设视图与分区；`openProjectModule('board')`（planned）被忽略；`openProjectModule('wiki')` 生效；再 `openProjectModule('chat')` 回沟通。`select()` 的重置在 e2e 里验证（WP8）。

### 步骤 2：纯逻辑

`features/project/project-tabs.ts`：

```ts
export interface ProjectTabItem { id: ProjectModuleId; labelKey: MessageKey; disabled: boolean }
export function projectTabs(modules: readonly ProjectModuleDescriptor[]): ProjectTabItem[]; // 顺序同注册表；planned → disabled
```

`features/project/project-chat-badge.ts`：

```ts
export interface ChatTabBadge { unread: number; pending: boolean }
/** unread = 用户可见、非用户本人发出、seq > seenSeq 的消息条数；pending = 该会话有待确认审批。 */
export function chatTabBadge(input: { messages: readonly Message[]; seenSeq: number; pendingApprovals: number }): ChatTabBadge;
```

`unread` 的口径：`message.seq > seenSeq`，`senderType !== 'user'`，`status !== 'recalled'`，且对用户可见（复用 `domain/messages` 对应的渲染层判断：`MessageList` 里过滤 `hiddenFromTranscript` / `isInterimMessage` / `run_changes` 的那组条件——**抽成一个共享函数** `isVisibleInTranscript(message, approvals)` 放在 `features/chats/transcript-visibility.ts`，让 `MessageList` 与徽标共用，**不要复制**条件）。单测覆盖：用户自己的消息不计；撤回不计；内部 / 任务进度 / `run_changes` 卡不计；`seq ≤ seenSeq` 不计；`pending` 取 `pendingApprovals > 0`。

### 步骤 3：`MessageList` 与 `ChatView` 重构

1. **`MessageList.svelte`**：新增 prop `topInset?: number`（px，默认 `56`，即现在的 `pt-14`）；容器 `class` 里的 `pt-14` 改成 `style="padding-top: {topInset}px; padding-bottom: …"`（保持与 `bottomInset` 同样的写法）。`isVisibleInTranscript` 抽取按步骤 2。
2. **`ChatView.svelte`**：用 Svelte 5 `{#snippet}` 把现有「浮动提示条 + `MessageList` + 输入坞 + `StickiesLayer` + `MediaLightbox`」那一整块抽成 `chatBody`，**一份代码两处渲染**：

```svelte
{#snippet chatBody(topInset: number, bannerTopClass: string)}
  <!-- 原来的：浮动提示条（readonly / confirm-mode / run-failed，top-14 换成 {bannerTopClass}）、
       MessageList topInset={topInset} bottomInset={composerDockHeight}、composer-dock、StickiesLayer、MediaLightbox -->
{/snippet}

{#if chat.composingProject}
  …（WP5 已处理）
{:else if !current}
  …（空态不变）
{:else if isProject}
  <ProjectView {chatBody} />          <!-- 项目组：实心顶栏 + 内容区；沟通内容用同一个 chatBody -->
{:else}
  <div class="relative h-full min-h-0 min-w-0 flex-1" data-testid="chat-view" …>
    <header>…单聊的浮动药丸，原样…</header>
    {@render chatBody(56, 'top-14')}
  </div>
{/if}
```

   - `isProject = $derived(current?.conversation.type === 'project')`（WP1 已把 `isGroup` 的比较改为 project；本 WP 把变量名改 `isProject`，并**删除**单聊药丸里所有 `isGroup` 分支：药丸只服务单聊了，删掉 `GroupAvatarStack` 与群标题分支）。
   - `ProjectView` 接收 `chatBody` snippet 作为 prop（Svelte 5 snippet 可以作为 prop 传递），在内容区 `view === 'chat'` 时渲染它：`{@render chatBody(12, 'top-3')}`。
   - **沟通内容必须保持挂载**：其它视图（Wiki / 详情 / 占位）显示时，沟通的 DOM 用 `class:hidden` 隐藏而**不卸载**（保留输入框草稿、滚动位置与未发送附件）。实现：`ProjectView` 里沟通容器始终渲染，`hidden` 类按 `shell.projectView !== 'chat'` 切换；其它视图用 `{#if}` 渲染在它旁边。
   - `ProjectView` 根节点 `data-testid="project-view"`，带 `data-view={shell.projectView}`；整个项目组外壳根节点 `data-testid="chat-view"` 保留（既有 e2e 用它判断「已进入某会话」），再加 `data-project="true"`。
   - 不要改 `markRead` 逻辑：当前会话的新消息仍按现有方式立刻已读；徽标的「未读」靠 `seenSeq` 另算（步骤 4）。

### 步骤 4：`ProjectHeader`、`ProjectTabs`、`ProjectMembersMenu`

**`ProjectHeader.svelte`**（`data-testid="project-header"`，整块 `app-drag`，交互子元素 `app-no-drag`）：

- 结构：`<header class="app-drag flex items-center justify-between gap-3 border-b bg-background px-4 py-2">`，左 `<div class="flex min-w-0 flex-col gap-1.5">`（第一行 `<h1 data-testid="project-title" class="truncate text-base font-medium">` = `conversation.title ?? t('project.untitled')`；第二行 `<ProjectTabs />`），右 `<div class="app-no-drag flex shrink-0 items-center gap-2">`（`<ProjectMembersMenu />` + 设置按钮）。
- **窄屏**（`narrowLayout.narrow`）：最左加返回按钮（沿用单聊的 `data-testid="narrow-back-button"`、`chat.leaveCurrent()`、`aria-label={t('narrow.back')}`）；macOS 沿用 `isMac ? 'pl-20' : …` 让出红绿灯（照抄 `ChatView` 现有写法）；tab 行 `overflow-x-auto`（横向滚动，不换行）。
- **设置按钮**：`Button variant="ghost" size="icon"`，图标 `Settings`（`@lucide/svelte`），`data-testid="project-settings-button"`，`aria-pressed={shell.projectView === 'settings'}`，`title={t('project.header.settings')}`；点击：当前已是 `'settings'` → `shell.projectView = 'chat'`，否则 `shell.openProjectSettings()`。选中态（`aria-pressed` 为真）背景为 `bg-accent`。
- 徽标数据：`seenSeq` 是组件内 `$state`；`$effect`：`shell.projectView === 'chat'` 时 `seenSeq = current.conversation.lastSeq`（并在用户正在看沟通时随新消息推进）；`chatTabBadge({ messages: chat.current.messages, seenSeq, pendingApprovals: permissions.pendingOf(conversationId).length })` 传给 `ProjectTabs`。**会话切换时** `seenSeq` 重置为新会话的 `lastSeq`。

**`ProjectTabs.svelte`**（`role="tablist"`，`data-testid="project-tabs"`；**手写按钮条**，不用 `components/ui/tabs`——原因见 `RightPanel.svelte` 约 l.78–81 的注释：组件库 Tabs 的样式变体写在 `data-active:` 上而 bits-ui 输出 `data-state="active"`，激活样式不生效）：

- 每项一个 `<button role="tab">`，`data-testid="project-tab-<id>"`，`aria-selected`，`data-active`；样式照抄 RightPanel 的药丸分段条（激活项灰底圆角胶囊，非激活项透明度减半）。
- `disabled`（planned 模块）：`disabled` 属性 + `data-disabled="true"` + `title={t('project.module.soon')}` + 文字更淡；点击无反应。
- 点击 → `shell.openProjectModule(id)`；`shell.projectView === 'settings'` 时**没有任何 tab 呈激活态**。
- **沟通 tab 的徽标**：`badge.unread > 0` → 圆点 + 数字（`data-testid="project-tab-badge-chat"`，`data-kind="unread"`，`title=t('project.tab.badgeNew',{count})`）；否则 `badge.pending` → 琥珀色圆点（同 testid，`data-kind="pending"`，`title=t('project.tab.badgePending')`）；仅当**当前不在沟通视图**时显示徽标（在沟通里时不显示，用户本来就看着）。

**`ProjectMembersMenu.svelte`**（头像堆叠 + 下拉；**自建轻量弹层，不用 bits-ui `DropdownMenu`**——因为里面要放搜索输入框，菜单的 typeahead 会吃掉按键；仓库也没有 `popover` 组件）：

- 触发器：`<button data-testid="project-members-trigger" aria-haspopup="true" aria-expanded={open} aria-label={t('project.header.membersTrigger')}>`，里面是**重叠头像堆叠**：成员按「负责人在最前，其余按入群顺序」，最多画 5 个，后一个压在前一个上（`-space-x-2`，每个头像 `ring-2 ring-background`，`size-7`，用 `BotAvatar`，`animated={false}`），负责人头像右下角叠一个小 `Crown` 图标；超过 5 个在末尾画一个 `+N` 圆形计数。**不要复用 `ProjectAvatarStack`**（那是侧栏用的马赛克，语义不同）。
- 弹层：触发器下方右对齐的 `div`（`absolute right-0 top-full z-50 mt-2 w-72 rounded-xl border bg-background p-2 shadow-lg`，`data-testid="project-members-menu"`）；`open` 为真时渲染；**点击弹层外部或按 `Esc` 关闭**（`<svelte:window onpointerdown>` 判断 target 是否在弹层 / 触发器内；`onkeydown` 的 `Escape`）；打开时把焦点放到搜索框。
- 内容：标题行「项目成员 · {count} 位成员」；成员行（`data-testid="project-member-row-<botId>"`）：头像、名字、负责人带「负责人」徽标、职责一行（`bot.profile.role.responsibilities || bot.bio`，截断）；分隔线；**添加成员**区：搜索输入 `data-testid="project-member-add"`（`placeholder={t('project.members.search')}`）+ 候选列表（`composePool(contacts.bots)` 去掉现有成员后按输入过滤，用 WP5 的 `composeCandidates`；空列表显示 `project.members.noAddable`），点候选 → `chat.addProjectMembers(conversationId, [botId])`（store 方法名按 README §4.11；**若 WP1 没建它，本 WP 在 store 里补一个调用 `projects.addMembers` 的薄封装**）；成功后清空输入，列表自动刷新（`conversation.updated` 事件会更新 `chat.current.members`）。底部一个文字按钮「管理成员…」→ `shell.openProjectSettings('members')` 并关闭弹层。
- 输入框的 `keydown` 一律 `event.stopPropagation()`，以免触发全局快捷键。

**`ModulePlaceholder.svelte`**：居中的图标 + 文案；`data-testid="project-module-placeholder"`，`data-module={id}`。`wiki` 用 `project.module.wikiSoon`，其余用 `project.module.soonBody`。

**`ProjectSettingsPage.svelte`（过渡壳）**：根节点 `data-testid="project-settings-page"`，可滚动容器，内部直接渲染旧的 `<GroupInfo conversationId={…} />`（它此时已被 WP1 改成读写 project；**在页面顶部加一行小标题** `t('project.header.settings')`）。**这是 WP7 要整体替换的过渡内容，文件顶部写注释 `// Transitional shell: WP7 replaces the body with the real project details page`，并登记到实施记录。**

**`ProjectView.svelte`**：接收 `chatBody` snippet；`<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="chat-view" data-project="true" …>` + `<ProjectHeader />` + 内容区 `<div class="relative min-h-0 flex-1" data-testid="project-view" data-view={shell.projectView}>`：沟通容器（始终挂载，`class:hidden`）、`{#if view==='settings'}<ProjectSettingsPage/>{:else if view==='wiki' || …}<ModulePlaceholder/>{/if}`。

### 步骤 5：撤右栏与 Bot 详情覆盖层

- **`ChatsArea.svelte`**：`rightCollapsed` 再加一个条件 `|| chat.current?.conversation.type === 'project'`（以及已有的 `chat.composingProject`）；其余不变。
- **`RightPanel.svelte`**：删掉 `isGroup` 分支与 `<GroupInfo>`（它现在只服务单聊）；`isGroup` 变量与相关判断删除；头部的 `browser-show` 等已经按 `!isGroup` 守卫的条件化简。
- **`BotDetailOverlay.svelte`**：自动关闭的条件加上「当前会话是项目组」；`NarrowShell` 里不再为项目组打开 Bot 详情覆盖层（项目组头部没有药丸）。
- `shell.toggleRightPanel` / `rightPanelCollapsed` 保持，只对单聊有意义。

### 步骤 6：侧栏与头像堆叠改名

- `git mv avatars/GroupAvatarStack.svelte avatars/ProjectAvatarStack.svelte`、`avatars/group-avatar-layout.ts avatars/project-avatar-layout.ts`、`avatars/group-avatar-layout.test.ts avatars/project-avatar-layout.test.ts`；导出名（`GROUP_AVATAR_USER_ID` → `PROJECT_AVATAR_USER_ID`、`groupAvatarFaces` / `groupAvatarSlots` → `projectAvatarFaces` / `projectAvatarSlots`）与根节点 testid（`group-avatar-stack` → `project-avatar-stack`）同步；`project-avatar-layout.test.ts` 断言不变。使用处：`AppSidebar.svelte`（`conversationAvatar`）、`MemberAvatar.svelte`（工作台，`kind === 'project'`）。`ChatView` 里的使用已随步骤 3 删除，`GroupInfo.svelte` 里的使用在 WP7 随文件删除（过渡期它 import 新名字）。
- **`AppSidebar.svelte`**：右键菜单项 `context-group-settings`（约 l.1245–1250）→ `context-project-settings`，文案 `t('sidebar.projectDetail')`；点击行为：`await chat.select(conversation.id)` 然后 `shell.openProjectSettings()`（**不再**打开 `GroupSettingsDialog`）。**`SidebarDialogs.svelte`** 里挂载 `GroupSettingsDialog` 的那一块（约 l.73–77）与 `sidebarDialogs.groupSettingsId / openGroupSettings` 状态删除（`GroupSettingsDialog.svelte` 文件本身留到 WP7，设置卡还在用它的 embedded 模式）。
- 侧栏的 `nameOf`（项目标题或 `project.untitled`）、`conversationAvatar` 按 `type === 'project'`（WP1 已改）。

### 步骤 7：i18n

按 §2 的表新增 key；删除已无引用的：`chatHeader.*` 中仅用于群聊药丸的（若存在，用 `rg` 确认无引用再删）、`groupSetup.creatingTitle` 若仍存在（WP1 应已删）。`group.*` 里 `GroupInfo` 仍在用的 key 保留到 WP7。

## 5. 测试

- 单测：`project-tabs.test.ts`（顺序、planned → disabled、labelKey）；`project-chat-badge.test.ts`（步骤 2 的全部口径）；`transcript-visibility.test.ts`（抽出的共享函数：与原 `MessageList` 过滤条件逐条一致）；`shell-project.svelte.test.ts`；`project-avatar-layout.test.ts`（改名，断言不变）。
- 现有测试：`MessageList` 相关单测（若有）因 `topInset` 默认值不变应当仍通过。
- **不写、不改 e2e**（WP8 统一）。本 WP 期间依赖右栏 `group-info` / `context-group-settings` 的 e2e 允许失败。
- **手工冒烟**（写进实施记录）：`pnpm dev`：① 打开一个项目组 → 看到两行顶栏、tab（沟通激活、Wiki 可点、其余灰显）、右侧头像堆叠与 ⚙；② 在沟通里发消息、输入草稿后切到 Wiki 再切回，草稿还在；③ 切到 Wiki 时让另一个 Bot 发一条消息（或模拟）→ 沟通 tab 出现未读徽标，切回后消失；④ 点头像堆叠 → 弹层列出成员（负责人带标）、可搜索并添加成员、点外部与 Esc 关闭；⑤ 点 ⚙ → 内容区出现详情过渡页（旧 GroupInfo 全部功能仍可用，包括撤销授权），⚙ 呈选中；再点任一 tab 返回；⑥ 项目组下右栏不出现、`right-panel-toggle` 不存在；单聊的药丸与右栏照旧；⑦ 窄屏：返回按钮、tab 横向滚动、头像堆叠与 ⚙ 可用；⑧ 侧栏右键「项目详情」直接进入该项目组并打开详情页。

## 6. 验证

```bash
pnpm --filter @kepcup/desktop typecheck && pnpm lint
node scripts/run-tests.mjs run --project desktop
```

## 7. 验收清单

- [ ] 项目组：实心两行顶栏；tab 行读 `PROJECT_MODULES`，planned 灰显不可点；沟通 tab 徽标逻辑正确；⚙ 打开内容区详情过渡页、tab 行无新增项、可返回。
- [ ] 沟通内容在切换视图时**保持挂载**（草稿与滚动位置保留）。
- [ ] 项目组不渲染右栏；`RightPanel` 无群聊分支；`BotDetailOverlay` 不为项目组打开；单聊完全不变。
- [ ] 头像堆叠为重叠式（负责人在前带标记、最多 5 个 + `+N`）；弹层可列成员、搜索添加、点外部 / Esc 关闭。
- [ ] `ProjectAvatarStack` 改名完成；侧栏右键「项目详情」直达详情页；`SidebarDialogs` 不再挂 `GroupSettingsDialog`。
- [ ] 自检：

```bash
rg -n "GroupAvatarStack|group-avatar-layout|group-avatar-stack|context-group-settings|groupSettingsId|openGroupSettings|isGroup" apps/desktop/src -g '!node_modules' -g '!**/dist/**'
```

  应为空。（`GroupInfo` / `GroupSettingsDialog` / `GroupTurnStatusLine` 仍存在是预期：前两者 WP7 删，后者 WP8 改名。）
- [ ] desktop `typecheck` / `lint` / 单测绿；实施记录已填（含过渡壳登记与手工冒烟结果）。

## 8. 陷阱

- **不要用 `{#if}` 卸载沟通内容**：输入框草稿与滚动位置会丢。用 `hidden` 类隐藏。
- **不要复制消息可见性过滤条件**：抽成 `isVisibleInTranscript`，徽标与列表共用，否则两边口径会漂移。
- `MessageList` 的顶部留白改成 prop 后，**单聊的默认值必须保持 56px**，否则单聊会出现布局回归。
- 不要改 `markRead`；未读徽标是「视图层」概念，不影响已读游标。
- bits-ui `DropdownMenu` 不适合放搜索框；成员弹层用自建轻量弹层，并 `stopPropagation` 输入框按键。
- 项目组头部没有药丸，也就没有 `right-panel-toggle`；不要为项目组保留任何右栏开合入口。
- 过渡壳里的 `GroupInfo` 是**临时**的，WP7 会删除它——别在它上面加新功能。
- **名字冲突**：`shell.svelte.ts` 里原来就有一个 `openProjectSettings`（打开 D28 **目录设置**对话框），WP0-2 已把它改名为 `openWorkdirSettings`（连同 `projectSettingsRequest` → `workdirSettingsRequest`）。本 WP 新增的 `openProjectSettings` 是**项目详情页**，二者无关；开工前用 `rg -n "openProjectSettings|openWorkdirSettings" apps/desktop/src` 确认旧的确实已改名，没改就是 WP0-2 漏了，先补上再继续。

## 9. 实施记录

（执行智能体在此填写：分支、提交列表、过渡壳登记、手工冒烟结果、偏差编号。）

**2026-10-18 · 直接在集成分支 `feat/project/migration` 上开发（调度方指定，本 WP 无并行项）。**

### 提交列表（自 `f385f61` 起）

| 提交 | 内容 |
|---|---|
| `406c962` | feat(desktop): shell 的 `ProjectView`/`projectSettingsSection` 状态与 `openProjectModule`/`openProjectSettings`、`chat.select()`/`leaveCurrent()` 重置；`transcript-visibility.ts`（MessageList 过滤抽取为 `isVisibleInTranscript`）；`project-tabs.ts` / `project-chat-badge.ts` 纯逻辑；单测 `shell-project.svelte.test.ts`(6)、`transcript-visibility.test.ts`(7)、`project-chat-badge.test.ts`(6)、`project-tabs.test.ts`(4) |
| `51c6d53` | refactor(desktop)!: 纯改名 `GroupAvatarStack → ProjectAvatarStack`、`group-avatar-layout → project-avatar-layout`（含 `GROUP_AVATAR_USER_ID → PROJECT_AVATAR_USER_ID`、`groupAvatarFaces/Slots → projectAvatarFaces/Slots`、接口 `GroupAvatarSlot → ProjectAvatarSlot`、根 testid `group-avatar-stack → project-avatar-stack`），`git mv` + 消费端机械同步（AppSidebar 仅取改名 hunk；ChatView 在该提交里只做最小机械摘除头像堆叠用法，snippet 重构留给下一提交）。独立提交、单提交 typecheck 通过 |
| `6c7ee28` | feat(desktop): 项目组外壳——ChatView `chatBody` snippet 一份两渲染、MessageList `topInset` prop（单聊默认 56px 不变）、`features/project/` 六组件（ProjectView/Header/Tabs/MembersMenu/ModulePlaceholder/ProjectSettingsPage）、ChatsArea 项目组不渲染右栏、RightPanel 删群聊分支、BotDetailOverlay 项目组自动收起、侧栏右键「项目详情」直达、SidebarDialogs 摘除 GroupSettingsDialog、设置卡 `project-detail` 深链改走 `shell.openProjectSettings(section)`、i18n 增删 |
| （本提交） | docs(todo): 本实施记录 + README §7 进度行 |

### 过渡壳登记（WP7 替换 / 接手项）

- `apps/desktop/src/renderer/src/lib/features/project/ProjectSettingsPage.svelte` 是**过渡壳**（文件头有 `// Transitional shell` 注释）：正文直接渲染旧 `GroupInfo.svelte`（改名、成员、授权撤销、工作目录、定时/监看都可用），顶部一行 `project.header.settings` 小标题。**WP7 整体替换**，别在 GroupInfo 上加新功能。
- `GroupInfo.svelte` / `GroupSettingsDialog.svelte` 仍在（设置卡 embedded 模式还在用后者；右栏与 SidebarDialogs 已不再挂它们），WP7 删除。
- 设置卡 `project-detail` 深链：`deep-link.ts` 的 action 增加了 `section`（校验 ∈ `PROJECT_DETAIL_SECTIONS`，不认识退 `'overview'`），`open-deep-link.ts` 改为「必要时 `chat.select` → `shell.openProjectSettings(section)`」。`anchor` 已随 action 传到但过渡壳未消费——**WP7 在真实详情页里消费 anchor**（`project-settings-nav-<section>` / `data-settings-anchor`）。判断依据：WP6 §4 步骤 6 删除 `sidebarDialogs.openGroupSettings` 后该调用点无法编译，而 deep-link.ts 原注释即指向 `shell.openProjectSettings`，属完成 WP6 自检（`openGroupSettings` 零残留）的必经改写，不是行为分歧。
- `projectSettingsSection` 状态与 `project-settings-nav-<section>` 等 testid 本 WP 只落状态与深链，分区导航 UI 由 WP7 画。

### §4 未列出的新名字登记

- 接口 `ProjectAvatarSlot`（原 `GroupAvatarSlot`，随文件改名按相邻风格取）。
- testid：`project-members-manage`（弹层底部「管理成员…」按钮）、`project-member-option-<botId>`（弹层添加区候选行）。§4.12 已列的 `project-member-row-<botId>` 在顶栏弹层与详情页（WP7）各在自己的容器内使用。
- `chatTabBadge` 的 approvals 参数口径：徽标场景传空表（`isVisibleInTranscript(message)` 缺省 `{}`）——待审批的回执卡由琥珀色 pending 圆点提示，不计入未读数（WP 固定了 `chatTabBadge` 入参形状，无审批快照可传）。
- `ProjectHeader` 内私有常量 `STACK_MAX = 5`（头像堆叠最多画 5 个 + `+N`）。
- 纯逻辑文件间用相对导入（`../chats/transcript-visibility`）：纯逻辑单测跑在 desktop 项目（无 `$lib` 别名），与 `chat.svelte.ts` 的既有混用风格一致。

### 手工冒烟（§5 ①–⑧，全部实际驱动）

方式：一次性 Playwright `_electron` spec（临时放 `apps/desktop/test/e2e/wp6-smoke.tmp.spec.ts`，驱动 `pnpm build` 产物 + mock LLM + RPC 测试缝，**跑完即删、未提交**）。结果 8/8 通过（6.5s）：

1. ① 双轮创建项目组后看到实心两行顶栏：沟通 tab 激活（`data-active`）、Wiki 可点、board/OKR/日历 `disabled` + `data-disabled="true"`；右侧头像堆叠与 ⚙ 存在；根节点 `chat-view[data-project="true"]`。
2. ② 输入草稿「草稿保留验证」→ 切 Wiki（`project-module-placeholder[data-module="wiki"]` 出现，`composer-dock` 仍 attached）→ 切回：草稿文本还在（contenteditable 未卸载）。
3. ③ 停在 Wiki 视图，经 RPC `messages.send` 发 `@研究员`（mock LLM 回真实 Bot 消息）→ 沟通 tab 出现 `project-tab-badge-chat[data-kind="unread"]`；切回沟通后徽标消失。
4. ④ 成员弹层：三行成员、负责人行带「负责人」徽标；搜索「测试官」点候选成功入列（`conversation.updated` 自动刷新）；Esc 关闭、再次打开后点弹层外部关闭。
5. ⑤ ⚙ → 内容区出现 `project-settings-page` + 旧 `group-info`（改名生效同步到 `project-title`、授权区在）；⚙ `aria-pressed="true"`；点沟通 tab 返回。
6. ⑥ 项目组下 `right-panel` / `right-panel-toggle` 均不存在；打开单聊：药丸在、右栏可开合（`right-panel` 出现后可 `right-panel-hide` 收起）。
7. ⑦ 窗口缩到 420px：项目组头部有返回按钮（复用 `narrow-back-button`）、tab 行 `scrollWidth > clientWidth`（横向可滚动）、堆叠与 ⚙ 可用、详情页可往返。
8. ⑧ 恢复 1280px 后侧栏右键 → `context-project-settings` → 选中该项目组且内容区直接是详情页（`project-view[data-view="settings"]`）。

未自动化的部分：头像堆叠的视觉重叠（`-space-x-2` + ring）与负责人冠标样式、`+N` 计数（本组 4 人未溢出）——代码走查确认类名与 WP §4 步骤 4 一致；`MessageList` 的 `topInset` 默认 56px 由单测与既有单聊布局回归（desktop 单测全绿 + ⑥ 单聊核对）覆盖。

### 测试与验证

- `pnpm --filter @kepcup/desktop typecheck`：0 errors / 0 warnings；`pnpm lint`：通过。
- `node scripts/run-tests.mjs run --project desktop`：85 文件 792 例全绿（新增 WP6 单测 23 例含在其中；含改名的 `project-avatar-layout.test.ts` 19 例中的一部分与 `deep-link.test.ts` 更新）。
- §7 自检 `rg -n "GroupAvatarStack|group-avatar-layout|group-avatar-stack|context-group-settings|groupSettingsId|openGroupSettings|isGroup" apps/desktop/src`：空。
- 未跑全量 `pnpm test`（WP6 收口不要求）；未写未改 e2e（WP8 统一，旧 group-* e2e 允许失败）。

### 偏差

无新增 DEVIATIONS（编号未推进，仍停在 DEV-034）。唯一超出 WP 字面的改动是设置卡 `project-detail` 深链的落地方式（见上文「过渡壳登记」第 3 条），属 WP6 自检要求的必然后果，方向与 deep-link.ts 原注释一致。

### 遗留（顺延）

- WP7：真实项目详情页（替换 GroupInfo 过渡壳与 GroupSettingsDialog 的 embedded 模式）、`ProjectMembersEditor`、分区导航 `project-settings-nav-<section>`、深链 anchor 消费、删 Bot 阻止 UI。
- WP8：`GroupTurnStatusLine` → `ProjectTurnStatusLine` 改名、`group-*` e2e 重写为 `project-*`、文案收尾。
- WP10：Wiki tab 的真实视图（本 WP 为 `ModulePlaceholder` 的 `wikiSoon`）。
