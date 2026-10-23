# 调研：Agent 自我进化的产品落地方案，以及 KepCup 对照

| 字段 | 内容 |
|---|---|
| 日期 | 2026-10-23（Asia/Shanghai） |
| 状态 | **调研**（非 design 权威；要变成规范须回写 design 并留决策）。**建议已由 [todo/bot-self-evolution.md](../../todo/bot-self-evolution.md) 落地（2026-10-23，T1–T5 → 决策 D97–D101；P1.3 离线对照顺延至评测草案立项）** |
| 读者 | KepCup 产品 / 工程（Pengfei） |
| 范围 | 已公开、可核对的产品行为：谁可以改 prompt / 人设 / 技能 / 记忆 / 策略，谁发起，怎么批，在线还是离线。纯论文只在它已经长出可运行代码或产品入口时展开 |
| 材料 | 各产品官方文档、博客、GitHub README、论文（检索日 2026-10-23）；本仓库 `packages/core` 与 `docs/design` |
| 结论摘要 | 顶尖产品把「进化」落成 **可检查的文件**（规则、技能、记忆笔记），再配 **用户开关或事后可改**。几乎没有人让模型在线改写平台系统提示。KepCup 已经有画像、反思、技能生成和 Profile 审批卡，缺的是 **主动提议的引导**、**反思来源技能的代码门槛**，以及 **离线对照**。Google Harness² 是研究框架，不引进产品。 |

---

## 1. 怎么读这份对照

这里的「自我进化」只计已经落到用户能碰到的行为：

1. **可改面**：常驻指令、人设、技能/工具、记忆、平台策略（权限、系统提示）。
2. **发起**：用户开口、Agent 提议、后台自动。
3. **审批**：静默写入、卡片/diff、管理员发布。
4. **时机与费用**：在对话里写，还是闲时/离线再跑一遍；有没有公开的成本闸。

论文里的 Prompt 优化（APE、OPRO、TextGrad）和 Reflexion / Voyager，单独放在第 4 节，并写明哪些已经进了开发者工具、哪些仍是实验代码。

编码底座只在技术事实上出现（例如 Harness² 的执行器）。对照表不把它们当成 KepCup 的竞品列。

---

## 2. 编程 / IDE Agent

### 2.1 Cursor

公开文档把定制拆成两层，外加一套给托管 Agent 的「改进自己」流程。

- **可改面**
  - **Rules**：项目 `.cursor/rules`（`.mdc`，进 git）、用户级 User Rules、团队 Team Rules、以及 `AGENTS.md`。规则在每次请求开头注入。官方说明模型本身不跨 completion 记事，持久上下文靠规则。[Rules](https://cursor.com/docs/rules)
  - **Skills**：`SKILL.md` 目录（`.cursor/skills/`、`.agents/skills/`、用户级 `~/.cursor/skills/`，并兼容 `.claude/skills`、`.codex/skills`）。启动时只给名字和描述，命中才加载全文。内置 `/create-rule`、`/create-skill`、`/migrate-to-skills`。[Agent Skills](https://cursor.com/docs/skills)、[Customizing agents](https://cursor.com/learn/customizing-agents)
  - **IDE Memories**：Changelog 1.2 曾把 Memories 标为 GA，并写明后台生成的记忆要用户批准。[changelog 1.2](https://cursor.com/changelog/1-2)。2025-11 至 2026-01 的论坛回复（Cursor 员工）说 2.1.x 起设置里的 Memories 界面被拿掉，旧记忆可能仍被 Agent 读到，删除入口不稳定（「Delete all memories」有时没有对应工具）。检索日 **没有** 再找到把 IDE Memories 当作现行设置页的官方文档。现行定制面以 Rules 和 Skills 为准。
  - **Agent SDK**：`improve yourself` 把一次行为修改收成仓库 diff 和 PR；人合并、另一次部署才生效。文档写明「never merge」只是提示，硬边界在仓库权限和部署授权。[Self-improvement](https://cursor.com/docs/agent-sdk/guides/improve)。Hillclimbing 要求固定夹具、一次只动一个旋钮、对照后再保留。[Hillclimbing](https://cursor.com/docs/agent-sdk/hillclimbing)
- **谁发起**：规则和技能默认人写，或人用 `/create-rule`、`/create-skill` 让 Agent 落文件。SDK 的改进由人说出「改哪一条行为、怎么算成功、哪条不能动」。
- **审批**：项目规则/技能是 git 文件，走仓库审查。SDK 停在 PR，不自动部署。旧 Memories 的批准 UI 已不在现行文档里。
- **在线 / 费用**：规则和技能是提示词装配，不额外跑优化循环。Hillclimbing 按夹具重跑，费用等于多轮 Agent。
- **证据日期**：文档与 changelog 于 2026-10-23 检索；Memories 下线说法来自 2025-11-24、2026-01-07 的论坛帖，不是现行文档。

### 2.2 Claude Code（及 computer use）

Claude Code 把「人写的指令」和「Claude 自己的笔记」拆开。Computer use 本身不是进化回路。

- **可改面**
  - **CLAUDE.md / AGENTS.md / `.claude/rules/`**：人写的项目、用户、组织级指令。官方写明它们是上下文，不是强制配置；要硬拦动作用 hook 或 managed settings。`/init` 可以起草 CLAUDE.md；设 `CLAUDE_CODE_NEW_INIT=1` 时先给可审提案再写文件。`/doctor prompt-audit`（v2.1.283+）只出问题和建议，人点头才改文件。[How Claude remembers your project](https://code.claude.com/docs/en/memory)
  - **Auto memory**：本地会话默认开。Claude 把笔记写成 `~/.claude/projects/<repo>/memory/` 下的 markdown（`user` / `feedback` / `project` / `reference`）。`MEMORY.md` 索引最多注入前 200 行或 25KB；主题文件按需读。同仓库的 worktree 共用一份，不跨机器。Claude 跳过能从代码或已有 CLAUDE.md 推出来的内容。
  - **Skills**：`.claude/skills/` 或 `~/.claude/skills/` 的 `SKILL.md`，相关时自动选用。人建目录，或在对话里让 Claude 写。[Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
  - **平台策略**：组织用 managed `CLAUDE.md` 做行为引导，用 `permissions.deny` 等做强制。模型不能改这层。
  - **Computer use**：2024-10-22 的产品文是「模型能点屏幕、打字」，讲的是 GUI 操作和安全，没有自我改写提示或技能库。[Developing a computer use model](https://www.anthropic.com/news/developing-computer-use)（文内更新注记 2025-08-28）。检索日没有找到 computer-use 产品自己的进化回路；和「越用越好」相邻的是 Claude Code 的 auto memory 与技能文件。
- **谁发起**：CLAUDE.md 由人写，或人说「写进 CLAUDE.md」。Auto memory 由 Claude 在会话中自行决定记不记。帮助中心把「纠正完补一句：更新 CLAUDE.md」当成推荐用法。[Power user tips](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips)
- **审批**：Auto memory **静默写盘**，界面会出现 “Saved N memories”；人用 `/memory` 打开文件夹改删，没有逐条卡片。外部 `@import` 第一次要批准。`/doctor prompt-audit` 不自动落盘。
- **在线 / 费用**：笔记写在当次会话的文件工具里，不另开优化器。索引超限时宿主提醒模型缩短，写仍成功。自托管环境默认关 auto memory。
- **证据日期**：官方 memory 文档页眉地图标 2026-10-23 02:39 UTC 自动生成；本报告同日检索。

### 2.3 OpenAI Codex 与 ChatGPT

- **可改面**
  - **AGENTS.md**：全局 `~/.codex/AGENTS.md`（或 `AGENTS.override.md`）加上仓库内从根走到当前目录的文件，拼接后更近的目录在后。默认合计约 32KiB 封顶。官方把「纠正一次就让 Agent 改 AGENTS.md」写成反馈环，并建议用定时任务检查指导缺口。[Customization](https://developers.openai.com/codex/concepts/customization)、[AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
  - **Memories**：ChatGPT 网页用 ChatGPT memory；本机 Codex 用另一套 `~/.codex/memories/`。文档要求必守规则放 AGENTS.md，记忆只是召回层。生成会跳过仍活跃的短会话、涂掉密钥字段。[Memories](https://developers.openai.com/codex/customization/memories)
  - **Skills、MCP、子 Agent**：和规则、记忆并列，技能是可复用流程。[Customization](https://developers.openai.com/codex/concepts/customization)
  - **人设**：`personality` 配置（`none` / `friendly` / `pragmatic`）是用户设置，不是模型自改。[Config reference](https://developers.openai.com/codex/config-reference)
  - **未落地的 RFC**：Codex issue [#40575](https://github.com/openai/codex/issues/40575) 提议 `/learn` 把纠正蒸馏成 AGENTS.md 的 ADD / NARROW / REPLACE / RETIRE，且先审后写。这是提案，不是现行产品。
- **谁发起**：规则由人写或人要求 Agent 改文件。记忆在功能打开后由后台从闲置会话生成。`/memories` 让人选择「使用 / 生成 / 关闭」。
- **审批**：记忆文件是生成状态，文档不鼓励手改当主界面；开关在配置和 `/memories`。AGENTS.md 的修改就是普通文件编辑。没有「模型改平台系统提示」的入口。
- **在线 / 费用**：记忆不在每回合结束时立刻写。线程至少闲置 `min_rollout_idle_hours`（默认 6，范围 1–48）才进入生成；剩余速率限额低于 `min_rate_limit_remaining_percent`（默认 25%）则跳过本轮。未使用记忆默认 30 天不再参与整理。可用 `extract_model` / `consolidation_model` 指定更便宜的模型。[Config reference](https://developers.openai.com/codex/config-reference)
- **证据日期**：2026-10-23 检索的开发者文档。

### 2.4 GitHub Copilot Memory

用户清单未点名，但它是编程 Agent 里把「记忆会过期」做成产品机制的公开方案，故列入。

- **可改面**：仓库事实（约定、架构、构建命令）和用户偏好。事实带代码引用。不改 Copilot 的平台提示。[About GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- **谁发起**：对有写权限且打开了 Memory 的用户动作做记录。2026-03-04 起对 Pro / Pro+ 默认开启。[Changelog](https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/)
- **审批**：仓库所有者可查看并手删仓库事实。用户级偏好对 Business / Enterprise 可由管理员查看和删除。使用前按当前分支核对引用，对不上就不用，并鼓励写成更正版。[工程博客](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)
- **在线 / 费用**：会话开始注入近期记忆；核对是几次读代码，官方称延迟可忽略。未使用条目 28 天后删除，成功使用可重置计时。
- **证据日期**：文档与 2026-01 工程博客、2026-03 changelog，于 2026-10-23 检索。

### 2.5 Devin（Cognition）

- **可改面**
  - **Knowledge**：组织级提示与触发描述，Devin 按当前工作召回。可按人启用/停用，可用 `!macro` 点名。[Knowledge](https://docs.devin.ai/product-guides/knowledge)
  - **Skills**：仓库 `.agents/skills/*/SKILL.md`，或插件装到个人/组织/企业。和 Agent Skills 标准对齐。[Devin Skills](https://docs.devin.ai/product-guides/skills)
  - **Memory**：个人、组织内的 markdown 仓库。`MEMORY.md` 常驻，其余按需读。每条注明来源会话和日期。和队友不共享。[Memory and Dreaming](https://docs.devin.ai/product-guides/memory)
  - **DeepWiki**：自动为仓库生成带源链接的文档，供 Ask Devin 检索。这是代码索引，不是行为自改。[How Cognition uses Devin](https://cognition.com/blog/how-cognition-uses-devin-to-build-devin)
- **谁发起**：Knowledge 由人建；Devin 会根据聊天反馈 **建议** 新条目或更新，人编辑后保存。Skills 由人提交，或 Devin 在会话里建议，人点 “Create PR”。Memory 由 Devin 在工作时自己改笔记。Dreaming 每天异步去重、连到会话、丢掉过时条目。[博客，2026-10-05](https://devin.ai/blog/memory-and-dreaming)
- **审批**：Knowledge 建议要人保存。技能建议要人开 PR。记忆写入后会话里有 “Updated memory” 卡；新记忆 **下一会话** 才生效。组织可把 Memory 锁成常开或常关；关掉后不读不写，Dreaming 也不跑，已有笔记不删。
- **在线 / 费用**：记忆写在会话里并 git 合并（过期写入会拒绝重试）。Dreaming 是日频后台。公开文档没有按次标价。
- **证据日期**：文档与 2026-10-05 博客，于 2026-10-23 检索。

### 2.6 Windsurf / Cascade、Cline、Continue

- **Windsurf / Devin Desktop 的 Cascade**
  - **可改面**：Memories（Cascade 自动记、按工作区存在本机 `~/.codeium/windsurf/memories/`，不进 git）、Rules（全局 / 工作区 `.devin/rules` 或旧 `.windsurf/rules` / `AGENTS.md`）、Workflows（人用 `/` 调用）、Skills（模型按需或 `@`）。官方建议耐久知识写规则而不是靠自动记忆。[Memories & Rules](https://docs.windsurf.com/windsurf/cascade/memories)
  - **谁发起**：记忆可自动生成，也可人说 “create a memory of …”。规则人写。
  - **审批**：记忆可在 Customizations 里点开编辑。文档写明自动记忆不耗 credits。
  - **重要边界**：同一页写明 Memories **只对旧 Cascade**；新标签默认的 Devin Local **不持久化这些记忆**，要靠迁移向导收成技能。检索日这是官方现状，不是第三方猜测。
- **Cline**
  - **可改面**：Rules（工作区 `.clinerules/`、`.cline/rules/`，以及全局与 `~/.agents/`）。[Rules](https://docs.cline.bot/customization/cline-rules)
  - **Memory Bank** 是一套让人复制进规则的 markdown 方法（`memory-bank/*.md`），不是独立记忆服务。人说 “initialize / update memory bank” 或 “follow your custom instructions” 才读写。[Memory Bank](https://docs.cline.bot/best-practices/memory-bank)
  - **审批**：文件在仓库里，人可直接改。没有后台自我改规则的产品开关。
- **Continue**
  - **可改面**：`.continue/rules/*.md` 拼进 Agent / Chat / Edit 的系统消息（不进补全）。Agent 模式可用 `create_rule_block`：人说 “Create a rule for this” 就在 `.continue/rules` 落文件。[Rules](https://docs.continue.dev/customize/deep-dives/rules)
  - **审批**：文件落盘后人在工具条里能看到规则。文档没有自动记忆或提示词优化器。

---

## 3. 个人 / 桌面 Agent

### 3.1 Grok Bot 与 Grok Build（xAI）

公开材料把「越用越懂你」落在 Bot 记忆、技能和例行任务上，没有公开「改平台系统提示」的接口。

- **Grok Bot**
  - **可改面**：每个 Bot 有持久身份、记忆、文件和浏览器会话。技能是可复用步骤（含何时用、如何验收、哪一步要批准）。例行任务在技能可靠之后再挂日程或事件。工具和计算机使用受批准策略约束。[概述](https://docs.x.ai/grok-bot/overview)、[设计说明](https://x.ai/news/designing-grok-bot)、[工作方式](https://cursor.com/docs/grok-bot/work)（与 xAI 文档同文，2026-10-23 检索）
  - **谁发起**：建 Bot 时人描述工作。技能由人要求「把这次过程存成技能」。记忆保留稳定偏好、角色和既往工作摘要；文档要求多变事实留在源系统，重要决定要重新打开来源。
  - **审批**：外发、购买、删除、发布、生产变更留在显式批准后。文档写明安全边界靠批准和 Auto-review，不能只靠记忆。
  - **费用**：云端计算机持续运行；公开页没有把记忆单列成优化计费。
- **Grok Build**（编程侧，2026-09-16）
  - 回合结束后后台把约定、决策和项目事实写成 markdown；`/dream` 并进主题文件（也会自己定期跑）；`/memory` 打开磁盘上的文件。当前对话指令优先于笔记。不记任务现场、试探性结论、密钥，以及仓库里已经写明的内容。[Memory in Grok Build](https://x.ai/news/grok-build-memory)

### 3.2 OpenClaw

OpenClaw 把记忆做成带信任等级的文件，而不是让模型改自己的系统提示。

- **可改面**：[Memory architecture](https://docs.openclaw.ai/concepts/memory-architecture)（2026-10-23 检索）
  - 指令（`AGENTS.md` 等）：**只由人写**，会话开始总是注入。
  - 精选核心（`MEMORY.md`、`USER.md`）：Dreaming 整理，或用户直接要求；有来源资格才注入，且有预算。
  - 情节（`memory/YYYY-MM-DD.md`、记录）：Agent 在工作中写、压缩前 flush；不在会话开始时整份注入。
  - 前瞻（意图、cron）：`intent` 工具或日程，触发才出现。
  - 审阅（`DREAMS.md`、Dreaming 报告）：**从不注入**，给人看。
- **谁发起**：情节笔记由 Agent 写。进入精选核心必须过代码里的提升门（来源类别、会话种类、时间与 supersede）。模型只在这些固定规则里面做语言判断。
- **审批**：没有隐藏状态，文件可直接编辑。不可信来源（网页、工具输出、群里非主人）在写入时标成 `untrusted`，不能靠事后扫描补救。
- **在线 / 费用**：回复路径有超时，记忆故障不挡住回复。整理在后台。可选 MemGPT 插件（`openclaw-memgpt`）让 Agent 用 `core_memory_append` / `replace` 直接改核心块，那是另一套、更接近 Letta 的静默自改，不是 Memory Core 默认。

### 3.3 Letta（原 MemGPT）

- **可改面**：带标签的 memory block（如 human、persona），有大小上限。默认可由 Agent 用 `core_memory_append` / `core_memory_replace` 改，除非开发者把块标成只读。Recall 搜对话，archival 搜长期库。每次请求由数据库里的块 **编译** 进上下文，而不是模型改一段固定系统提示模板。[Memory blocks](https://www.letta.com/blog/memory-blocks/)、[系统提示](https://github.com/letta-ai/letta/blob/main/letta/prompts/system_prompts/memgpt_v2_chat.py)
- **谁发起**：Agent 在对话中自己调用记忆工具。开发者用 ADE / API 按 `block_id` 改。
- **审批**：产品默认 **没有** 终端用户批准卡。只读块是开发者侧的闸。系统提示把「能改自己的长期记忆」写成能力的一部分。
- **在线 / 费用**：写在当次工具调用里。这是开发者平台，不是开箱即用的桌面伴侣。
- **证据日期**：博客与 main 分支源码，2026-10-23 检索。

### 3.4 CrewAI

- **可改面**：统一的 `Memory` 类（文档写明已取代从前分开的 short / long / entity / external）。保存时可用 LLM 推断 scope、类别和重要度；召回按语义、新近和重要度打分。`memory=True` 时 crew 从任务输出抽事实，下次任务前召回。Knowledge 是另一路嵌入文档，不是执行记忆。[Memory](https://docs.crewai.com/edge/en/concepts/memory)
- **谁发起**：框架在任务边界自动存取。人设（role / goal / backstory）是人写的配置，文档没有 Agent 改自己 backstory 的产品流程。
- **审批**：库级 API，没有终端用户卡片。
- **在线 / 费用**：保存和深度召回各要一次 LLM；默认嵌入是 OpenAI。分析失败会降级，不中断 crew。
- **边界**：这是多 Agent 框架的记忆开关，不是自我改提示的产品。旧的三层记忆类名在现行文档里已退休，平台 FAQ 仍用旧分层说法，以 concepts 文档为准。

### 3.5 AutoGPT Classic

- **可改面**：人用 `--ai-name`、`--ai-role`、`--constraint` 等设定进提示的身份和约束。循环里模型产出 thoughts（含 `self_criticism` 和 plan）再选一个工具。状态可恢复。它 **不** 把改写后的系统提示当成受控产物。[Classic README](https://github.com/Significant-Gravitas/AutoGPT/blob/master/classic/original_autogpt/README.md)、[用法](https://agpt.co/docs/classic/setup/usage)
- **谁发起**：人给目标；之后模型自己决定下一步。
- **审批**：默认每步给人看命令。`--continuous` 跳过逐步授权，文档标明危险，可用 `--continuous-limit` 封顶。
- **在线 / 费用**：每步一次模型调用，连续模式会一直烧到人打断或步数用尽。
- **现状**：仓库仍保留 classic CLI。它示范的是「自己接下一个动作」，不是「把学到的规则经批准写回人设」。

---

## 4. 研究到产品的桥

### 4.1 Google Harness²（不要引进）

[Harness²](https://github.com/google-research/harness2)（论文 [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)，2026-10-09 提交）优化的是 **套在冻结模型外面的 harness**（提示、工具说明、技能、编排），不改权重。

**Propose–Probe–Compose（任务级）**

1. **Propose**：先跑一遍当前 harness 当参照（参照说明它怎么做，不说明做对没有）。再提出两个可执行修改：一个针对跨领域的 Agent 缺陷（计划、工具、上下文、委派），一个针对当前领域。
2. **Probe**：两个候选在 **同一任务、同一模型、同一环境** 上再跑，和参照比行为差异。差异不是正确性分数。
3. **Compose**：读 diff 和轨迹，选择合并、改冲突、采纳一边或保持原样。决定必须挂在某条观察上。组合结果再执行一次。

任务做完后，**harness 级** 递归把采纳的 harness 和有证据的教训写入按领域分开的库，供以后的任务读。并行模式加宽候选，串行模式把上一轮结果带进下一轮。`--k 1` 是一步。论文报告单步对 GLM-5 / Gemini 3.5 Flash 的提升最高约 WorkBuddy-Bench +11.5、JobBench +4.5、LAB partial pass +11.8 个百分点；`k=5` 并行还会再涨，同时计入执行和改写的全部 token。

**能产品化的只有思想，不是这套循环**

- 可借鉴：改动要有对照证据；技能和脚本这类「用到才加载」的面，比加长常驻提示更合适；教训要和某次执行绑在一起。
- 不能搬进 KepCup 在线路径：一步至少是参照 + 两个候选 + 一次组合执行，公开实现还有独立的强编辑模型；没有任务真值，对照只是行为差异；库从空开始按基准流顺序更新，不能当用户日常对话的副作用。执行器是现成的编程 Agent（论文使用 OpenCode 与 Codex 两套），属于研究底座，不是 KepCup 要并列的产品。
- 和 D93 的差别见第 7 节：D93 是压缩、计划和空转护栏，不是这套递归改 harness。

### 4.2 DSPy / GEPA、TextGrad、APE、OPRO

| 方法 | 落地到哪 | 缺什么 |
|---|---|---|
| **DSPy** | 开发者框架：`compile` 把通过指标的轨迹收成 few-shot，写进模块，运行时不再变。MIPROv2 搜指令和示例。程序可序列化 | 要训练集和指标。不是聊天产品里的自我改写 |
| **GEPA** | 用轨迹反思改提示。已进 `dspy.GEPA`、MLflow `optimize_prompts`、Opik、Pydantic AI，以及 Google ADK 的 `adk optimize` / Gemini Enterprise Agent Platform 的 Quality Flywheel。[gepa-ai/gepa](https://github.com/gepa-ai/gepa) | 仍是离线优化作业，要指标调用预算（示例里 `max_metric_calls=150`） |
| **TextGrad** | 研究库：把文本当梯度反传去改提示或代码。没有找到面向终端用户的产品入口 | 留在论文和库 |
| **APE**（Zhou 等，2022） | 自动生成并按打分筛选提示 | 无现行产品 |
| **OPRO**（Google，2023，LLM as Optimizers） | 用模型提议提示、按分数迭代 | 无现行产品 |

和 KepCup 相关的只有一条：若要动反思提示或技能正文，用 **离线、有指标、人看 diff** 的 GEPA/DSPy，而不是在用户对话里搜提示。

### 4.3 Reflexion

Shinn 等，*Reflexion*（NeurIPS 2023，[arXiv:2303.11366](https://arxiv.org/abs/2303.11366)）：失败后用自然语言写一句教训，放进情景记忆，下次试再读。不更新权重。Voyager 论文把它当作带环境反馈的基线，不是独立产品。

产品里相近的是「记一条 lesson」，不是「再跑三遍直到分数涨」。Devin 的 Dreaming、Claude 的 feedback 类笔记、KepCup 反思里的 `lesson` 都更接近这个形态。Reflexion 原文的重试循环依赖可判定的成败，闲聊没有这个信号。

### 4.4 Voyager 式技能库

Voyager（Wang 等，2023，[arXiv:2305.16291](https://arxiv.org/abs/2305.16291)，代码 [MineDojo/Voyager](https://github.com/MineDojo/Voyager)，MIT）在 Minecraft 里把 **通过环境自检的可执行代码** 存进技能库，用描述向量检索 top-k，再组合去解新任务。自动课程和自我验证都在仿真里，没有人点批准。

已经产品化的是后半截：**技能是带说明的文件，用到才读，脚本单独跑**。Claude Code、Cursor、Devin、Codex 和 KepCup 的 Agent Skills 都是这条线。没有产品把 Voyager 的「无人看管、环境即裁判、库无限长大」原样搬到桌面伴侣。KepCup 自建技能已有沙箱语法检查和测试命令，这是 Voyager 里「没跑过就别收进库」的弱化版，而且触发仍应跟人的意图或重复成功绑在一起。

---

## 5. 企业助手

### 5.1 Microsoft Copilot Studio

- **记忆（GitHub Copilot harness，生产预览）**：制作者按 Agent 开关。每个用户一份文件记忆，别人和制作者都看不见。捕获偏好和上下文，之后读出来用。28 天无交互删除。群聊和 Teams 渠道关闭。用户可在对话里要求查看、改正或忘记，或打开记忆门户全部删除。[Memory 概述](https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview)。Customer Conversation harness 是另一套结构化记忆，本文不展开。
- **业务流程记忆**：博客称同一流程里一个人提出的习惯可以变成其他人也能用的上下文，制作者用指令决定这些上下文怎么影响 Agent，权威记录仍是业务系统。[Copilot 博客](https://www.microsoft.com/en-us/copilot/blog/copilot-studio/delegate-shared-business-processes-to-agents-that-are-more-persistent-and-proactive-with-microsoft-copilot-studio/)
- **Agent refinements（自我学习）**：Message Center [RM570432](https://mc.merill.net/message/RM570432)（2026-09-30，状态仍为 In development）描述：从已完成运行里找可收成 workflow 的重复工具序列，向制作者给出证据、预期影响和指令/工具改动；制作者接受、配置、测试，再 **发布一份改进副本**。预览目标 2026-09，GA 目标 2026-10。检索日不能把它当成已经默认开启的自主改写。博客用的也是 “over the coming months we plan to roll out”。
- **可改面**：用户记忆；将来可能是工作流、技能、指令和模型选择的 **建议**。平台策略仍由制作者发布。
- **费用**：refinements 的公开动机包括把重复步骤从模型判断挪到 workflow 以控成本。

### 5.2 Gemini：Gems、Skills、Workspace Agent

- **消费端 Gems → Skills**：2026-09-30 博客宣布 Skills 取代 Gems。人保存一套指令，用 `/` 调用，或由 Gemini 在匹配时自动用。可从对话里让 Gemini 帮忙做技能，也可上传含 `SKILL.md` 的文件夹（脚本不能访问外网）。现有 Gems 会迁移。个人账号计划 2026-11 起移除 Gems，Workspace 商业/企业/非营利为 2027-03，教育为 2027-06。[博客](https://blog.google/products-and-platforms/products/gemini/automate-tasks-with-skills/)、[帮助中心](https://support.google.com/gemini/answer/17094296?co=GENIE.Platform%3DDesktop&hl=en)
- **这不是模型偷偷改人设**。技能是用户资产，人在 Skills 页编辑。自动运行的是「这条指令匹配当前问题」。
- **Gemini Enterprise / Workspace Agent**（[Google Cloud 博客](https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026)）：工具注册表、技能注册表（全球库、公司库、个人技能），以及四类记忆（会话、语义、程序——含它自己写的技能、情节）。文案写 “continuously learns from each execution” 和 “skills it writes for itself”。公开博客 **没有** 写清自写技能要不要管理员发布、失败怎么回滚。当成方向声明，不当成已核对的审批规格。
- **编码技能的反例**：Gemini API 的开发者技能是人维护的 `SKILL.md`。Google 开发者博客（2026-03-25）写明技能没有好的自动更新故事，旧技能会留在用户仓库里帮倒忙。[Closing the knowledge gap](https://developers.googleblog.com/en/closing-the-knowledge-gap-with-agent-skills/)

---

## 6. 对照表

行是产品，列是可改面和控制方式。单元格写的是 **现行公开行为**。「—」表示检索日没有可信的产品入口。Harness²、DSPy、Reflexion、Voyager 是研究或开发者框架，单列在表末，避免和终端产品混成一类。

| 产品 | 常驻指令 | 人设 | 技能 | 记忆 | 平台策略 | 谁发起 | 审批 | 费用闸 |
|---|---|---|---|---|---|---|---|---|
| Cursor IDE | 人/Agent 写规则文件 | — | `/create-skill` 落文件 | 旧 Memories UI 已不在现行文档 | 人管规则与仓库权限 | 人，或人叫 Agent 写文件 | git / PR（SDK） | 规则本身不另计；hillclimb 按重跑 |
| Claude Code | 人写 CLAUDE.md；audit 先提案 | — | 人建或让 Claude 写 SKILL.md | Auto memory 默认同仓静默写 | managed settings / hook，模型改不了 | 笔记：模型；指令：人 | 笔记事后可改；指令文件人审 | 写在会话内 |
| Codex | AGENTS.md，可让 Agent 改 | 用户配置 personality | 技能文件 | 本机后台记忆，与 ChatGPT memory 分开 | 配置文件，模型不改平台提示 | 记忆：后台；规则：人 | `/memories` 开关；文件可查 | 闲置至少 6 小时；剩余限额低于 25% 则跳过 |
| Copilot | 仓库事实可当约定用 | 用户偏好记忆 | — | 带引用，用前对当前分支核对 | — | 写权限用户的使用中自动记 | 仓库主人可删；28 天未用删除 | 核对是几次读 |
| Devin | Knowledge 条目 | Memory 里的偏好 | 建议后 Create PR | 个人笔记 + 日频 Dreaming | 组织可锁死 Memory | 笔记自动；知识/技能提议 | 知识要保存；技能要 PR；记忆有更新卡 | 文档未单列 |
| Windsurf Cascade | Rules / AGENTS.md | — | Skills | 仅旧 Cascade；本机、不进 git | — | 记忆可自动 | 设置里可编辑 | 自动记忆不耗 credits |
| Cline | Rules 文件 | — | — | Memory Bank 是人触发的 markdown | — | 人说 update | 仓库文件 | 无单独记忆计费 |
| Continue | `.continue/rules` | — | — | — | — | 人，或 `create_rule_block` | 文件可见 | 无 |
| Grok Bot | 角色说明 / 让它记住的规则 | Bot 身份与记忆 | 人要求存成技能，再挂例行 | 偏好、角色、工作摘要 | 批准与 Auto-review | 人要求存技能；记忆随工作 | 外发等要批准 | 云计算机，记忆未单列 |
| Grok Build | 项目笔记可含约定 | — | — | 回合后后台 markdown，`/dream` | 当前对话优先于笔记 | 自动，人可 `/dream` | 文件可打开 | 后台，不挡回合 |
| OpenClaw | 只由人写 | 精选核心里的用户模型 | — | 情节 Agent 写；核心靠 Dreaming 门 | 来源等级是代码 | 提升是后台 | 文件全可见；审阅层不注入 | 失败不挡回复 |
| Letta | 开发者模板 | Agent 可改 persona 块 | 开发者工具 | core / recall / archival | 只读块由开发者锁 | Agent 工具调用 | 默无终端用户卡 | 当次工具 |
| CrewAI | 人写的 Agent 配置 | role/goal/backstory 人写 | — | `memory=True` 自动抽事实 | — | 任务边界自动 | 无终端卡 | 额外 LLM + 嵌入 |
| AutoGPT Classic | 启动参数里的约束 | `--ai-role` | 插件 | 历史与文件 | 连续模式去掉逐步确认 | 模型自选下一步 | 默逐步确认 | 连续模式不封顶则一直跑 |
| Copilot Studio | 制作者指令；refinements 只是建议 | — | 计划中的技能建议 | 每用户私有，制作者看不见 | 制作者发布副本 | 记忆自动；改进由制作者收 | 门户可删；改进要测试发布 | 28 天；workflow 用来省模型 |
| Gemini 应用 | Skills 取代 Gems | — | 人建，或对话里让 Gemini 建 | 帮助页未把自写人设当技能 | — | 人；匹配时可自动选用 | Skills 页可改 | 订阅档 |
| **KepCup** | 宿主每回合重拼，Bot 不能改 | 白名单 + 审批卡；访谈期 `save_profile` 直写 | `create_skill` 登记后沙箱通过即启用；`install_skill` 要卡 | `remember` 人话；反思写 lesson / 画像提案 | 平台规则是代码常量 | 人设：人要求；记忆/技能：人话或反思 | 人设卡；安装卡；自建技能无卡 | 反思与技能生成是后台模型 |

研究框架（不与上表混为竞品）：

| 框架 | 改什么 | 谁发起 | 闸 | 和产品的距离 |
|---|---|---|---|---|
| Harness² | 整份执行 harness（提示、技能、脚本、编排） | 每道基准题自动 Propose–Probe–Compose | 无用户；无真值，只比行为 | 研究代码。多倍任务费用。不引进 |
| DSPy / GEPA | 离线编译提示和 few-shot | 开发者拿训练集跑 | 指标；GEPA 有调用预算 | 可作离线实验，不是对话功能 |
| Reflexion | 失败教训句子 | 一次尝试失败后 | 要可判定成败 | 形态接近 `lesson`，没有产品壳 |
| Voyager | 通过环境验证的代码技能 | 自动课程 | 仿真自检，无人审 | 技能文件 + 沙箱验证已被各产品采纳；自动课程没有 |

---

## 7. KepCup 现状

以下全部对着当前仓库。设计文和实现不一致的地方以代码为准，并注明设计原文。

### 7.1 平台提示：宿主重拼，Bot 不能改

`packages/core/src/agent/context/system-prompt.ts` 里 `PLATFORM_RULES` 与 `TURN_PLATFORM_RULES` 是代码常量。`buildSystemPrompt` 每次从 Bot 档案、画像、技能名、工作目录等 **重新拼** `<platform_rules>`（约 592–623 行：先拷贝常量，再按本回合有没有连接、邮件、设置、工作台等工具追加条款）。没有工具能改这段文本，也没有把模型输出写回规则文件的路径。

这和 Claude Code 的「CLAUDE.md 是用户消息、系统提示另计」、Copilot / Cursor 的「平台提示不开放给模型」同一侧。

### 7.2 Profile：白名单 + 人批准；设置目录只给摘要

`propose_profile_change` 的字段白名单在 `packages/core/src/tools/memory-tools.ts` 的 `PROFILE_CHANGE_FIELDS`：

- `identity.bio`
- `persona.personality` / `tone` / `style` / `values` / `sample_dialogues`
- `role.expertise` / `role.responsibilities`

不含名字、边界数组、运行时、模型。对话轮提交后立刻返回，决定经 `profile_change_result` 再唤醒（DEV-014）；任务里阻塞到用户点卡。

平台规则的措辞是被动的。任务版与对话版都是「**用户可以要求你**更新你自己的 Profile……用 `propose_profile_change`」（`system-prompt.ts` 约 310、367 行）。没有「发现用户在纠正你就主动提议」的条款。

设置目录 `bot.identity`（`packages/shared/src/settings-catalog/items.ts`）的 `write` 是 `viaTool('propose_profile_change')`，`store.kind` 为 `none`。适配器 `botIdentityAdapter`（`packages/core/src/settings/adapters.ts`）的 `read` 只返回人设是否填过，外加 sha256 digest，**不把人设原文放进 Bot 可读快照**。`settings_change` 对 `via` 专门工具的项会拒绝或改道（`docs/dev/04-agent-runtime.md` 工具表）。因此身份不能靠 `settings_change` 直写。

无人值守的例外要单独记住：`packages/core/src/permissions/approvals.ts` 的 `NEVER_AUTO_DECIDED` 只有 `butler_proposal`、`mail_send`、`bot_handover`。`profile_change` 不在其中，无人值守打开时会走自动批准。

### 7.3 记忆工具与反思

- `remember`：描述写明「用户明确要求记住时使用」（`memory-tools.ts`）。关于用户的事实会生成画像提案，由画像整理统一处理；敏感类即使用户要求记住也只留私有记忆。
- `forget`：用户要求忘掉时，Bot 自己的记忆立即撤回；画像条目提交撤回提案并触发整理。
- `memory_feedback`：规则写「发现记忆错误时调用」。
- 反思 loop（`packages/core/src/memory/reflection.ts`）在后台跑，提示词要求提交 `memories`、`profileProposals`、`wikiSuggestions`、`skillSuggestion`。`memories.kind` 含 `lesson` 与 `self_note`。缺 `confidence` 的条目丢弃；推断且无证据的记忆丢弃。`profileProposals` 进的是 **共享用户画像** 的提案队列，不是 Bot 人设白名单。画像整理是全局唯一写入者，冲突时明确说过的优先于推断、新的优先于旧的；无法判断则保留两条，并给来源 Bot 写 `self_note`（`profile-curation.ts`）。用户在「Bot 大脑」可查看和改（`docs/design/04-memory.md`）。
- 登记时机（设计 04，D75）：任务结算即时登记；纯对话按 `reflection_debounce` 合并，默认 10 分钟或窗口内 6 轮。用量记在 `loopType: 'reflection'`。

反思 **不会** 提议修改 `persona.*`。用户画像的写入不经过 `profile_change` 卡。

### 7.4 技能

- 设计 `docs/design/05-wiki-and-skills.md`：反思发现同类任务成功 2～3 次，或用户说「以后都这样做」→ 草稿 → 沙箱 → 通过后自动启用，并在对话中告知；用户可停用。
- `create_skill`（`packages/core/src/tools/index.ts`）只 **登记** `skill_authoring` 作业，对话轮保留（DEV-013）。描述把触发说成用户那句「以后都这样做」。
- `SKILL_AUTHOR_REPEAT_THRESHOLD = 2`（`packages/shared/src/constants.ts`）在阶段文档里被说成「由反思根据执行摘要判断」。反思提示词（`reflection.ts` 的 `REFLECTION_PROMPT`）**没有** 提到次数，入队处只要模型给出 `skillSuggestion` 就写入 `skill_suggestion` 作业。常量目前没有被执行路径读取。作者注释写「反思已经检查过门槛」，代码没有这道检查。
- 生成 loop（`packages/core/src/skills/authoring.ts`）用主模型或已打开的后台外部引擎，在草稿目录写技能，做 frontmatter、语法和沙箱测试。通过则 `promoteAuthored` + `activateAuthored`。**不向对话播报**（注释援引 `design/01-conversation.md` 的消息原则）；面板靠 `skills.changed`。这和 design/05「在对话中告知」不一致，以代码为准。失败保留草稿和 `validation-reason.txt`，不打扰用户。
- `install_skill` 不同：预置走阻塞 `skill_preset`，外部仓库走 `skill_import` 扫描卡（`docs/design/22-file-skill-routing.md`）。无人值守下这两类按既有规则可自动批准。

自建技能因此是：用户一句话或反思一次非空建议 → 后台写脚本 → 沙箱过了就启用，中间没有批准卡。

### 7.5 初始化：`save_profile`

`packages/core/src/tools/setup-tools.ts`：只在 `setup_state = 'interviewing'` 注册。访谈里写入是这次创建的目的，**直接生效**，字段为 `identity.name` 加上 `PROFILE_CHANGE_FIELDS`。提示要求只写用户说过的内容。

`system-prompt.ts` 的访谈段：单聊用 3～5 个 `ask_question` 把空人设填上。项目组里不发问卷，空着的简介、擅长、职责按用户在组里点名下达的指令用 `save_profile` 补。管家变体 **不注册** `save_profile`（固定模板，以 `propose_bots` 收尾）。

### 7.6 D93 不是 Harness²

`docs/design/43-task-loop-harness.md`（D93，2026-10-21 已实施）：内置任务的上下文压缩、`update_plan`、软预算、空转检测、无活动看门狗、可配置墙钟。决策 D93-7 写明不改变任务状态机、审批和外部智能体语义。它让长任务更稳，**不**改提示策略，也没有 Propose–Probe–Compose。

### 7.7 OpenMind 不是 Bot 功能

`README.zh-CN.md` 把 OpenMind 定义成开放思考（意图、难题、模块如何咬合），供别人用编程模型重做或折进自己的产品。`apps/website/docs/official-site-design.md` 写明：OpenMind 是叙事层，**不是** 应用内的 Bot 功能。仓库里没有 OpenMind 进化开关、工具或记忆类型。

---

## 8. 差距

和上面那些已经发货的做法比，KepCup 的位置是：

**能力。** 记忆分层、反思、画像冲突、技能文件、沙箱验证都有了，和 Claude 的笔记、Devin 的技能、Voyager 的「没跑过别入库」同向。没有的是：Copilot 那种「用之前对一下出处」、Devin Dreaming / OpenClaw 那种「给人看、不注入」的整理报告、以及任何离线的提示/技能对照实验。平台提示保持宿主所有，这和头部产品一致，不是缺口。

**引导。** 头部产品会在两种时刻自己动笔：Claude / Devin / Codex / Grok Build 把纠正和约定写成笔记；Devin / Cursor 在人要求时把流程写成技能或规则。KepCup 的平台规则只教 Bot「等用户要求再改 Profile」。反思能写用户画像和 `lesson`，不能提议改 `persona.*`。技能门槛写在常量里，模型可以在一轮反思里就交出 `skillSuggestion`。

**审批。** 人设卡和安装卡是对的，接近 Devin 的「知识要保存、技能要 PR」，也接近 Copilot Studio 尚未默认开启的「制作者发布副本」。偏松的是自建技能：外部安装有卡，自己生成的脚本沙箱一过就启用，而且不发消息。Letta 式的静默改 persona 不该学。无人值守会自动批准 `profile_change`；若以后让反思多发人设卡，这个口子会把「建议」变成「静默写」。

**离线评测。** Harness²、DSPy/GEPA、Reflexion 的可取部分都是「同一输入、改一处、再量一次」。KepCup 已有记忆评测草案（[2026-10-22-memory-eval-datasets-local.md](./2026-10-22-memory-eval-datasets-local.md)）的 L0–L3，全部本机、不上 CI。仓库里还没有把「一条 lesson / 一份技能」放进这种对照的作业。

---

## 9. 建议（P0 / P1 / P2）

### P0 — 收紧已经半开的口，仍用现有工具

1. **技能建议的次数用代码算。** 在入队 `skill_suggestion` 之前读取 `SKILL_AUTHOR_REPEAT_THRESHOLD`（现为 2），按 Bot 的执行摘要计数。反思提示里写明不够次数就交 `null`。用户亲口说「以后都这样做」仍走 `create_skill`，不受这道门槛影响。
2. **人设仍只走卡，但规则允许主动提议。** 在 `TURN_PLATFORM_RULES` / `PLATFORM_RULES` 加一条：用户纠正了语气、职责或专长时，用 `propose_profile_change` 提议，说明原话依据；没纠正就不要改。不要新增改 `<platform_rules>` 的工具。
3. **先决定无人值守。** 若 P0.2 会让卡片变多，把 `profile_change` 放进 `NEVER_AUTO_DECIDED`，或在无人值守摘要里把人设自动批准单独列出来。否则「必须用户批准」在无人值守下不成立。

### P1 — 向已发货产品借交互，不借优化器

1. **反思产生的技能停在 draft。** `create_skill`（用户意图）保持沙箱通过后启用。`skill_suggestion`（模型意图）通过验证后停在 draft，技能面板可启用。这样和 `install_skill` 的授权方向一致，也不违反「自创完成不往对话里播报」。
2. **lesson 带日期和证据，注入时让模型核对。** 反思已经要求 `evidenceMessageIds`。注入的 `lesson` 带上写入时间和证据 id；过一段时间的条目按「可能过时」处理，与现有「记忆可能已过时，关键决定前向用户确认」同一句规则。这是 Copilot「引用不对就不用」和 Claude「笔记带 `modified`」的桌面版，不做分支级代码核对（KepCup 的 lesson 多半不是代码事实）。
3. **离线对照，挂在现有 mem-bench 上。** 用 L1/L2 的固定题（或一小套人造任务夹具）比较「加一条技能 / 改反思提示的一个句子」前后的检索或问答结果。一次只改一处，结果写 `.bench/`，不上 CI。这是 Harness² 的对照思想，费用是两次本机作业，不是每条用户任务四次执行。GEPA/DSPy 只允许出现在这个本机脚本里，作为可选优化器，产物仍是人看的 diff。

### P2 — 有余力再做

1. **整理报告不进提示。** 每日 consolidation 之外，写一份只在「Bot 大脑」可见的整理摘要（学 OpenClaw 的 `DREAMS.md`、Devin 的 Dreaming 记录）。不注入模型。
2. **规则文件不新开一套。** 团队共享的编码约定继续走技能和人设卡。不为了像 Cursor 而加第二份「Bot 可写的 AGENTS.md」。平台规则保持代码。

### 明确不做

- 不把 Harness² 嵌进任务 loop，不把它的执行器栈引进产品，不在线对同一用户任务跑多遍来改 harness。
- 不让 Bot 改 `PLATFORM_RULES`、组织级策略或无人值守底线的代码。
- 不学 Letta 默认的静默 `core_memory_replace` 改 persona，不学 AutoGPT `--continuous` 的自我下一步。
- 不把 TextGrad、APE、OPRO 做成功能；没有面向终端用户的产品形态。
- 不把 OpenMind 做成应用内开关。它仍然是仓库叙事，不是进化模块。
- 不把编码底座放进对外的竞品表。

---

## 10. 来源

检索日均为 2026-10-23。论坛与 Message Center 的状态以页面原文日期为准。

### 编程 Agent

- Cursor Rules：https://cursor.com/docs/rules
- Cursor Agent Skills：https://cursor.com/docs/skills
- Cursor customizing agents：https://cursor.com/learn/customizing-agents
- Cursor changelog 1.2 Memories GA：https://cursor.com/changelog/1-2
- Cursor Memories 界面变更（员工回复，2025-11-24、2026-01）：https://forum.cursor.com/t/memories-not-showing/143820 ，https://forum.cursor.com/t/cant-clear-memories/148254
- Cursor Agent SDK self-improvement：https://cursor.com/docs/agent-sdk/guides/improve
- Cursor hillclimbing：https://cursor.com/docs/agent-sdk/hillclimbing
- Claude Code memory：https://code.claude.com/docs/en/memory
- Claude Code power user tips：https://support.claude.com/en/articles/14554000-claude-code-power-user-tips
- Claude Agent Skills：https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Anthropic computer use（2024-10-22）：https://www.anthropic.com/news/developing-computer-use
- Codex customization：https://developers.openai.com/codex/concepts/customization
- Codex AGENTS.md：https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Codex memories：https://developers.openai.com/codex/customization/memories
- Codex config reference：https://developers.openai.com/codex/config-reference
- Codex `/learn` RFC（未落地）：https://github.com/openai/codex/issues/40575
- GitHub Copilot Memory：https://docs.github.com/en/copilot/concepts/agents/copilot-memory
- Copilot memory 工程博客：https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/
- Copilot Memory 默认开启（2026-03-04）：https://github.blog/changelog/2026-03-04-copilot-memory-now-on-by-default-for-pro-and-pro-users-in-public-preview/
- Devin Knowledge：https://docs.devin.ai/product-guides/knowledge
- Devin Skills：https://docs.devin.ai/product-guides/skills
- Devin Memory：https://docs.devin.ai/product-guides/memory
- Devin Memory and Dreaming 博客（2026-10-05）：https://devin.ai/blog/memory-and-dreaming
- Windsurf Memories & Rules：https://docs.windsurf.com/windsurf/cascade/memories
- Cline Memory Bank：https://docs.cline.bot/best-practices/memory-bank
- Cline Rules：https://docs.cline.bot/customization/cline-rules
- Continue Rules：https://docs.continue.dev/customize/deep-dives/rules

### 个人 / 桌面

- Grok Bot 概述：https://docs.x.ai/grok-bot/overview
- Designing Grok Bot：https://x.ai/news/designing-grok-bot
- Grok Bot 工作方式（同文镜像）：https://cursor.com/docs/grok-bot/work
- Grok Build memory（2026-09-16）：https://x.ai/news/grok-build-memory
- OpenClaw memory architecture：https://docs.openclaw.ai/concepts/memory-architecture
- openclaw-memgpt：https://github.com/xltvy/openclaw-memgpt
- Letta memory blocks：https://www.letta.com/blog/memory-blocks/
- Letta MemGPT 系统提示：https://github.com/letta-ai/letta/blob/main/letta/prompts/system_prompts/memgpt_v2_chat.py
- CrewAI Memory：https://docs.crewai.com/edge/en/concepts/memory
- AutoGPT Classic README：https://github.com/Significant-Gravitas/AutoGPT/blob/master/classic/original_autogpt/README.md
- AutoGPT Classic 用法：https://agpt.co/docs/classic/setup/usage

### 研究与企业

- Harness² 仓库：https://github.com/google-research/harness2
- Harness² 论文：https://arxiv.org/abs/2610.14224
- GEPA：https://github.com/gepa-ai/gepa
- Reflexion：https://arxiv.org/abs/2303.11366
- Voyager 论文：https://arxiv.org/abs/2305.16291
- Voyager 代码：https://github.com/MineDojo/Voyager
- Copilot Studio Memory：https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-experience/memory-overview
- Copilot Studio 业务流程与 refinements 预告：https://www.microsoft.com/en-us/copilot/blog/copilot-studio/delegate-shared-business-processes-to-agents-that-are-more-persistent-and-proactive-with-microsoft-copilot-studio/
- Message Center RM570432：https://mc.merill.net/message/RM570432
- Gemini Skills 博客（2026-09-30）：https://blog.google/products-and-platforms/products/gemini/automate-tasks-with-skills/
- Gemini Skills 帮助：https://support.google.com/gemini/answer/17094296?co=GENIE.Platform%3DDesktop&hl=en
- Gemini at Work 2026：https://cloud.google.com/blog/products/ai-machine-learning/welcome-to-gemini-at-work-2026
- Gemini API 技能与更新缺口（2026-03-25）：https://developers.googleblog.com/en/closing-the-knowledge-gap-with-agent-skills/

### 本仓库

- `packages/core/src/agent/context/system-prompt.ts`
- `packages/core/src/tools/memory-tools.ts`
- `packages/core/src/tools/setup-tools.ts`
- `packages/core/src/tools/index.ts`（`create_skill`）
- `packages/core/src/memory/reflection.ts`
- `packages/core/src/memory/schemas.ts`
- `packages/core/src/skills/authoring.ts`
- `packages/core/src/settings/adapters.ts`（`botIdentityAdapter`）
- `packages/core/src/settings/contributions/bot.ts`
- `packages/core/src/permissions/approvals.ts`（`NEVER_AUTO_DECIDED`）
- `packages/shared/src/settings-catalog/items.ts`（`bot.identity`）
- `packages/shared/src/constants.ts`（`SKILL_AUTHOR_REPEAT_THRESHOLD`）
- `docs/design/04-memory.md`
- `docs/design/05-wiki-and-skills.md`
- `docs/design/43-task-loop-harness.md`
- `docs/reports/2026-10-22-memory-eval-datasets-local.md`
- `README.zh-CN.md`、`apps/website/docs/official-site-design.md`（OpenMind 叙事）
