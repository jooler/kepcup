# Bot 自我进化实施规划（对照 Agent 自我进化调研）

> 写于 2026-10-23。状态：**已实施**（T1–T5 落地，2026-10-23；设计文档已回写为 D97–D101；2026-10-24 经一轮审查修正，见下；修正后全量 `pnpm test` 通过：570 文件 / 6166 用例，core typecheck 与 eslint 干净）。
>
> 实施偏差（均按本稿自己的验收要求裁定）：
> - T1 的 `evidenceRefs`：TypeBox 里是必填数组（引导模型），zod 里是 `default([])`，**都不做 `min(2)` 硬约束**——schema 硬卡条数会让证据不足的建议炸掉整轮反思的结构化输出（与 §3.2-2「不报错、不打断反思结算」矛盾；缺字段则解析为 `[]`，由入队闸丢弃）。
> - T4 的「未启用态」落在既有状态 `disabled`（而非 draft）：draft 语义是「生成失败、草稿保留」，验证通过的技能用 `disabled` + statusReason「反思生成，待你启用」恰好复用面板现成的「启用」按钮；新增 `SkillsService.parkAuthored`（active 行 no-op——反思改进已启用技能时维持启用，与失败路径同一取向）。
>
> **2026-10-24 审查修正**（初版实现与本稿意图的四处偏离，均已改回）：
> 1. **T1 门槛名不副实**：初版入队闸只数 `evidenceRefs.length`——编造的 id、重复的 id、同一 run 的「用户消息 + Bot 消息」都能凑够 2 条，而注释 / TypeBox 描述却声称「按不同 run 解析」。改为 `resolveEvidenceRuns`：每条引用必须解析成该 Bot 的**已完成** turn / task run（run id 直接解析；Bot 消息经产出它的 run；用户消息经它触发的 run），按**不同 run** 计数；证据 run 列表（`evidenceRunIds`）随作业载荷落库便于追溯。单测补了重复 / 同 run / 编造 / 他人 / 失败 run / 他人私有条目 / 引用数上限；集成测试改为引用两个真实的更早的 run。原单测「schema 要求 evidenceRefs」其实是因缺 `profileProposals` 而假失败，已重写。
> 2. **T2 主动提议条款只留在对话轮**：初版把条款同时写进任务版和外部智能体版。这两处用户不在场，`propose_profile_change` 在任务里会**阻塞到用户决定**，叠加 T3（无人值守也不自动批准）会把任务挂在等待审批上；还白白给每次任务多带约 130 token。现只留在对话轮版（非阻塞提交、用户在场）；任务版 / ACP 版回到被动措辞，只保留 T5 的记忆时效一句。`context-assembly.test.ts` 加了回归断言。
> 3. **T4 不新增 `source` 判别字段**：初版在 shared 加了 `skillAuthoringSourceSchema` / `skillAuthoringPayloadSchema`（无人校验、「生产者按它定类型」并不成立），且与作业类型是两份真相。作业类型本来就是任务来源（只有反思会入队 `skill_suggestion`，`create_skill` 登记 `skill_authoring`），改为按 `job.type` 分流：shared 零改动，升级前遗留的 `skill_suggestion` 作业也落在安全侧（不自动启用）。
> 4. **文档**：D97 链接路径（`../todo/` → `../../todo/`）、D7「沙箱通过后自动启用并在对话中告知」补修订说明；D97 / D98 / D100 与上述三点对齐。
>
> 来源：[docs/reports/2026-10-23-agent-self-evolution-landscape.md](../docs/reports/2026-10-23-agent-self-evolution-landscape.md)（下称「调研报告」，§9 建议）。
> 结论：调研报告的建议部分**整体成立**，P0 三条的全部代码断言已逐条核实为真（§1）；两条需要细化（T1 的「同类成功」计数方式、T6 的前置依赖），一条按依赖顺延（T6）。本稿把建议收敛为 5 个实施任务（T1–T5）+ 1 个顺延项（T6）+ 1 个可选项（T7），**实施结束后按 §12 回写设计文档**。
> 测试纪律（AGENTS.md）：迭代只跑定向测试；全量 `pnpm test` 只在阶段收口或最终交付前跑一次。改 shared 契约先 `pnpm --filter @kepcup/shared build`。行号按 2026-10-23 的 `v0.2.1` 记录，实施前以当前代码为准。

## 0. 结论速览

| 调研报告建议 | 评估 | 本稿动作 |
|---|---|---|
| P0.1 技能建议的次数用代码算 | **成立**。`SKILL_AUTHOR_REPEAT_THRESHOLD` 确无执行路径读取（§1.1-a），反思提示词也没提次数；「同类」无法纯代码判定 | **T1**：schema 给 `skillSuggestion` 加证据字段，入队代码把引用解析成不同的已完成 run 再计数——次数由代码算，「同类」由模型判断但必须给出可核查的引用 |
| P0.2 人设仍只走卡，但规则允许主动提议 | **成立**。平台规则三处均为被动措辞（§1.1-b）；白名单、`viaTool` 改道都不用动 | **T2**：纯提示词改动，另加防打扰条款（同一话题只提一次）；**只加在对话轮版**（审查修正 2） |
| P0.3 先决定无人值守 | **成立且必须与 T2 同批**。`profile_change` 确不在 `NEVER_AUTO_DECIDED`（§1.1-c）；T2 让卡变多后，「必须用户批准」在无人值守下会变成「静默写」 | **T3**：`profile_change` 进 `NEVER_AUTO_DECIDED`（两个方案里选收紧，不做摘要单列） |
| P1.1 反思产生的技能停在 draft | **成立**。两种来源走同一生成 job，成功即 promote+activate（§1.1-d）；面板已有 enable/disable | **T4**：job payload 加 `source`，reflection 来源验证通过后停在未启用态 |
| P1.2 lesson 带日期和证据，注入时让模型核对 | **成立**。`formatMemoryLine` 只有 `[id | kind] content`（§1.1-e）；evidenceMessageIds 已在 schema | **T5**：只对 `lesson` / `self_note` 加日期 + 证据 id（普通 fact 不加，控 token） |
| P1.3 离线对照挂 mem-bench | **方向成立，但前置未落地**。评测数据集还是草案（未实施），L1/L2 夹具不存在 | **T6 顺延**：等评测草案立项时并入，本稿不排期 |
| P2.1 整理报告不进提示 | 成立，非必需 | **T7 可选**：有余力再做 |
| P2.2 规则文件不新开一套 | 同意，无实施内容 | 不做（§10 声明） |

建议顺序：**T3 → T2 → T1 → T4 → T5**。T3 先行是因为它不改变任何交互、纯收紧，且 T2 上线前必须就位；T2 与 T3 同一 PR 交付亦可。T4 / T5 互相独立。

## 1. 报告建议逐条核对（代码现状）

### 1.1 核实为真的断言

- **a. 门槛常量未被执行路径读取**：`SKILL_AUTHOR_REPEAT_THRESHOLD = 2`（`packages/shared/src/constants.ts:322`）全仓库只有定义处和 `packages/core/src/skills/authoring.ts:58` 的一句注释引用，注释声称「反思已经对照执行摘要检查过该条件」——反思提示词（`packages/core/src/memory/reflection.ts:407-421` 的 `REFLECTION_PROMPT`）没有任何次数要求，入队处（`reflection.ts:320-327`）只要 `output.skillSuggestion` 非空就写入 `skill_suggestion` 作业。模型可以在一轮反思里就交出技能建议。
- **b. 人设规则是被动措辞**：`packages/core/src/agent/context/system-prompt.ts` 三处（310 行任务版、367 行项目对话版、789 行工具附注）都是「**用户可以要求你**更新你自己的 Profile……」。`PROFILE_CHANGE_FIELDS` 白名单（`packages/core/src/tools/memory-tools.ts:63-72`）与报告所列一致；身份不能靠 `settings_change` 直写（`bot.identity` 的 `write` 是 `viaTool('propose_profile_change')`）。
- **c. 无人值守会自动批准人设卡**：`NEVER_AUTO_DECIDED`（`packages/core/src/permissions/approvals.ts:140-145`）只有 `butler_proposal` / `mail_send` / `bot_handover`；`profile_change` 不在其中，无人值守下 gate 为空时走 `#autoDecide`（`approvals.ts:242-246`）。
- **d. 两种技能来源同一生成路径、成功即启用**：`skill_suggestion` 作业与 `create_skill` 登记都进 `runSkillAuthoringJob`；成功后 `promoteAuthored` + `activateAuthored`（`authoring.ts:229-230`），不区分来源、不向对话播报。技能面板已有 `skills.enable` / `skills.disable`（`apps/desktop/src/renderer/src/lib/stores/skills.svelte.ts:84-86`），draft/未启用技能有现成的启用入口。
- **e. lesson 注入不带时间和证据**：`evidenceMessageIds` 在反思 schema 里已要求（`packages/core/src/memory/schemas.ts:24,39`），但注入格式 `formatMemoryLine`（`packages/core/src/memory/retrieve.ts:58-61`）只输出 `- [id | kind] content`。

### 1.2 需要细化或修正的点

1. **P0.1 的「按 Bot 的执行摘要计数」无法直接照做。**「同类任务成功 2 次」的「同类」没有代码可判定的信号（任务没有类型字段能对齐「同一类工作」），入队侧拿不到可靠的分类依据。照搬会在代码里写死一个伪分类。本稿改为：模型判断「同类」、代码数证据——`skillSuggestion` 增加证据引用数组，代码把引用解析成该 Bot 不同的已完成 run，≥ 阈值才入队（T1 §3；初版只数条数，审查修正 1 改为解析）。
2. **P1.1 有一个报告没提的顺手修正**：`create_skill` 工具描述写着「通过后自动启用**并通知**」（`packages/core/src/tools/index.ts:984`），实际不通知（消息原则）。T4 改来源分支时一并把描述改到与行为一致。
3. **P0.3 的两个方案里应选 `NEVER_AUTO_DECIDED`，不做摘要单列。**摘要单列只解决「看得见」，不解决「不该自动写」；人设是 Bot 身份资产，静默生效与报告 §8 审批段的立场（Letta 式静默改 persona 不该学）矛盾。
4. **P1.3 依赖的评测基建还不存在**：`docs/reports/2026-10-22-memory-eval-datasets-local.md` 仍是草案，`KEPCUP_MEM_BENCH_*` 门控、L1/L2 夹具、`.bench/` 落盘都没实施。把它排进本稿会造成空转。

## 2. 任务总览

| # | 任务 | 来源 | 优先级 | 规模 | 依赖 | 主要文件 |
|---|---|---|---|---|---|---|
| T1 | 技能建议门槛：证据计数入队闸 | P0.1 | P0 | S–M | — | `core/src/memory/schemas.ts`、`core/src/memory/reflection.ts`、`shared/src/constants.ts` |
| T2 | 平台规则允许主动提议人设更新 | P0.2 | P0 | S | T3（同批） | `core/src/agent/context/system-prompt.ts` |
| T3 | `profile_change` 进 `NEVER_AUTO_DECIDED` | P0.3 | P0 | S | — | `core/src/permissions/approvals.ts` |
| T4 | 反思产生的技能停在未启用态 | P1.1 | P1 | M | — | `core/src/skills/authoring.ts`（按作业类型分流）、`core/src/skills/registry.ts`（`parkAuthored`）、`core/src/tools/index.ts`（描述）、技能面板文案 |
| T5 | lesson 注入带日期与证据标注 | P1.2 | P1 | S | — | `core/src/memory/retrieve.ts`、`core/src/agent/context/system-prompt.ts` |
| T6 | 离线对照作业 | P1.3 | 顺延 | M | 评测草案立项 | `.bench/` 脚本（新） |
| T7 | 整理报告（Bot 大脑可见、不注入） | P2.1 | P2 | S–M | — | `core/src/memory/profile-curation.ts`、桌面「Bot 大脑」视图 |

## 3. T1：技能建议的次数由代码算（P0.1）

### 3.1 现状

见 §1.1-a。门槛只存在于常量和一句不实的注释里。

### 3.2 做法

1. **schema 加证据字段**（`packages/core/src/memory/schemas.ts`，zod 与 TypeBox 两份都要改）：`skillSuggestion` 增加 `evidenceRefs`（zod `default([])`、TypeBox 必填，均无 `min`）——引用反思输入里出现过的消息 id 或 run id（含 `<existing_memories>` 中 lesson / self_note 行「依据」后的消息 id），即「同类任务成功」的出处。
2. **入队代码解析并计数**（`packages/core/src/memory/reflection.ts` 的 `resolveEvidenceRuns`）：每条引用必须解析成该 Bot 的已完成 turn / task run（run id 直接；Bot 消息经产出它的 run；用户消息经它触发的 run），按不同 run 计数；`< SKILL_AUTHOR_REPEAT_THRESHOLD` 时丢弃该建议，info 日志记一条（含建议名、引用数与解析出的 run 数），不报错、不打断反思结算。编造 / 重复 / 同一 run 的多条消息 / 他人或失败的 run 都不算。
3. **提示词写明规则**（`REFLECTION_PROMPT`）：只有当你能在本次输入里指出 **至少 2 次** 同类工作已经成功完成的出处（引用消息/任务 id）时才提交 `skillSuggestion` 并附 `evidenceRefs`；不足就交 `null`。用户明确要求沉淀（那是 `create_skill` 的路径）不受此限。
4. **修正注释**（`authoring.ts:58`）：把「反思已经检查过门槛」改为「反思必须附 ≥ `SKILL_AUTHOR_REPEAT_THRESHOLD` 条证据，入队代码校验条数」。
5. 常量 `SKILL_AUTHOR_REPEAT_THRESHOLD` 从 `shared/src/constants.ts` 被 core 正式引用（当前 core 是否已依赖 shared 常量按现状写 import；阈值数值不变）。

### 3.3 明确不做

- 不在代码里建「任务分类」来数同类成功——分类由模型在反思时判断，代码只校验证据能解析到几个不同的真实 run（§1.2-1）。
- 不改 `create_skill` 路径：用户亲口说「以后都这样做」仍直接登记，不受门槛影响（与调研报告一致）。

### 3.4 验收

- 反思输出带 ≥2 条证据 → 作业入队；0–1 条 → 丢弃且日志可见。
- `create_skill` 集成路径回归不受影响。
- 定向测试：`node scripts/run-tests.mjs run packages/core/test/unit/memory/ packages/core/test/integration/`（以反思相关文件为准 `-t` 过滤）。

## 4. T2：平台规则允许主动提议人设更新（P0.2）

### 4.1 现状

见 §1.1-b。规则只教 Bot「等用户要求再改」。

### 4.2 做法

改 `system-prompt.ts` 的人设条款，在被动条款后追加主动条款——**只改对话轮版**（`TURN_PLATFORM_RULES`，367 行）；任务版（310）与外部智能体版（789）用户不在场、工具会阻塞到用户决定，保持被动措辞（审查修正 2）。要点：

1. 用户明确纠正你的语气、职责、专长或性格时（如「你太啰嗦了」「这不是你该管的事」「你懂这个」），**主动**用 `propose_profile_change` 提议对应字段的修改；
2. 提议必须引用用户原话作为依据（`reason` 里写出处）；
3. 一次只提议被纠正涉及的字段，不趁机改别的；
4. 用户没有纠正就不要改；同一话题只提议一次，用户拒绝或不响应就不再重提；
5. 字面约束不变：仍限 `PROFILE_CHANGE_FIELDS` 白名单、仍走卡、**不新增任何能改平台规则的工具**（与调研报告「明确不做」一致）。

### 4.3 验收

- `context-assembly.test.ts` 断言：对话轮版带主动提议条款，任务版只有被动措辞；记忆时效一句两种 loop 都带。
- 定向测试：`node scripts/run-tests.mjs run packages/core/test/unit/ -t "system prompt"`（以实际测试文件名为准）。

## 5. T3：`profile_change` 收紧无人值守（P0.3）

### 5.1 现状

见 §1.1-c。无人值守期间人设卡被自动批准，「必须用户批准」的承诺失效；T2 之后卡会变多，口子必须先关。

### 5.2 做法

1. `NEVER_AUTO_DECIDED`（`approvals.ts:140-145`）加入 `'profile_change'`，注释写明：人设是 Bot 身份资产，无人值守期间不得静默写入；主动提议（T2）会让卡片变多，此闸是前提。
2. 不改卡片存活与提交即返回语义（D75 DEV-014 不动）：无人值守产生的卡留给用户回来决定。
3. 不做「无人值守摘要单列自动批准项」（调研报告的另一方案）——选了 `NEVER_AUTO_DECIDED` 就不存在自动批准，无需披露项。

### 5.3 验收

- 单测：无人值守 gate 为空时 `profile_change` 不走 `#autoDecide`，等用户决定。
- 定向测试：`node scripts/run-tests.mjs run packages/core/test/unit/permissions/ packages/core/test/integration/ -t "unattended"`（以实际文件为准）。

## 6. T4：反思产生的技能停在未启用态（P1.1）

### 6.1 现状

见 §1.1-d。`skill_suggestion`（模型意图）与 `create_skill`（用户意图）走同一 job，成功即 `promoteAuthored` + `activateAuthored`。外部安装有卡（`skill_preset` / `skill_import`），自建反而静默启用——授权方向倒挂。

### 6.2 做法

1. **不新增 shared 契约**：任务来源就是作业类型（`skill_suggestion` = 反思，`skill_authoring` = `create_skill`），不另加 payload 判别字段（审查修正 3；原稿设想的 `source` 与作业类型是两份真相）。
2. **生成分支**（`authoring.ts` 成功路径）：`job.type === 'skill_suggestion'` → `promoteAuthored` 后 `parkAuthored`，不 `activateAuthored`（技能存在但未启用）；`skill_authoring` → 维持现状（沙箱通过即启用）。
3. **面板**：确认「Bot 技能」面板对未启用技能展示「启用」按钮（`skills.enable` 已存在，预计零改动）；必要时文案把这类条目标为「反思生成，待启用」。
4. **描述修正**（`tools/index.ts:984`）：`create_skill` 描述「通过后自动启用并通知」改为「通过后自动启用」，去掉不存在的通知（§1.2-2）。
5. 维持不向对话播报：reflection 来源停在被启用前本就更安静；用户侧发现入口是技能面板（`skills.changed` 驱动），与现有消息原则不冲突。

### 6.3 验收

- 集成测试两条：reflection 来源验证通过后技能为未启用；user 来源维持启用。
- 面板手动验收：未启用技能可见、可一键启用。

## 7. T5：lesson 注入带日期与证据（P1.2）

### 7.1 现状

见 §1.1-e。模型看到一条 `lesson` 时不知道它多久前写的、依据是什么。

### 7.2 做法

1. `formatMemoryLine`（`retrieve.ts:58-61`）对 `kind === 'lesson' | 'self_note'` 的条目追加写入日期（`YYYY-MM-DD`，取自 item 的 createdAt）与证据引用（`evidenceMessageIds` 前 2 个）：`- [id | lesson | 2026-10-20 | 依据 m123,m456] 内容`；其余 kind 维持现状。
2. `system-prompt.ts` 记忆段条款与现有「记忆可能已过时，关键决定前向用户确认」合并扩一句：带日期的 lesson 距今越久越可能过时，与当前代码或用户最新说法冲突时以后者为准。
3. 预算控制：只在 `lesson` / `self_note` 上加标注（这两类最依赖时效）；普通 `fact` / `preference` 不加，避免每行注入普遍膨胀。证据 id 截断到 2 个。

### 7.3 验收

- `retrieve` 单测：lesson 行含日期与证据；fact 行格式不变。
- 定向测试：`node scripts/run-tests.mjs run packages/core/test/unit/memory/retrieve*.test.ts`。

## 8. T6：离线对照作业（顺延，不排期）

方向成立（Harness² 可借鉴的是「同一输入、改一处、再量一次」的对照思想，费用是两次本机作业），但前置的评测数据集草案（`docs/reports/2026-10-22-memory-eval-datasets-local.md`）尚未实施：L1/L2 夹具、`KEPCUP_MEM_BENCH_*` 门控、`.bench/` 落盘均不存在。

- 本稿不排期。评测草案立项时把本项并入其任务表：固定一小套任务夹具，对比「加一条技能 / 改反思提示一句话」前后，一次只改一处，结果写 `.bench/`、不上 CI；GEPA/DSPy 只允许作为该本机脚本的可选优化器，产物是人看的 diff。
- 在此之前不做任何「提示词调优」性质的临时对比。

## 9. T7：整理报告（可选）

每日 consolidation 之外，把整理动作写成一份只在「Bot 大脑」可见的摘要（何时 supersede 了什么、为何保留冲突两条、给哪个 Bot 写了 `self_note`），不注入模型（OpenClaw `DREAMS.md` / Devin Dreaming 记录的桌面版）。规模 S–M，有余力再做；实施时与「Bot 大脑」现有视图合并设计，不新开页面。

## 10. 明确不做（与调研报告一致）

- 不把 Harness² 的 Propose–Probe–Compose 循环、执行器栈引进产品；不在线对同一用户任务跑多遍。
- 不让 Bot 改 `PLATFORM_RULES`、组织级策略或无人值守底线的代码；不新增第二份「Bot 可写的规则文件」（P2.2）。
- 不学 Letta 式静默 `core_memory_replace` 改 persona；不学 AutoGPT `--continuous`。
- 不做 TextGrad / APE / OPRO 产品化；不动 OpenMind 叙事。
- 不为 T1 建任务分类学，不为 T5 给全部记忆行加日期（预算）。

## 11. 测试与交付纪律

- 每任务独立 PR，迭代期只跑 §3–§7 列出的定向测试；T1–T5 全部合入后全量跑一次 `pnpm test` 收口。
- 最终实现不改 shared 契约（审查修正 3），提交前 core typecheck + 定向测试即可。
- 行为变化里用户可感知的只有两处：人设卡可能在不经要求时出现（T2，且被收紧到「用户纠正过才提」）；反思生成的技能要手动启用（T4）。发布说明各写一句。

## 12. 实施结束后的设计文档回写

调研报告状态栏的约束（「要变成规范须回写 design 并留决策」）适用本稿。T1–T5 全部合入、全量测试收口后，按下表回写，决策编号自 **D97** 起（以 `docs/design/README.md` 决策表现状为准）：

| 任务 | 回写文档 | 回写内容 |
|---|---|---|
| T1 | `docs/design/05-wiki-and-skills.md` | 反思→技能建议的门槛：证据计数入队闸、`SKILL_AUTHOR_REPEAT_THRESHOLD` 的真实执行位置；同时修正该文档「反思发现成功 2～3 次」段与实现的对应关系 |
| T2 | `docs/design/03-bot.md` | 人设修改：新增「用户纠正时主动提议」条款及其防打扰边界（同一话题一次、引用原话、白名单不变），仅对话轮版 |
| T3 | `docs/design/13-permissions.md` | 无人值守永不自动批准清单加入 `profile_change` 及理由 |
| T4 | `docs/design/05-wiki-and-skills.md` | 自建技能双轨授权：用户意图（`create_skill`）沙箱通过即启用；反思意图（`skill_suggestion`）停未启用、面板启用；并注明「生成完成不在对话播报」与 design/01 消息原则的关系为现状确认 |
| T5 | `docs/design/04-memory.md` | lesson / self_note 注入格式（日期 + 证据）与「时效核对」条款 |
| 全部 | `docs/design/README.md` | 决策表追加 D97+ 行，注明来源为本规划与调研报告 |

回写完成后把本稿状态改为「已实施」，并在 `docs/reports/2026-10-23-agent-self-evolution-landscape.md` 顶部状态行加一句「建议已由 todo/bot-self-evolution.md 落地」的互链。
