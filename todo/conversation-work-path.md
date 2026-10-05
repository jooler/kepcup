# 对话工作路径与群创建（D59/D60）：创建期引导路径、群创建对话化

> 状态：**已实现并验收（2026-10-04）**。设计见 `docs/design/19-work-path-and-group-setup.md`（D59、D60），阶段文档见 `docs/dev/phases/P16-path-and-group-setup.md`。改动清单见第 5 节（全部勾销），验收记录见 `docs/dev/PROGRESS.md` 对应小节。

## 1. 背景与目标

工作路径（project）的绑定单位是对话：单聊按 Bot 天然一一对应；群拉起来就是为了一个共同事务，一个群一个路径，群内所有 Bot 共享读写（写租约串行化、读不受限）——这是 P04 起的既有模型，本次不动模型，补两块：

1. **创建期引导**：新建 Bot 与新建群时，「选择工作目录」作为创建流程的固定一步，而不是等用户自己发现 ProjectSelector。
2. **群创建对话化**：弹框改对话内四问（名称、主要事务、成员、目录），数据只进群记录、零模型调用；群的「主要处理什么事务」补为 `conversations.description` 并注入群聊上下文。

## 2. 现状追溯（链路结论）

- 绑定：`conversations.project_id` 单列；`projects.select`（ProjectRuntime.select）绑定 + 系统消息；`boundProject(conversationId)` 被 orchestrator / gateway / sandbox 策略统一消费——**所有群内 Bot 天然共享**，无需逐 Bot 授权。
- 并发：写租约按目录全局串行（`LeaseService`），读不受限——用户设想的「避免同文件被多 Bot 同时处理（允许同时读）」已实现。
- Bot 访谈：`bots.interview.start` 确定性下发问候 + 固定首问卡（`bot_setup_question` + options）；`bots.interview.answer` → `answerSetupQuestion` 落 `setupAnswer` 消息**并立刻投递 mailbox** 触发响应 run；后续问题由 LLM `ask_question` 工具出卡，`SETUP_MAX_QUESTIONS=5` 封顶。
- 群创建：`NewGroupDialog` 弹框（名称 + 成员多选 ≥2）→ `groups.create`；群无「事务」字段，Bot 只见 title 与成员名片。
- 直聊投递点共 3 处：`answerSetupQuestion`、`flushDrafts`（单聊分支）、`editMessage`（单聊分支）——目录闸门需覆盖全部。
- e2e 依赖旧弹框：`group-chat.spec.ts`（createGroupViaUi）、`browser.spec.ts`、`memory.spec.ts`。

## 3. 方案设计

### 3.1 Bot 访谈目录闸门（D59）

- 闸门条件（纯消息流推导，重启天然恢复）：`bot.setupState === 'interviewing'` 且首问卡已存在；此时目录卡不存在→插入（事件 `bot_setup_path_question`，固定文案，无候选），未作答→不投递。
- 三个直聊投递点统一过 `#gateDirectDelivery`。
- `bots.interview.answerPath`：path 非空 → `projects.select` 绑定（复用「项目已绑定为…」系统消息）；落 `setupAnswer` 用户消息（path 或「暂不设置工作目录」）；收集首问卡之后全部用户消息一次性投递（`messages.userMessagesAfter`）。
- `<setup_interview>` 提示词声明目录已由界面处理，不再过问。

### 3.2 群创建对话化（D60）

- `conversations.setup_state='creating'` + `description`（迁移 0014）；`groups.setup.start/answer/cancel` 三 RPC；卡片事件 `group_setup_question`，content 带 `step`。
- 步骤推进按「已答步骤数」推导（幂等，不信任重复调用）；成员步作答即写 `conversation_members` 行（防中断丢失）；project 步绑定后 finalize（写 title/description、清 setup_state、完成系统消息）。
- 创建中：Composer/ProjectSelector 禁用、右键无「群设置」、侧栏占位名；每张未答卡带「取消创建」→ 对话级联删除。全程零模型调用（完成前无成员触发、完成后不自动触发）。
- `<conversation_info>` 群聊增「本群主要处理：…」。

## 4. 非目标

- 群 `description` 的编辑 UI；群创建后的改名/成员管理交互变化（走既有「群设置」）。
- Bot 访谈其余问题的确定性化（仍由 LLM 驱动）。
- 强制所有对话绑定目录（「暂不设置」是一等出口）。

## 5. 改动清单（2026-10-04 实现完成）

- [x] shared：`conversationSchema.description/setupState`；常量 `BOT_SETUP_PATH_QUESTION_EVENT`、`GROUP_SETUP_QUESTION_EVENT`、`GROUP_SETUP_STEPS`；system_event content 增 `step`
- [x] shared RPC：`bots.interview.answerPath`、`groups.setup.start/answer/cancel`（schema + 方法名注册）
- [x] core 迁移 `0014_conversation_setup.sql`
- [x] core `conversations.ts`（新列映射、setSetupState）、`groups.ts`（createSetup/finalizeSetup）、`messages.ts`（userMessagesAfter、systemEventSeq、step 透传）
- [x] core `orchestrator.ts`：`#setupPathGateClosed` + `#deliverDirectThroughGate`（answerSetupQuestion / flushDrafts / editMessage 三投递点）、`answerSetupPath`、`beginGroupSetup/answerGroupSetup`；start.ts 群服务前置构造（显式标注打断推断环）
- [x] core `system-prompt.ts`：conversation_info 群描述、setup_interview 目录声明
- [x] renderer：`SetupPathCard.svelte`、`GroupSetupCard.svelte`（新）；MessageBubble/MessageList 路由；ChatView creating 群与目录闸禁用 Composer、隐藏 ProjectSelector；AppSidebar 入口替换、删 NewGroupDialog 与旧 createGroup；chat store 四方法；i18n `chats.setupPath*`、`groupSetup.*`
- [x] 测试：新集成 `setup-path-gate.test.ts` 8 例；bot-setup 集成 9 例补 skipSetupPath；public-skills-migration 夹具补摘 0014 列；e2e bot-setup / setup-card / group-chat / browser / memory 更新
- [x] 文档：design 19（新）+ README 索引与 D59/D60 + 08/01 增量；dev P16（新）+ README 阶段表 + 03-data-model + PROGRESS

## 6. 验收口径（2026-10-04 全部通过）

1. ✅ 全新环境对话式新建 Bot：点选首问候选后无 LLM run、目录卡立即出现；选「暂不设置」后缓冲消息合并投递、访谈继续（e2e bot-setup / setup-card + 集成）；选目录路径绑定 project 且 `<project>` 段进入首个 run（集成）。
2. ✅ 目录卡未答期间的消息（含自由输入）不触发 run，作答后一并投递（集成 + UI 闸内禁输入）。
3. ✅ 新建群全程零模型调用（集成断言 mock-main 零请求），完成后群名/描述/成员/目录与设计一致；`<conversation_info>` 含「本群主要处理：…」（集成 + e2e group-chat）。
4. ✅ 创建中断后问答按已答步骤续推（步骤状态由消息流推导）；「取消创建」后对话物理删除、messages 无残留（集成）。
5. ✅ 旧弹框入口不再出现（NewGroupDialog 已删）；`pnpm test` 103 文件 818 passed + 2 skipped 零失败；desktop build + svelte-check（0 error）+ eslint 干净；受影响 e2e（bot-setup、setup-card、group-chat、memory、browser、projects、onboarding）全绿。

## 7. 风险与注意

- 闸门必须覆盖 `editMessage` 的直聊重触发分支，否则编辑消息会绕过目录闸。
- `answerSetupPath` 的投递批含多条历史缓冲消息：一次 run 多触发消息是既有语义（flush 批同型）。
- 群创建卡片与成员写入非同一事务：步骤推进以「已答步骤数」推导，重复 RPC 幂等。
- e2e 的 mock LLM 对无脚本请求 fail loudly——群创建全程零模型调用恰好可断言「无脚本也不失败」。
