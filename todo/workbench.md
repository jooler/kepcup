# 工作台（Workbench）：左栏入口 + 待办 / 备忘

> 状态：**待评审**（2026-10-15；Pengfei 口述需求，实现前先定稿）。
> 决策编号待分配（合入前以 `docs/design/README.md` 实况为准）。
> **本期只出方案，不写 UI / 不落库**；评审通过后再开编码。
> 早期阶段：不做向后兼容、不迁旧数据；以当前代码逻辑正确为准。

## 1. 目标

给用户一个**不进 Bot 对话**也能总览与管理「定时待办」和「个人备忘」的工作台：

1. **入口**：左栏管家 Bot **上方**新增「工作台」条目；点击后**中间主体换成工作台视图**，不打开任何对话、不选中任何 Bot。
2. **待办**：按 Bot 分行展示其定时任务（卡片）；可从工作台给指定 Bot **新增**单次 / 周期任务；无任务的 Bot 不出现。
3. **备忘**：用户纯文本备忘卡片，基础增删改 + 顶部关键字筛选。

原则：复用现有 schedules 执行链路（到点唤醒 Bot、回执卡、护栏）；工作台是**管理面**，不是第二套调度引擎。备忘与对话内「辅助阅读便签」（stickies）职责分开。

## 2. 现状追溯（2026-10-15 读代码）

| 区域 | 位置 | 结论 |
| ---- | ---- | ---- |
| 左栏 / 管家 | `features/sidebar/AppSidebar.svelte`、`butler.ts` | 管家私聊（`systemRole === 'butler'`）固定列表最前、不进分组；点击 = `chat.select(conversationId)` 打开对话 |
| 主区视图 | `stores/shell.svelte.ts` 注释：「主界面只有对话一个视图」；`App.svelte` → `ChatsArea` → `ChatView` | **没有**第二主视图切换；设置 / 扩展中心是弹框，不是换中间栏 |
| 窄屏 | `NarrowShell` + 底部 tab（对话 / 通讯录 / 扩展 / 我） | 工作台入口与窄屏信息架构需单独定（见 §7） |
| 定时任务模型 | `schedules` 表（`0011` + `0022 title/origin`）；`ScheduleService` | `botId` + `conversationId` 绑定；`kind: once \| cron`；`origin ∈ {tool,offer,proposal,commitment}`；到点经 orchestrator 投递 |
| 定时 RPC | `schedules.list` / `cancel` / `acceptOffer` / `declineOffer` | **没有**用户侧 `schedules.create`；创建只走 Bot 工具 / 提议卡 / 管家 routines / 承诺联动 |
| 列表 UI | `right-panel/SchedulesPanel.svelte`（私聊右栏 / 群信息 / **设置页总览**） | 已有全局 list + 人话时间 + 两步取消 + `schedules.changed`；**无按 Bot 分行、无新建表单** |
| when 解析 | `schedule/when.ts` + `createFromWhen` | ISO → 单次，其它 → cron；工具 / 提议 / 例行共用 |
| 私聊解析 | `conversations.openDirect(botId)` | 幂等拿到该 Bot 的私聊；工作台挂任务应默认挂这里（见 §3.3） |
| 辅助阅读便签 | `stickies`（选中文本钉出、浮在对话上） | **不是**备忘；带 conversation / position / z；勿复用表或 RPC |
| 备忘 | — | **不存在**独立备忘模型 / UI |

## 3. 产品形态

### 3.1 入口与导航

```
左栏（示意）
┌─────────────────┐
│ [+] 新建 …      │
│ 🔍 搜索         │
│ ★ 工作台  ← NEW │  ← 管家之上；选中态高亮，不像对话行
│ ─────────────── │
│ 管家            │
│ （分组 / 其它对话）│
└─────────────────┘
```

- 点击「工作台」：`shell.mainView = 'workbench'`；**不**调用 `chat.select`；可选清掉当前对话选中高亮（或保留侧栏选中但主区仍显示工作台——推荐**清掉对话选中**，避免「以为还在某 Bot」）。
- 点击任意对话行：`shell.mainView = 'chats'`，恢复现有行为。
- 工作台打开时右栏：默认不展示 Bot 详情（无当前对话）；窄屏另议。
- 图标：建议用 `LayoutDashboard` / `Briefcase` 一类，与对话头像行区分；文案 i18n `sidebar.workbench` =「工作台」。

### 3.2 工作台主体

中间栏整页替换 `ChatsArea`：

```
┌─ 工作台 ─────────────────────────────┐
│  [ 待办 ]  [ 备忘 ]                   │  ← tabs
│                                       │
│  （tab 内容，见下）                    │
└───────────────────────────────────────┘
```

状态：`shell.workbenchTab: 'todos' | 'memos'`（默认 `todos`）。

### 3.3 待办 tab

**布局（自上而下）**

1. Tab 条下方、列表上方：**「+」**按钮。
2. 点击「+」→ 下拉（或 Popover）列出可选 Bot（已创建、非只读；是否含管家见 §7 Q2）→ 选中后展开**新建卡片表单**（可插在列表顶或该 Bot 行内）。
3. 列表：每个**至少有一条 active 定时任务**的 Bot 一行：
   - 行头：头像 + 名称（可点：跳转该 Bot 私聊，并 `mainView='chats'`——可选，见 Q3）。
   - 行内：该 Bot 的任务卡片横排 / 流式排布（复用 `describeScheduleWhen` + `scheduleDisplayTitle`）。
4. **无 active 任务的 Bot 不渲染**（含管家、空 Bot）。
5. 空态：尚无任何定时任务 → 插画 / 文案「还没有待办」+ 引导点「+」。

**新建表单字段（P0）**

| 字段 | 说明 |
| ---- | ---- |
| 任务内容 | 映射 `note`（到点给 Bot 看的指令）；必填 |
| 标题 | 可选；映射 `title`（展示短名）；空则展示回退 note 截断 |
| 类型 | 单次 / 周期性 |
| 单次时间 | 本地日期时间 → ISO（带用户时区） |
| 周期 | P0 给常见预设（每天 / 工作日 / 每周某天 / 每月某日 + 时刻）→ 生成 5 段 cron；高级「自定义 cron」可放 P1 |
| 时区 | 默认用户本地；一般不展示 |

确认 → RPC 创建 → 列表按 `schedules.changed` 刷新；失败 toast。

**挂载约定（推荐，待确认 Q1）**

- 工作台创建的任务一律挂到该 Bot 的**私聊**（`conversations.openDirect(botId)`，必要时隐式创建空私聊）。
- `origin` 新增 `'user'`（用户在工作台 / 未来 UI 手建），与 tool/offer/proposal/commitment 区分；回执卡仍写入该私聊时间线（与现有一致），用户从聊天里也能看见。
- **不**在 P0 支持「挂到某个群聊」——群场景继续用群内对话 / 右栏。

**行内交互（UX 澄清，对应口述「点击后该 Bot 就增加…」）**

| 操作 | 行为（推荐） |
| ---- | ------------ |
| 全局「+」 | 选 Bot → 打开该 Bot 的新建表单 |
| 行头旁小「+」或点行头空白 | 直接打开**该 Bot** 的新建表单（少一步选 Bot） |
| 点已有任务卡片 | P0：展开只读详情（人话时间、note、取消）；P1：就地编辑 when/note |
| 取消 | 两步确认，复用 `schedules.cancel` |

口述里「点击后该 Bot 就增加一个定时任务」按上表拆成「点行 → 出表单 → 确认才创建」，避免误触立即落库。

**与设置页 / 右栏的关系**

- 设置里的「定时任务」总览、右栏 `SchedulesPanel` **保留**（对话上下文管理仍有用）。
- 工作台是**按 Bot 分行 + 可新建**的主入口；设置页可在文案上加「也可在工作台管理」（P1）。

### 3.4 备忘 tab

与 stickies **分开**：备忘 = 用户个人纯文本笔记，**不**绑对话、**不**浮在消息上、**不**进 Bot 上下文（P0；若以后要「Bot 可读备忘」另开决策）。

**布局**

1. 顶部：关键字筛选输入框（本地过滤 title/body；量小不必 FTS）。
2. 「+」新建 → 卡片编辑态（或弹层）。
3. 卡片网格 / 列表：标题（可选）+ 正文预览 + 更新时间；点开编辑；删除两步确认。

**空态 / 筛选无结果** 分别文案。

## 4. 数据与 RPC

### 4.1 定时：扩展现有 schedules

**迁移（示例号：下一空号，写时取 main 最新 +1；本文起草时 main 最新 `0036`）**

- `scheduleOriginSchema` / DB CHECK 增加 `'user'`。
- 早期阶段可直接改 CHECK（重建约束）；不必双写兼容。

**新 RPC**

```
schedules.create
  input: {
    botId: string
    note: string           // 任务内容
    title?: string
    when: string           // ISO 或 cron（与 createFromWhen 同口径）
    timezone?: string | null
    // P0 不传 conversationId：服务端 openDirect(botId)
  }
  output: { schedule: Schedule }  // 或 ScheduleEntry
```

实现：`ScheduleService.createFromWhen({ origin: 'user', conversationId: openDirect(...).id, ... })`；沿用护栏 / 回执卡 / `schedules.changed`。

**list**：现有 `schedules.list{}` 已够工作台；渲染层按 `botId` group。若需头像 URL 等，可继续用 `botName` + 本地 bots store；不足再扩 `ScheduleEntry`（P1）。

**cancel**：现有即可。

**权限**：桌面端仅本机用户；create/cancel 不经 Bot 审批。Bot 关闭主动消息时：创建仍允许，但 list 的 `deferredReason` / 创建返回护栏提示要可见（复用 `fireabilityWarnings`）。

### 4.2 备忘：新表 `memos`

```sql
CREATE TABLE memos (
  id TEXT PRIMARY KEY,          -- memo_
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,            -- 纯文本；上限建议 8_000～20_000 字
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX memos_updated_at ON memos(updated_at DESC);
```

**RPC**

| 方法 | 说明 |
| ---- | ---- |
| `memos.list` | 全量（按 `updated_at` desc）；P0 无分页 |
| `memos.create` | `{ title?, body }` → memo |
| `memos.update` | `{ id, title?, body? }` |
| `memos.delete` | `{ id }` |

事件（可选 P0）：`memos.changed`；单窗可先靠 RPC 回写刷新。

**非目标（备忘）**：Markdown 渲染、附件、标签、加密、同步云端、注入 Bot 上下文、与 stickies 合并。

## 5. UI / 模块结构（建议）

```
apps/desktop/src/renderer/src/lib/features/workbench/
  WorkbenchView.svelte          # tabs + 出口
  WorkbenchTodos.svelte         # +、Bot 行、表单
  WorkbenchMemos.svelte
  BotScheduleRow.svelte
  ScheduleCreateForm.svelte     # 单次 / 周期控件
  MemoCard.svelte
  workbench.svelte.ts           # 列表缓存、筛选、表单草稿（可选）
```

改动锚点：

- `shell.svelte.ts`：`mainView`、`workbenchTab`、`openWorkbench()`；`resetForLayoutChange` 时复位策略写清。
- `App.svelte` / `NarrowShell.svelte`：`mainView==='workbench'` 时渲染 `WorkbenchView` 替代 `ChatsArea`。
- `AppSidebar.svelte`：管家块**之上**插入工作台 MenuItem（折叠态只有图标）；`data-testid="workbench-nav"`。
- i18n：`sidebar.workbench`、`workbench.*`。
- e2e：新建工作台用例（入口切换、创建单次任务出现在对应 Bot 行、无任务 Bot 不显示、备忘 CRUD + 筛选）。

## 6. 实施阶段

### P0 — 壳 + 待办只读/新建/取消（建议先做）

- [ ] 设计落点：`docs/design/` 一小节或本 todo 定稿 + README 决策号
- [ ] `shell.mainView` + 左栏入口 + 中间区切换（宽屏）
- [ ] `schedules.create`（origin=`user`）+ origin 迁移 / schema
- [ ] 工作台待办：按 Bot 分组列表、全局 +、行内 +、新建表单（预设周期）、取消、空态
- [ ] 订阅 `schedules.changed`
- [ ] 单测：create 挂私聊、非法 when、护栏提示；renderer 分组纯函数
- [ ] e2e：入口 → 建单次 → 列表可见 → 取消

### P1 — 备忘 + 窄屏 + 体验

- [ ] `memos` 表 + CRUD RPC + 备忘 tab UI（筛选 / 增删改）
- [ ] 窄屏入口（见 Q4）
- [ ] 任务卡片点进私聊并定位 / 打开右栏定时页签
- [ ] 周期「自定义 cron」；可选就地编辑
- [ ] 设置页定时总览文案指向工作台

### P2 — 可选增强（本期不排期）

- [ ] 待办按「下次触发」全局时间线视图（打通 Bot 维度）
- [ ] 备忘 Markdown / 置顶 / 颜色
- [ ] 工作台内看到 watches（借用）摘要
- [ ] Bot 只读引用备忘（需单独隐私决策）

## 7. 待你确认的问题（⚠）

1. **Q1 任务挂载对话**：是否同意 P0 **一律挂该 Bot 私聊**（`openDirect`）？若某 Bot 只有群、无私聊，是否允许工作台隐式建空私聊？（推荐：允许。）
2. **Q2 管家是否可被选为任务归属？** 推荐：可以（管家也有 schedules）；列表无任务时管家行仍隐藏。
3. **Q3 点 Bot 行头**：跳转私聊，还是仅展开/折叠该行任务？推荐：行头点击 = 跳转私聊；折叠用行头旁 chevron。
4. **Q4 窄屏**：底部 tab 加「工作台」，还是仅在「对话」列表顶插入入口、点进详情层式全屏工作台？推荐：列表顶入口 + 全屏工作台（少改 tab 信息架构）。
5. **Q5 设置页「定时任务」总览**：保留 / 改为跳转工作台 / P1 再藏。推荐：P0 保留。
6. **Q6 创建后是否在私聊插入回执卡**：与现网 `origin=tool/offer/...` 一致出卡，还是 `user` 静默（只出现在工作台）？推荐：**出卡**（时间线可审计）；若嫌吵可改为静默。
7. **Q7 备忘是否需要标题字段**：正文必填 + 标题可选，还是仅正文？推荐：标题可选。
8. **Q8 「点击卡片区域增加任务」**：是否接受「点行头旁 + / 全局 + → 表单 → 确认」而不要「点一下立刻建空任务」？

## 8. 非目标（本期）

- 不在工作台里聊天、改 Bot 人设、管 Skills / MCP。
- 不重做调度引擎、不改到点投递语义。
- 不把 stickies 改造成备忘。
- 不做多用户 / 云同步备忘。
- 不在 P0 做群聊归属选择、不在 P0 做任务编辑（只建 + 取消）。

## 9. 风险与注意

- **主视图分叉**：`shell` 今日假定「唯一主视图 = 对话」；所有 `openSchedules` / 深链 / 窄屏返回要验收「从工作台点对话能回去」。
- **隐式 openDirect**：可能突然在侧栏冒出空私聊——可接受，或创建任务时若无私聊先 toast 确认（产品偏好）。
- **Electron PATH / 热更**：与本功能无关；改 shell 时注意宽窄 `resetForLayoutChange`。
- **origin CHECK**：SQLite 改 CHECK 往往要重建表；早期阶段可直接新迁移重建 `schedules`（数据可清空策略需你点头——或只 ADD 新约束能接受的写法）。
- **测试纪律**：改 shared 契约后定向 `schedule-*` / 新 memos 单测；收尾再全量。

## 10. 验收口径（定稿后实施时用）

1. 左栏管家上方可见「工作台」；点击后中间为工作台，侧栏无对话选中（或按 Q3 定稿），URL/状态可回到对话。
2. 待办：仅显示有 active 任务的 Bot；+ 选 Bot 后可建单次与周期；任务出现在该 Bot 行；取消后行可消失。
3. 任务实际挂在该 Bot 私聊，到点行为与现有定时一致（可用现有 schedule 集成测试路径抽验）。
4. 备忘：增删改 + 关键字筛选可用；与对话 stickies 互不影响。
5. 相关单测 / e2e 绿；typecheck 干净。

---

**下一步**：请过一遍 §7 问题并点头或改口径；通过后按 P0 → P1 编码，并把结论回写 `docs/design/` + 决策表。
