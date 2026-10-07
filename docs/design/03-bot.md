# 03 Bot 的构成

Bot 就像一个真人：

- **Profile**：它是谁（由用户定义）
- **记忆**：它记得谁、记得发生过什么
- **Wiki**：它懂什么（它的大脑）
- **Skills**：它会做什么（它的工具）

| 组成 | 作用 | 写入者 | 范围 |
|---|---|---|---|
| Profile | 身份、人格、职责、边界、运行配置 | 用户 | 每个 Bot 一份 |
| 自己的记忆 | 与用户的关系、承诺、经验教训 | 该 Bot 的后台 loop | 每个 Bot 私有 |
| 用户画像（共享记忆） | 用户是谁、有什么偏好 | 全局唯一的画像整理 loop | 所有 Bot 可读 |
| Wiki | 领域知识 | 该 Bot 的 Wiki 维护 loop | 每个 Bot 私有 |
| Skills | 做事的方法 | 技能市场（公共，所有 Bot 可用）、该 Bot 的技能生成 loop 或用户 git 导入（私有） | 公共 / 每个 Bot 私有 |
| Workspace | 某个对话中的草稿区 | 该对话的响应 loop | 按“Bot + 对话” |

核心原则：**每类数据只有一个写入者，响应 loop 基本只读，写入交给后台的独立 loop。**

## 三类长期存储的边界

- **记忆记“人和事”**：用户是谁、我们约定过什么、我做错过什么。
- **Wiki 记“世界是怎样的”**：概念、资料、领域知识。
- **Skill 记“事情怎么做”**：可重复执行的流程。

示例：

- “用户是后端工程师，偏好 Go” → 用户画像
- “Go 的泛型怎么用” → Wiki
- “给这个用户写周报的固定流程” → Skill

## Profile

```yaml
identity:    { name, avatar, bio }            # bio 用于群成员名单和群聊判断
persona:     { personality, tone, style, values, sample_dialogues }
role:        { expertise, responsibilities }  # 群聊判断“归不归我”主要依据
boundaries:  [不做的事]
behavior:    { proactive: true, quiet_hours, max_proactive_per_day }
runtime:     { model, light_model, network_policy, budget,
               agent: { id, model, effort, permission, capabilities } }   # 模型配置见 14-models-and-browser.md；agent.id 为空=内置引擎，否则为外部智能体，见 28-external-agents-acp.md
```

- Profile 由用户掌控，Bot 不能修改自己的核心人格，防止人格漂移。
- Bot 对自己的新认识写入自己记忆中的“自我笔记”。
- Bot 可以提出 Profile 修改建议，以消息形式请用户确认。
- 其他 Bot 只能看到名片：`name`、`bio`、职责。

## 生命周期

### 管家（Butler，D70）

- 系统角色 `system_role='butler'`：全局唯一、通讯录置顶、**不可删除**（与下方「删除 Bot」流程互斥）。
- 负责组队提议、意图路由与跨 Bot 委派入口；细节见 [27-butler-and-delegation.md](27-butler-and-delegation.md)。
- Profile 内 `role.{expertise,responsibilities}` 仍是人设字段，与 `system_role` 不是同一列。

### Bot id

- 每个 Bot 拥有全局唯一的 id，**删除后永不复用**。
- 删除后保留一条仅含 id 与删除时间的记录，用于在历史消息中显示发送者，并占用该 id。
- 新建的 Bot 即使与已删除的 Bot 同名，也是新的 id，不继承任何数据。

### 删除 Bot 时的数据处理

删除前弹框提醒，列出将被清理的内容并说明不可恢复。交互表现见 [01-conversation.md](01-conversation.md#删除-bot)。

清理：

- Profile（仅保留 id 记录）
- 私有记忆
- Wiki
- Skills：自建技能全部删除；导入技能的引用移除，技能库中不再被任何 Bot 或公共技能（public_skills）引用的版本可被回收（公共技能不随单个 Bot 删除）
- 所有 workspace 与后台 loop 工作目录
- 浏览器会话数据
- 该 Bot 的执行记录

保留：

- 对话中的消息与附件（属于对话）
- 它为共享用户画像贡献的条目（这些是关于用户的事实，证据来自用户本人的消息）
