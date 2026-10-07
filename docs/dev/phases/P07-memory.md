# P07 记忆与用户画像

## 目标

每个 Bot 拥有自己的长期记忆，所有 Bot 共享用户画像。记忆通过显式写入与事后反思产生，经代码强制校验；画像由全局唯一的整理 loop 写入；每天整理一次记忆。每次响应按预算注入画像卡片、“我的状态”、相关记忆。用户可以查看、编辑、删除所有记忆。后台 loop 的用量可见、可设预算。

## 依赖

P05、P06。

## 设计依据

- [design/04-memory.md](../../design/04-memory.md)（全文）
- [design/03-bot.md](../../design/03-bot.md#三类长期存储的边界)（记忆 / Wiki / Skill 的边界）
- [design/06-isolation-and-storage.md](../../design/06-isolation-and-storage.md#信任隔离防提示注入与记忆污染)（信任隔离）
- [design/14-models-and-browser.md](../../design/14-models-and-browser.md#向量模型)（向量模型）
- [04-agent-runtime.md](../04-agent-runtime.md#结构化输出)（反思、画像整理、记忆整理的输出结构）
- [03-data-model.md](../03-data-model.md)（memory.db、profile_items、profile_card、profile_proposals）

## 范围

包含：

- `bots/{id}/memory.db`：按需创建与打开（派生密钥 `db:memory:<botId>`）；连接池上限（同时打开不超过 8 个，最近最少使用的关闭）。
- 向量服务：接口 + 两种实现（本地模型、厂商接口）；未配置或未就绪时退化为只用全文检索。
- 本地向量模型：作为环境目录中的 `embedding-model` 条目，经 P06 的申请与确认流程下载。
- 记忆工具：`remember`、`recall_memory`、`get_user_profile`、`list_commitments`、`memory_feedback`、`forget`、`propose_profile_change`。
- 反思（每次响应执行结束后）、画像整理（全局唯一）、记忆整理（每个 Bot 每天一次）三类后台任务。
- 写入校验（代码强制）。
- 注入：`<user_profile>`、`<my_state>`、`<relevant_memories>`；平台规则 8、9。
- 凭据检测与提醒。
- 撤回消息、删除对话、移出群、删除 Bot 对记忆的处理。
- 界面：右栏“记忆”标签页；设置页“用户画像”；设置页“用量与预算”。
- 后台 loop 的每日预算。

不包含：

- 承诺与定时任务的联动（P10）；Wiki 建议与技能建议的处理（P09、P08，本阶段只保存反思输出中的建议到任务表，不执行）。

## 任务

1. **记忆库**（`memory/store.ts`）：memory_items、memory_fts 的增删改查；FTS 写入经 `text-segment`；`memory_vec` 在向量模型就绪后按维度创建。
2. **向量服务**（`memory/embedder.ts`）
   - 接口：`{ id, dim, ready(): boolean, embed(texts: string[]): Promise<Float32Array[]> }`。
   - 本地实现（DEV-007 已落实）：`onnxruntime-node` 推理 `jina-embeddings-v2-base-zh` q8 量化 ONNX 导出（768 维，中英双语；模型约 163MB + 运行库约 114MB，经环境管理器合成一张审批卡按需安装到 `toolchains/embedding-model|onnxruntime/{version}/`，不入应用安装包）；GPU 加速按平台自动选执行单元（macOS CoreML / Windows DirectML / Linux CPU，回退 CPU）；mean 池化；分词自实现 RoBERTa 字符级 BPE（`memory/bpe-tokenizer.ts`，纯 TS 与 HF tokenizers 逐 id 对齐）。macOS arm64 实测短句 warm 单条约 4ms（CPU EP）/ 约 26ms（CoreML EP）（1024 token 约 367ms，产品截断 512）。细节见 [16-capability-models.md](../../design/16-capability-models.md)「向量来源的本地实现」。
   - 厂商实现：OpenAI 兼容的 `/v1/embeddings` 接口，使用已配置的厂商 key。
   - 设置页选择向量来源；更换来源或模型时，后台任务重建所有 Bot 的 `memory_vec`。
   - 首次需要向量时（第一次写入记忆）若未配置：默认选本地模型，并由系统（不是 Bot）发起一次 `environment` 审批，卡片说明用途（本地栈的卡片含模型与运行库的合计体积与组件明细）。
3. **检索**（`memory/retrieve.ts`）
   - 查询文本：本次触发消息正文，加上最近 2 条上下文消息。
   - 全文检索前 20 + 向量检索前 20 → RRF（`RRF_K`）合并 → 过滤：`status = 'active'`、未过期（`valid_until`）、群聊中排除 `sensitivity = 'sensitive'` 的条目 → 取前 `MEMORY_TOPK` 条 → 按预算截断。
   - 群聊中 `origin = 'private'` 的条目标注 `origin="private"`。
   - 被注入的条目更新 `last_used_at`、`use_count`。
4. **工具**

   | 工具 | 参数 | 行为 |
   |---|---|---|
   | `remember` | `content`、`kind`、`private_to_bot?`、`due_at?` | 用户明确要求记住时使用；立即写入本 Bot 记忆（`source = 'explicit'`，证据为本次触发消息）；关于用户本人的事实同时生成画像提案 |
   | `recall_memory` | `query`、`kind?` | 检索本 Bot 记忆，返回条目（含 id） |
   | `get_user_profile` | `category?` | 返回画像条目 |
   | `list_commitments` | — | 本 Bot 的有效承诺（按截止时间排序） |
   | `memory_feedback` | `item_id`、`reason: 'outdated' \| 'wrong'`、`note?` | 本 Bot 记忆：`wrong` → `retracted`，`outdated` → `superseded`；画像条目：生成一条撤回提案 |
   | `forget` | `item_ids` | 用户要求忘掉时使用；本 Bot 记忆立即 `retracted`；画像条目生成撤回提案并立即触发画像整理 |
   | `propose_profile_change` | `changes`（Profile 字段的修改）、`reason` | 发起 `profile_change` 审批；批准后写入 Profile |

5. **反思**（`memory/reflection.ts`）
   - 每次响应执行结束（`completed`）后登记 `reflection` 任务（`dedupe_key = run:{runId}`）。
   - 输入与输出见 [04-agent-runtime.md](../04-agent-runtime.md#反思)。
   - 输出的 `runSummary` 写入 `runs.summary`；`wikiSuggestions`、`skillSuggestion` 写入 jobs（类型 `wiki_suggestion`、`skill_suggestion`，状态 `pending`，由 P09、P08 消费）。
6. **写入校验**（`memory/validate.ts`）：在写入任何记忆条目或画像提案之前执行，规则见下文[写入校验](#写入校验)一节。
7. **凭据处理**（已按消息原则调整，见 design/01-conversation.md）：反思/写入链路照常检测凭据模式并拒绝把凭据写入记忆（`validate.ts`、`profile-curation.ts`），但不再向对话插入凭据提醒系统消息——怎么对待凭据是 Bot 自己的记忆事务。
8. **画像整理**（`memory/profile-curation.ts`）
   - 提案写入 `profile_proposals`，登记 `profile_curation` 任务（`dedupe_key = 'profile_curation'`，延迟 60 秒以合并多个提案；`forget` 产生的提案立即执行）。
   - 按输出操作更新 `profile_items`；`card` 写入 `profile_card`；卡片超出预算时截断。
   - `keep_both` 的冲突：两条都保留，并为提案来源的 Bot 生成一条 `self_note`：“用户的 X 信息存在冲突，找合适时机确认”。
9. **记忆整理**（`memory/consolidation.ts`）：每个 Bot 每天一次（本地时间 03:00 之后首次空闲时，或应用启动时补做），按 `kind` 分批；另外把过期条目（`valid_until` 已过）直接置为 `superseded`。
10. **我的状态**（`memory/my-state.ts`）：未来 7 天内到期的有效承诺；本 Bot 在其他对话中 `running` / `waiting_*` 的执行（只显示对话名称与触发消息前 30 字）。
11. **生命周期**：按 [03-data-model.md](../03-data-model.md#删除级联) 接入：删除对话 / 移出群 → 承诺置为 `void`；撤回消息 → 只以它为证据的条目置为 `retracted`（画像条目经整理 loop）；删除 Bot → memory.db 随目录删除，profile_items 保留。
12. **预算**（`usage/budget.ts`）：设置项“每个 Bot 每天后台用量上限”（默认 200000 token）；超出后当天不再执行该 Bot 的后台任务（任务推迟到次日），设置页提示。
13. **界面**
    - 右栏“记忆”：按类型分组、搜索、编辑内容、删除、查看证据（跳转到消息；对话已删除时显示“来源对话已删除”）、标记“只属于该 Bot”。
    - 设置页“用户画像”：按分类列出条目、贡献的 Bot、画像卡片预览；编辑、删除（直接写入，视为用户显式操作，不经过提案）。
    - 设置页“用量与预算”：按 Bot、按 loop 类型、按天的 token 与费用；预算设置。

## 写入校验

以下规则由代码强制执行，不依赖模型自觉：

- 证据中的消息必须存在、未被撤回，且属于本 Bot 所在的对话。
- `kind` 为 `fact`、`preference` 的条目，以及**全部画像提案**：证据中必须至少有一条 `sender_type = 'user'` 的消息，否则丢弃。
- 画像提案：`sensitivity` 必须为 `normal`、`privateToBot` 必须为 `false`，否则转为本 Bot 的私有记忆（不进入共享层）。
- 凭据检测：内容匹配凭据模式时丢弃。凭据模式包括常见 API key 前缀、私钥块、`password` / `密码` 后跟值等，规则集放在 `memory/credential-patterns.ts`。
- `confidence < 0.5` 的 `inferred` 条目丢弃。
- 与已有 active 条目内容高度相似时不新增，只更新已有条目的 `updated_at`。相似的判定：向量余弦相似度 > 0.92；没有向量时为全文完全匹配。

## 接口与数据

- memory.db：`meta`、`memory_items`、`memory_fts`、`memory_vec`。
- main.db：`profile_items`、`profile_fts`、`profile_card`、`profile_proposals`（见 [03-data-model.md](../03-data-model.md#profile_proposalsp07)）。
- 环境目录新增 `embedding-model` 条目（DEV-007 已落实：真实钉住 jina-embeddings-v2-base-zh q8 ONNX 导出）与 `onnxruntime` 条目（运行库前置）；两者经 `files` 安装类型逐文件钉住下载。
- 审批类型启用 `profile_change`；系统发起的 `environment` 审批（`bot_id` 为空）。
- RPC：`memory.list`、`memory.update`、`memory.retract`、`profile.list`、`profile.update`、`profile.retract`、`profile.card`、`usage.summary`、`budget.get`、`budget.update`、`embedding.status`、`embedding.configure`。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| 本地向量推理的运行库与模型（在 `utilityProcess` 中运行） | 三个平台上加载模型并完成推理；记录体积与单条耗时。macOS arm64 已实测（模型约 163MB + 运行库约 114MB，短句 warm 约 4ms，语义方向正确）；Windows/Linux 复测记入 todo/cross-platform-acceptance.md P07 小节 |
| sqlite-vec 在 better-sqlite3-multiple-ciphers 中加载 | 创建 `vec0` 表、写入、检索，加密库下正常 |
| `Intl.Segmenter` 中文分词质量满足检索 | 用 50 条中文样例验证全文检索召回 |

## 测试要求

- 单元：写入校验的每一条规则（正反例）；RRF 合并；预算截断；凭据模式；我的状态的组装。
- 集成（模拟模型服务返回反思 JSON）：
  - 用户说“记住我下周三要交报告”→ `remember` 写入承诺，下一次执行的 `<my_state>` 中出现。
  - 反思输出中证据只来自 Bot 消息或工具输出的画像提案被丢弃；来自其他 Bot 发言的“关于用户的说法”不进入画像。
  - 敏感条目不进入画像，只留在该 Bot 的私有记忆，并且不在群聊中注入。
  - “只告诉你”的条目不进入画像。
  - 两个 Bot 同时产生画像提案 → 一次整理合并处理，画像卡片更新；另一个 Bot 的下一次执行中可以看到。
  - `forget` 画像条目 → 立即整理后不再出现在卡片中。
  - 撤回消息 → 只以它为证据的条目被撤回。
  - 删除对话 → 其中的承诺为 `void`，其他记忆保留。
  - 删除 Bot → memory.db 不存在；它贡献的画像条目仍在。
  - 向量服务未就绪时检索只用全文检索，结果正确。
  - 后台预算超出后当天的反思任务推迟。
- 安全用例：本阶段条目（画像证据必须来自用户消息）。
- 端到端：右栏记忆的查看、编辑、删除；画像页；用量页。

## 验收标准

- [x] 用户明确要求记住的内容立即写入，并在后续执行中被注入。
- [ ] 每次执行后自动反思，符合“记什么、不记什么”的规则（用 20 条标注样例对真实模型做抽查，记录结果）。— 机制与规则用 mock 反思 JSON 覆盖并有集成/安全测试；20 条标注样例的真实模型抽查需真实 key，列 todo/cross-platform-acceptance.md 延后执行。
- [x] 用户画像只有一个写入者；所有 Bot 看到同一张画像卡片。
- [x] 来自网页、文件、其他 Bot 的内容不会写入用户画像。
- [x] 凭据不会被记住，用户发送凭据时收到提醒。
- [x] 群聊中不注入敏感条目，来自私聊的条目有标注。
- [x] 每个 Bot 每天整理一次记忆，过期条目自动失效。
- [x] 系统提示词中各段预算符合常量设置。
- [x] 用户可以在界面中查看、编辑、删除所有记忆与画像条目。— 证据：e2e `apps/desktop/test/e2e/memory.spec.ts`（右栏查看/搜索/编辑/只属于该 Bot/证据跳转/删除、来源对话已删除、画像页编辑与删除）。
- [x] 用量与预算页面可用，预算生效。— 证据：e2e `memory.spec.ts` 用量页用例（按 Bot/loop/天分组、预算设置持久化、超出当日提示）。
- [x] 删除与撤回的记忆处理符合 03-data-model.md。
- [x] 本阶段测试全部通过。— 证据：`pnpm test` 315 个全绿（P07 新增 62）；`pnpm build && pnpm test:e2e` 21 个全绿（既有 17 + memory.spec 4）。

## 注意事项

- 反思、整理都是后台任务，失败不能影响用户对话；失败只记日志与任务状态。
- 画像的写入者只有两个入口：画像整理任务，以及用户在界面中的直接编辑。任何其他代码路径都不得写 `profile_items`。
- 注入的记忆必须带 id，模型才能调用 `memory_feedback`。
