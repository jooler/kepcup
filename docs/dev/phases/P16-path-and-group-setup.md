# P16 对话工作路径与群创建

设计依据：[design/19-work-path-and-group-setup.md](../../design/19-work-path-and-group-setup.md)（D59、D60）、[design/08-project.md](../../design/08-project.md)。

依赖：P04（project 绑定）、P05（群聊）、P15（对话式新建与对话内引导的既有范式）。

## 目标

1. 把「对话 = 工作路径」的既有绑定模型在创建时刻引导落地：新建 Bot 访谈在首问作答后、任何 LLM 调用前插入「工作目录」一问；新建群在对话内问答中收集目录。
2. 群创建从弹框改为对话内四问（名称、主要事务、成员、目录），零模型调用；群定位落 `conversations.description` 并注入群聊上下文。

## 范围

### shared

- `conversationSchema` 增 `description: string | null` 与 `setupState: 'creating' | null`（可省略，兼容旧视图）。
- 常量：`BOT_SETUP_PATH_QUESTION_EVENT = 'bot_setup_path_question'`、`GROUP_SETUP_QUESTION_EVENT = 'group_setup_question'`、群 setup 步骤类型（`'title' | 'purpose' | 'members' | 'project'`）。
- RPC：
  - `bots.interview.answerPath`：`{ conversationId, path: string | null }` → `{ message }`。目录卡作答（含跳过）。
  - `groups.setup.start`：`{}` → `{ conversation }`。创建创建中的群并下发第一问。
  - `groups.setup.answer`：`{ conversationId, step, value }`（按 step 判别：title/purpose 文本、members botIds、project path|null）→ `{ conversation, done }`。
  - `groups.setup.cancel`：`{ conversationId }` → `{ ok }`。级联删除。

### core

- 迁移 `0014_conversation_setup.sql`：`conversations` 增 `description TEXT`、`setup_state TEXT`。
- `conversations.ts`：行映射新列；`setDescription`；`setSetupState`。
- `groups.ts`：`createSetup()`（type='group'、`setup_state='creating'`、无成员）；`finalizeSetup(conversationId, { title, description })`（清 setup_state，事务内）；`addMembers` 复用于成员步（不作 ≥2 校验，校验在步骤层）。
- `messages.ts`：`userMessagesAfter(conversationId, seq)`（status != 'recalled'、sender_type='user'、seq 递增）。
- `orchestrator.ts`：
  - 访谈目录闸门 `#gateDirectDelivery(conv, botId, messages, reason)`：bot 在访谈中且首问卡已存在时，若目录卡不存在→插入（确定性文案，无候选）；若目录卡未答→不投递。三个直聊投递点全部过闸：`answerSetupQuestion`、`flushDrafts`（单聊分支）、`editMessage`（单聊分支）。
  - `answerSetupPath(conversationId, path | null)`：校验闸门确实关闭（目录卡存在且未答）；path 非空 → `projects.select` 绑定；落 `setupAnswer` 用户消息（path 或「暂不设置工作目录」）；收集首问卡之后的全部用户消息一次性投递 mailbox（reason 'direct'）。
  - 群 setup 流程：`beginGroupSetup()`、`answerGroupSetup()`（步骤推进、下一问卡片、成员步写成员行、project 步绑定后 finalize + 完成系统消息）、卡片幂等（按「已答步骤数」推导下一步，不信任重复调用）。
  - 删除 `groups.create` RPC？——不删：保持 core 能力完整（无 UI 入口），文档标注。
- `system-prompt.ts`：`<conversation_info>` 群聊增「本群主要处理：…」；`<setup_interview>` 增目录问题已由界面处理的声明。

### renderer

- 新 `SetupPathCard.svelte`（访谈目录卡：选择目录… / 暂不设置 / 已答态）与 `GroupSetupCard.svelte`（四步形态：文本输入 ×2、成员多选、目录选择；未答卡带「取消创建」）。
- `MessageBubble` 按事件路由两张新卡；`MessageList.chainKey` 访谈目录卡同 `bot_setup_question` 参与连排。
- `ChatView`：`setupState === 'creating'` 的群禁用 Composer 与 ProjectSelector；标题回退「新建群聊…」。
- `AppSidebar`：「新建群聊」入口改调 `groups.setup.start` 并进入该对话；移除 `NewGroupDialog`；创建中的群右键菜单不出现「群设置」。
- `chat.svelte.ts`：`createGroupViaSetup` / `answerGroupSetup` / `cancelGroupSetup` / `answerSetupPath`。
- i18n `zh-CN`：setupPath.*、groupSetup.* 文案。

### 测试

- core 集成（新 `test/integration/setup-gate.test.ts` 或并入 response-loop）：
  - 首问作答后：无 run、目录卡出现；`answerPath(null)` 后缓冲消息投递、run 开始、上下文含首答；`answerPath(path)` 后 project 绑定 + run 开始。
  - 闸门期间自由输入（flushDrafts）不触发 run，`answerPath` 后一并投递。
  - 群 setup：start → 4 步作答 → title/description/成员行/project 绑定/setup_state 清空、完成系统消息、零 run；cancel → 对话物理删除。
- e2e：`bot-setup.spec.ts` 首答后先出现目录卡（选「暂不设置」路径与选目录路径各留一例或选一）；`group-chat.spec.ts` 的 `createGroupViaUi` 改为对话内四问；`browser.spec.ts`、`memory.spec.ts` 同步该 helper。

## 不包含

- 群创建完成后改名 / 成员管理 / 换绑目录的新交互（走既有入口）。
- Bot 访谈其余问题（仍由 LLM `ask_question` 驱动）。
- 单聊创建时的强制目录（「暂不设置」是一等出口）。
- 群 `description` 的编辑 UI（后续按需）。

## 验收标准

1. 全新环境对话式新建 Bot：点选首问候选后**没有** LLM run，目录卡立即出现；选目录（e2e 用临时目录）后 run 开始，Bot 绑定目录可见（ProjectSelector 显示所选目录名）；选「暂不设置」则不绑定且访谈照常继续。
2. 目录卡未答期间从输入框发送的消息不触发 run；作答后该消息与首答一起被 Bot 处理。
3. 新建群全程无任何模型调用（mock LLM 无脚本访问记录），完成后群名、事务描述、成员、目录与设计一致；`<conversation_info>` 含「本群主要处理：…」。
4. 创建中刷新 / 重启后问答可继续；「取消创建」后对话从列表消失且 messages 表无残留行。
5. 旧弹框入口不再出现；`pnpm test` 全绿；desktop build + svelte-check 与基线一致。
