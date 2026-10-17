# WP5 · 双轮创建（先选负责人，再选成员）

> 依赖：WP1 已合入（`projects.create`、`PROJECT_*` 常量、`projectTitleFromMemberNames`）。可与 core 链（WP2–WP4）、WP9 并行；**WP6 必须等它**（二者都改 `ChatView` / `ChatsArea` / `NarrowShell` / `AppSidebar`）。分支：`feat/project/wp5-ui-create`。
> 先读 [README.md](README.md) §1、§4.11（store 契约）、§4.12（testid）；设计依据 [41 §11.1](../../docs/design/41-project-team.md)。

## 1. 目标与范围

把「新建群聊」的顶部成员输入条（`GroupComposeBar`）改造成**双轮**选择：

```text
第一轮 · 负责人（单选）
┌ 负责人 ▸ [ 输入名字筛选…                                  ] ✕┐
│  候选列表（不含管家）                                          │   点选 / Enter = 选定并进入第二轮
└ 输入新名字回车 = 新建一个 Bot 并作为负责人（空画像也能当）        ┘

第二轮 · 成员（多选）
┌ [👑 研究员 ✕]  成员 ▸ [写作助手 ✕] [ 输入名字筛选…          ] ✕┐
│  候选列表（不含负责人、不含管家）                              │   Ctrl/⌘+1~9 选前 9 个
└ 空回车：已选 ≥ 1 位成员即创建；Backspace（输入空、无成员时）退回第一轮；Esc 取消
```

做：`project-compose.ts` 纯逻辑与单测、`ProjectComposeBar.svelte`、`chat.svelte.ts` 的 compose 状态与方法、侧栏入口、`composingGroup → composingProject` 的全部引用、i18n。
不做：e2e（WP8 统一）；顶栏 / tab / 详情页（WP6、WP7）；右栏（WP6）。**WP1 留下的临时负责人（`composeMemberIds[0]`）在本 WP 删除。**

## 2. 固定契约

- store（`stores/chat.svelte.ts`）：`composingProject: boolean`、`composePhase: 'lead' | 'members'`、`composeLeadId: string | null`、`composeMemberIds: string[]`（**不含**负责人）；方法 `beginProjectCompose()`、`cancelProjectCompose()`、`selectComposeLead(botId)`、`backToLeadPhase()`、`addComposeMember(botId)`、`removeComposeMember(botId)`、`commitProjectCompose(): Promise<boolean>`。
- `project-compose.ts` 导出：`ComposeCandidate`、`ComposePhase`、`ComposeState`、`composePool`、`composeCandidates`、`composeEnterAction`、`ComposeEnterAction`、`stepHighlight`、`composeSelectLead`、`composeBackToLead`、`composeAddMember`、`composeRemoveMember`。
- testid：见 README §4.12「创建」一组；入口 `start-chat-create-project`。
- RPC：`projects.create`（入参 `{ title, leadBotId, memberBotIds }`，`memberBotIds` 含负责人）。

## 3. 开工前核对

```bash
rg -n "composingGroup|beginGroupCompose|cancelGroupCompose|commitGroupCompose|composeMemberIds|GroupComposeBar|group-compose" apps/desktop -g '!node_modules' -g '!**/dist/**'
rg -n "WP5 replaces" apps/desktop/src          # WP1 留下的临时负责人处，必须在本 WP 消除
```

必读：`features/chats/group-compose.ts` 与 `group-compose.test.ts`、`GroupComposeBar.svelte`（253 行，全文）、`stores/chat.svelte.ts`（`beginGroupCompose` 附近约 l.415–470，以及 `select()` 里对 `cancelGroupCompose` 的调用约 l.322）、`features/sidebar/AppSidebar.svelte`（`openCreateGroup`、`start-chat-create-group`，约 l.242 与 l.1109）、`ChatView.svelte`（`group-compose-view` 分支约 l.88–95）、`ChatsArea.svelte`、`features/shell/NarrowShell.svelte`（`showDetail`）、`features/bot-setup`（`createNamedBot`）。

## 4. 步骤

### 步骤 1：纯逻辑 `features/chats/project-compose.ts`（`git mv` 自 `group-compose.ts` 后改写）

保留的行为：候选按名字（不区分大小写）包含过滤、保持通讯录顺序；方向键高亮 `-1 ↔ 0…n-1` 不回绕；回车的优先级（方向键选中 > 输入同名 > 新建 > 空回车）。新增 / 改动：

```ts
export interface ComposeCandidate { id: string; name: string }
export type ComposePhase = 'lead' | 'members';
export interface ComposeState { phase: ComposePhase; leadId: string | null; memberIds: string[] }

/** 候选池：通讯录去掉管家（管家不进项目组）。bots 需带 systemRole。 */
export function composePool<T extends ComposeCandidate & { systemRole?: string | null }>(bots: readonly T[]): T[];

/** 候选：lead 阶段只排除管家（已在池里）；members 阶段还要排除负责人与已选成员。 */
export function composeCandidates<T extends ComposeCandidate>(bots: readonly T[], excludedIds: readonly string[], query: string): T[];

export type ComposeEnterAction =
  | { kind: 'selectLead'; botId: string }          // lead 阶段：选已有 Bot 为负责人
  | { kind: 'add'; botId: string }                 // members 阶段：加入已有 Bot
  | { kind: 'alreadySelected'; botId: string }     // members 阶段：输入名恰为负责人或已选成员 → 不新建重名 Bot
  | { kind: 'create'; name: string }               // 新建 Bot（lead 阶段成为负责人；members 阶段成为成员）
  | { kind: 'commit' }                             // members 阶段空回车且已有 ≥ 1 位成员
  | { kind: 'needLead' }                           // lead 阶段空回车
  | { kind: 'needMembers' };                       // members 阶段空回车且成员数为 0

export function composeEnterAction(input: {
  phase: ComposePhase;
  query: string;
  bots: readonly ComposeCandidate[];               // 候选池（已去管家）
  leadId: string | null;
  memberIds: readonly string[];
  candidates: readonly ComposeCandidate[];         // 当前阶段的候选列表
  highlight: number;
}): ComposeEnterAction;
```

回车规则：
- **lead 阶段**：`highlight ≥ 0` → `selectLead`（高亮项）；有输入 → 池里名字完全相同（去首尾空白、不区分大小写）的 Bot → `selectLead`，否则 `create`；空输入 → `needLead`。
- **members 阶段**：同旧逻辑，但「已选」= `memberIds ∪ {leadId}`；空输入时，`memberIds` 里**仍在池中**的成员数 ≥ 1 → `commit`，否则 `needMembers`。（总人数 = 负责人 + 成员 ≥ 2，与 `projects.create` 的约束一致。）

状态转换纯函数（store 调用，便于单测；都返回**新状态**，不就地修改）：
- `composeSelectLead(state, botId)`：`leadId = botId`、`phase = 'members'`，并把 `botId` 从 `memberIds` 里移除（选了一个已在成员里的 Bot 当负责人）；
- `composeBackToLead(state)`：`leadId = null`、`phase = 'lead'`，`memberIds` 保留；
- `composeAddMember(state, botId)`：已是负责人或已是成员则原样返回；
- `composeRemoveMember(state, botId)`。

**单测** `project-compose.test.ts`（由 `group-compose.test.ts` 改名改写，保留原有断言的精神）：候选过滤（含排除负责人）；`composePool` 去管家；lead 阶段四种回车（高亮 / 同名 / 新建 / 空）；members 阶段（高亮 / 同名 / 同名已是负责人 → `alreadySelected` / 同名已选成员 → `alreadySelected` / 新建 / 空回车 0 成员 `needMembers`、1 成员含已删除 Bot 仍 `needMembers`、1 个有效成员 `commit`）；四个状态转换（含「选已在成员里的 Bot 当负责人会把它从成员移除」「退回第一轮保留成员」）；`stepHighlight` 原用例。

### 步骤 2：store `stores/chat.svelte.ts`

- 状态与方法按 §2 命名；`composeMemberIds` 不含负责人。方法用步骤 1 的纯函数实现。
- `beginProjectCompose()`：`shell.mainView = 'chats'`（沿用旧注释：工作台开着时先回对话区）；`composingProject = true`；状态置初值 `{ phase: 'lead', leadId: null, memberIds: [] }`。
- `cancelProjectCompose()`：`composingProject = false`，状态清空。`select()` 内部对原 `cancelGroupCompose()` 的调用改名。
- `commitProjectCompose()`：取通讯录里还在的负责人与成员（过滤掉已删除的 Bot）；负责人缺失或有效成员 < 1 → 返回 `false`；标题 `projectTitleFromMemberNames([负责人名, ...成员名])`；`core.call('projects.create', { title, leadBotId, memberBotIds: [leadId, ...memberIds] })`；成功后 `cancelProjectCompose()`、`refresh()`、`select(result.conversation.id)`，返回 `true`；失败 `toast.error(errorText(errorCode(error), t('project.createFailed')))`，返回 `false`。**删除 WP1 的临时负责人代码与 `// WP5 replaces` 注释。**
- `activeId` 在组群期间为 `null` 的逻辑（约 l.131–136）里的 `composingGroup` → `composingProject`。

### 步骤 3：组件 `features/chats/ProjectComposeBar.svelte`（`git mv` 自 `GroupComposeBar.svelte`）

保留：输入框 combobox 语义、`busy` 只读、`createNamedBot`、方向键高亮、`scrollIntoView`、快捷键 `⌘/Ctrl+1~9`（lead 阶段 = 选第 n 个为负责人；members 阶段 = 加第 n 个）。改动：

1. 根节点 `data-testid="project-compose"`，增 `data-phase={chat.composePhase}`（testid `project-compose-phase` 放在一个包含阶段文字的元素上，见下）。
2. **标签**：输入框前的文字：lead 阶段 `t('projectCompose.leadLabel')`（「负责人」），members 阶段 `t('projectCompose.membersLabel')`（「成员」）；`data-testid="project-compose-phase"`、`data-phase` 同步。
3. **芯片**：members 阶段最前面先显示**负责人芯片**（`data-testid="project-compose-lead-chip"`，头像 + 名字 + `Crown` 图标（`@lucide/svelte`）+「负责人」徽标）；它的 ✕ 调 `chat.backToLeadPhase()`（`aria-label` 用 `projectCompose.backToLead`）。其后是成员芯片 `project-compose-chip-<botId>`，✕ `project-compose-remove-<botId>`。lead 阶段不显示成员芯片行（成员保留在状态里，退回第二轮时再显示）。
4. **候选列表**：`filtered = composeCandidates(pool, excludedIds, query)`，其中 `pool = composePool(contacts.bots)`；lead 阶段 `excludedIds = []`，members 阶段 `excludedIds = [leadId, ...memberIds]`。选项 testid `project-compose-option-<botId>`，菜单 `project-compose-menu`，输入 `project-compose-input`，取消按钮 `project-compose-cancel`，提示 `project-compose-hint`。
5. **回车分发**（`onEnter`）：按 `composeEnterAction` 的七种结果：`selectLead` → `chat.selectComposeLead(id)`，清空输入与提示；`add` → `chat.addComposeMember(id)`；`alreadySelected` → 清输入并提示 `projectCompose.alreadyAdded`；`create` → `createNamedBot(name)` 成功后按**当前阶段**决定是 `selectComposeLead` 还是 `addComposeMember`；`needLead` → 提示 `projectCompose.needLead`；`needMembers` → 提示 `projectCompose.needMembers`；`commit` → `chat.commitProjectCompose()`。
6. **按键**：`Esc` → `chat.cancelProjectCompose()`；`Backspace` 且输入为空：members 阶段有成员 → 删最后一位成员；members 阶段**没有成员** → `chat.backToLeadPhase()`；lead 阶段无动作。
7. 输入框 `placeholder`：lead 阶段 `projectCompose.leadPlaceholder`，members 阶段 `projectCompose.membersPlaceholder`；`aria-label` 沿用 `projectCompose.inputLabel`。
8. 阶段切换后输入框重新聚焦、`highlight = -1`、`query = ''`、`hint = ''`。

### 步骤 4：入口与引用

- `AppSidebar.svelte`：`openCreateGroup` → `openCreateProject`（调 `chat.beginProjectCompose()`）；菜单项 `data-testid="start-chat-create-project"`，文案 `sidebar.createProject`。
- `ChatView.svelte`（约 l.88–95）、`ChatsArea.svelte`（`rightCollapsed` 的 `chat.composingGroup`）、`NarrowShell.svelte`（`showDetail`）、以及 `rg` 出的其余引用：`composingGroup` → `composingProject`；`<GroupComposeBar />` → `<ProjectComposeBar />`；组群视图根节点 testid `group-compose-view` → `project-compose-view`。
- `GlobalSearchDialog.svelte` 等不涉及创建的地方不动。

### 步骤 5：i18n（`lib/i18n/locales/zh-CN.ts`，原样使用下表文案）

| key | 文案 |
|---|---|
| `sidebar.createProject` | 新建项目组 |
| `project.createFailed` | 创建项目组失败 |
| `projectCompose.to` | To: |
| `projectCompose.leadLabel` | 负责人 |
| `projectCompose.membersLabel` | 成员 |
| `projectCompose.leadPlaceholder` | 输入名字筛选，或新建一位负责人 |
| `projectCompose.membersPlaceholder` | 添加项目成员 |
| `projectCompose.emptyList` | 没有可选的 Bot，输入名字回车即可新建 |
| `projectCompose.needLead` | 请先选择项目负责人 |
| `projectCompose.needMembers` | 至少再添加 1 位成员 |
| `projectCompose.alreadyAdded` | {name} 已经选过了 |
| `projectCompose.remove` | 移除 {name} |
| `projectCompose.backToLead` | 重新选择负责人 |
| `projectCompose.leadBadge` | 负责人 |
| `projectCompose.cancel` | 取消创建 |
| `projectCompose.inputLabel` | 选择项目组的负责人与成员 |
| `projectCompose.listLabel` | 候选 Bot |

删除：`sidebar.createGroup`、`group.createFailed`、`groupCompose.*` 全部（`MessageKey` 类型检查会指出遗漏）。其余 `group.*` / `groupSetup.*` key 不在本 WP 处理（WP1 已删 `groupSetup.*`；`group.*` 归 WP6 / WP7 / WP8）。

## 5. 测试

- 单测：`project-compose.test.ts`（步骤 1）；`node scripts/run-tests.mjs run --project desktop` 全绿。
- **不写、不改 e2e**（`group-compose.spec.ts` 与 `helpers/create-group.ts` 在 WP8 统一重写）。本 WP 期间这两个 e2e 允许失败。
- 手工冒烟（记录在实施记录里，不是验收硬指标但必须做）：`pnpm dev` → 「+」→「新建项目组」→ 第一轮点选负责人 → 第二轮点选成员 → 空回车建出项目组并进入；再试：第一轮输入新名字回车建负责人；第二轮 Backspace 退回第一轮；Esc 取消；窄屏（拉窄窗口）下同样可用；候选里没有管家。

## 6. 验证

```bash
pnpm --filter @kepcup/desktop typecheck && pnpm lint
node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/chats/project-compose.test.ts
node scripts/run-tests.mjs run --project desktop
```

## 7. 验收清单

- [ ] 自检为空：

```bash
rg -n "composingGroup|beginGroupCompose|cancelGroupCompose|commitGroupCompose|GroupComposeBar|group-compose|groupCompose\.|sidebar\.createGroup|start-chat-create-group|WP5 replaces" apps/desktop -g '!node_modules' -g '!**/dist/**' -g '!test/**'
```

- [ ] 创建需要负责人 + ≥ 1 位成员；`projects.create` 的 `memberBotIds` 含负责人；标题默认「负责人、成员…」拼接。
- [ ] 候选池无管家；选已在成员里的 Bot 当负责人会把它从成员移除；Backspace 的三种行为符合 §3 步骤 6。
- [ ] `project-compose.test.ts` 覆盖步骤 1 列的全部场景并通过；desktop `typecheck` / `lint` / 单测绿。
- [ ] 实施记录已填（含手工冒烟结果）。

## 8. 陷阱

- 负责人**不在** `composeMemberIds` 里；提交时才拼成 `[leadId, ...memberIds]`。别把二者混成一个数组，否则 Backspace / 排除候选的逻辑会出错。
- 「新建 Bot 当负责人」走 `createNamedBot`（与旧版新建成员同一函数），建出的是画像为空的 Bot——它能当负责人，因为负责人行为靠项目上下文注入，不依赖 Profile。
- 候选池要先去管家再过滤；不要在 `composeCandidates` 里写管家判断（单测更好写）。
- 不要改 `GroupAvatarStack` / `group-avatar-layout`（WP6 统一改名）；不要动 e2e。

## 9. 实施记录

（执行智能体在此填写：分支、提交列表、手工冒烟、偏差编号。）
