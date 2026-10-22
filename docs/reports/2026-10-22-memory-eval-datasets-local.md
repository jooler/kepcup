# 草案：记忆评测数据集本地接入（分级深度 / 不上 CI）

| 字段 | 内容 |
|---|---|
| 日期 | 2026-10-22（Asia/Shanghai） |
| 状态 | **草案**（非 design 权威；落地前需回写 `docs/design/04-memory.md` / `docs/dev/05-testing.md` 并留决策） |
| 范围 | 公开记忆评测语料如何在本机跑、按深度分级；**明确不进 GitHub Actions / 任何 CI** |
| 相关 | [2026-10-22-baibai-agent-long-term-memory.md](./2026-10-22-baibai-agent-long-term-memory.md)；`docs/design/04-memory.md`；`docs/dev/05-testing.md`；现有 `packages/core/test/benchmark/widget-craft.benchmark.test.ts`（`KEPCUP_BENCH_*` 门控范式） |
| 结论摘要 | 仓库**不内置**大语料。常规回归继续用 mock 记忆测试。公开集只做 **本机可选评测**：按 L0–L3 四级深度配数据集与跑法；默认跳过；结果落 `.bench/`（gitignore）；**CI 永不拉数据、永不跑这些用例**。 |

---

## 1. 原则（硬约束）

1. **不上 CI**：公开集下载、解析、LLM 打分、端到端摄入/检索断言，一律仅本机手动触发。不把数据集 URL、`KEPCUP_MEM_BENCH_*`、或「跑全量 oracle」写进 workflow。
2. **不污染日常测试**：默认 `describe.skipIf`（环境变量未设则跳过），与 widget-craft benchmark 同范式。`pnpm test` / CI 全量路径看不到失败。
3. **语料不进 git**：原始 JSON / HF 缓存放本机缓存目录（建议 `~/.cache/kepcup/mem-bench/` 或仓库外路径），仓库最多保留「映射脚本 + 极小金样（≤ 几条人造样例）」；大文件进 `.gitignore`。
4. **不替掉 mock 回归**：单元/集成记忆测试（`packages/core/test/{unit,integration}/*memory*`）仍是日常门禁；公开集只验证「真实长对话 / 知识更新 / 拒答」上的行为，补点状盲区。
5. **费用可控**：凡调用真实模型的级别，必须显式传模型与 key；默认只跑子集；结果写 JSON 便于对比，不强制「全绿才提交」。

---

## 2. 级别总览

| 级别 | 名称 | 目的 | 数据集 | 是否真模型 | 预计耗时 / 体积 | 何时跑 |
|---|---|---|---|---|---|---|
| **L0** | 契约 / 夹具 | 写入、supersede、检索、反思、consolidation 的结构正确性 | **无外部集**；现有 vitest + testkit mock | 否（mock） | 秒级；0 外网 | 日常开发 / 已在 CI 的常规测试 |
| **L1** | 烟测 | 适配层与摄入管道通不通；抽 10 题看召回/更新路径 | LongMemEval **oracle** 随机或固定 10 条 | 可选：无模型只测检索；有模型测端到端答对 | 分钟级；语料 ~15MB 一次下载 | 改记忆检索 / 画像更新后本机手跑 |
| **L2** | 标准评测 | 按题型看回归：知识更新、跨 session、abstention、时间推理 | LongMemEval **S cleaned** 的 **selected 子集**（建议每类 20–50，合计 ≤150）或 MemoryCraft-bench `selected` | 是（主模型；可选轻量反思模型） | 数十分钟–数小时；S 全量 ~277MB，子集可裁剪缓存 | 记忆大改或发版前本机；对比两次结果 JSON |
| **L3** | 深度 / 研究 | 压力与可比性：长上下文、多 session、可选 agent 轨迹 | LongMemEval **oracle 全量 500** 或 **S 全量**；LoCoMo（需角色改写）；可选 MemBench / MemoryAgentBench；**慎用** LongMemEval-V2 / M（体积大、场景偏轨迹） | 是 | 数小时–过夜；M ~2.7GB 不默认 | 主动研究或对照论文数字时；仍不上 CI |

**明确不做**：把 L1–L3 挂到 `release.yml` / `ci.yml`；在 CI runner 缓存 HF 数据集；用 CI 额度跑真实模型打分。

---

## 3. 数据集分配（按级别）

### 3.1 L0 — 无外部集（现状保留）

| 覆盖 | 位置（示意） |
|---|---|
| 生命周期 / 反思 / consolidation / 污染防护 | `packages/core/test/integration/memory*.test.ts` |
| 检索 / validate / store / embedder / 敏感话题 | `packages/core/test/unit/memory*.test.ts` |
| 模拟 LLM | `@kepcup/testkit` mock，不访问外网 |

**方案**：维持 `docs/dev/05-testing.md` 分层；记忆改动「先定向再全量」。本草案**不新增** L0 用例要求，只声明它与 L1+ 的边界。

### 3.2 L1 — LongMemEval oracle 烟测（首选入口）

| 项 | 建议 |
|---|---|
| 来源 | [LongMemEval](https://github.com/xiaowu0162/LongMemEval) / [HF longmemeval-cleaned](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)，**MIT** |
| 切片 | `oracle`（对话已裁到与题相关的 session，~15MB） |
| 规模 | 固定种子抽 **10 条**（或 `KEPCUP_MEM_BENCH_ONLY=id1,id2`） |
| 题型优先 | `knowledge-update`、`abstention`（对齐画像 supersede / 拒答）；其次 `multi-session` |
| 断言（两档） | **A 检索档**（无模型）：摄入后 FTS/向量 top-k 是否命中 oracle 证据句；**B 问答档**（真模型）：Bot 最终回答与参考答案的宽松匹配或 LLM-as-judge |
| 输出 | `.bench/mem-l1-<timestamp>.json`（题 id、命中、耗时、可选 token） |

### 3.3 L2 — 标准子集（按题型配额）

| 项 | 建议 |
|---|---|
| 来源 | LongMemEval **S cleaned**；或 [MemoryCraft-bench](https://huggingface.co/datasets/daven3/memorycraft-bench) 的统一 schema + `selected` |
| 配额（草案数字，可调） | knowledge-update 30 · multi-session 30 · temporal-reasoning 20 · abstention 20 · single-session-user / assistant / preference 各 10 → **合计 ~130** |
| 跑法 | 分题型报告准确率 / 召回命中率；失败题写入 `failures[]` 便于定点复跑 |
| 对照 | 同一 `KEPCUP_MEM_BENCH_MODEL` 下两次跑的 JSON diff；不要求与论文 SOTA 对齐 |
| 门控 | 仅本机；建议文档写「发版前可选」，**不是**发版 blocker |

### 3.4 L3 — 深度方案（按需选一，勿默认全开）

| 子方案 | 数据集 | 适配成本 | 用途 |
|---|---|---|---|
| **L3a** | LongMemEval oracle **全量 500** | 低（与 L1 同适配器） | 要完整题型覆盖与可引用总数时 |
| **L3b** | LongMemEval **S 全量** | 中（长 session 摄入、预算与 consolidation 压力） | 测「长历史下检索是否塌」 |
| **L3c** | [LoCoMo](https://github.com/snap-research/locomo) `data/locomo10.json` | 高（人–人对话 → 用户/Bot 轮次改写；事件摘要题） | 超长多 session；与论文对比时 |
| **L3d** | MemBench / MemoryAgentBench（或经 MemoryCraft） | 中高 | 事实+反思、增量多轮能力拆分 |
| **L3e** | [LongMemEval-V2](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2)（Apache-2.0） | 高（Web/企业 **agent 轨迹**，非纯聊天） | 仅当评 Bot 工具轨迹记忆时；**默认不做** |
| **不做默认** | LongMemEval **M**（~2.7GB） | 存储与时间成本过高 | 除非明确要「百万 token 级」压力 |

L3 仍遵守：本机、显式 env、结果进 `.bench/`、不上 CI。

---

## 4. 不同深度的测试方案（怎么跑）

### 4.1 统一门控（建议命名，实现时再定）

对齐 widget-craft，避免和 `KEPCUP_BENCH_*`（组件）混用：

| 变量 | 作用 |
|---|---|
| `KEPCUP_MEM_BENCH=1` | 打开记忆评测 suite（未设则全部 skip） |
| `KEPCUP_MEM_BENCH_LEVEL=L1\|L2\|L3a|…` | 选深度；缺省 `L1` |
| `KEPCUP_MEM_BENCH_DATA_DIR` | 本机语料根目录（默认 `~/.cache/kepcup/mem-bench`） |
| `KEPCUP_MEM_BENCH_ONLY` | 逗号分隔题 id / 题型过滤 |
| `KEPCUP_MEM_BENCH_MODEL` / `_API_KEY` / `_PROVIDER` | 真模型问答档；检索档可不设 |
| `KEPCUP_MEM_BENCH_MODE=retrieve\|qa\|both` | 默认 `retrieve`（便宜）；`qa` 才花 token |
| `KEPCUP_MEM_BENCH_OUT` | 结果 JSON 路径 |

示例（草案，命令以落地脚本为准）：

```bash
# L1 检索烟测（无真模型费用）
KEPCUP_MEM_BENCH=1 KEPCUP_MEM_BENCH_LEVEL=L1 KEPCUP_MEM_BENCH_MODE=retrieve \
  node scripts/run-tests.mjs run packages/core/test/benchmark/memory-eval

# L2 标准子集问答（真模型）
KEPCUP_MEM_BENCH=1 KEPCUP_MEM_BENCH_LEVEL=L2 KEPCUP_MEM_BENCH_MODE=qa \
  KEPCUP_MEM_BENCH_MODEL=… KEPCUP_MEM_BENCH_API_KEY=… \
  node scripts/run-tests.mjs run packages/core/test/benchmark/memory-eval
```

### 4.2 管道形态（各深度共用）

建议一条本机管道，深度只改「选多少题 / 哪份语料」：

```
下载或复用缓存
  → 规范化为 KepCup MemCase（id, sessions[], question, answer, evidence?, question_type）
  → 每题：干净 createTestHome → 按 session 写入对话 / 触发反思或显式 remember（策略可配置）
  → retrieve 模式：对 question 跑记忆检索，断言 evidence / 关键事实命中
  → qa 模式：发 question 给 Bot，记录回答；规则匹配或可选 judge
  → 汇总 JSON + 控制台摘要（按 question_type 分组）
```

**适配注意**（与 baibai 报告 P0/P1 对齐时可优先断言）：

- 知识更新题：旧事实应被 supersede，检索不应再把过期值当 top 证据。
- Abstention：无依据时应拒答 / 低置信，而不是幻觉编造。
- 硬事实：若实现了「画像强注入」，L2 可加一列「未检索也答对」对照。

### 4.3 深度方案 checklist

| 深度 | 准备 | 执行 | 成功标准（草案） |
|---|---|---|---|
| L0 | 无 | 定向 `*memory*` | 现有用例绿 |
| L1 | 首次下载 oracle 到 `DATA_DIR` | 10 题 retrieve；可选 3 题 qa | 适配器无抛错；retrieve 命中率有基线数字写入 JSON（不设硬阈值进 CI） |
| L2 | S 或 MemoryCraft selected 已缓存；定好配额种子 | 全子集 both 或分题型 | 输出分题型表；与上次 JSON 对比无「大面积回退」（人工看） |
| L3a/b | 磁盘与时间预算确认 | 过夜跑；可断点续跑（按 id 跳过已完成） | 全量报告；论文对比仅作参考 |
| L3c+ | 单独写改写/轨迹适配器 | 研究任务单次 | 文档记录适配偏差，避免和 L1/L2 数字混比 |

### 4.4 与现有 widget benchmark 的关系

| | Widget craft | Memory eval（本草案） |
|---|---|---|
| 门控 | `KEPCUP_BENCH_*` | `KEPCUP_MEM_BENCH_*`（建议分立） |
| 语料 | 仓库内 `fixtures/widget-briefs/briefs.json`（小） | 仓库外缓存；公开集 |
| CI | 跳过 | **跳过且禁止 workflow 引用** |
| 结果 | `.bench/widget-craft-*.json` | `.bench/mem-l*-*.json` |

---

## 5. 目录与工程落点（实现时，本草案不强制开写代码）

建议（可调整）：

```
~/.cache/kepcup/mem-bench/
  longmemeval/oracle/…
  longmemeval/s-cleaned/…
  memorycraft/…

packages/core/test/benchmark/
  memory-eval.benchmark.test.ts   # skipUnless env
  memory-eval/
    types.ts
    load-longmemeval.ts
    adapt-case.ts
    run-case.ts
    report.ts

scripts/mem-bench-fetch.mjs       # 可选：只负责下载/校验 checksum，便于本机准备
```

`.gitignore` 已有或应覆盖：`.bench/`、本地 `mem-bench` 缓存路径（若误放在仓库下）。

**下载**：本机一次 `huggingface-cli download` 或脚本；文档写清许可（LongMemEval MIT；V2 Apache-2.0）。不把 HF token 写进仓库。

---

## 6. 明确不在范围内

- 用公开集替换 L0 mock 测试。
- CI 缓存 / 定时跑 L1+。
- 默认下载 M 或 V2。
- 把评测准确率当作发版硬门禁（除非日后单独决策写入 design）。
- 把完整对话原文无截断地塞进模型上下文「冒充」记忆评测（与产品记忆路径脱节则不算本草案的评测）。

---

## 7. 建议落地顺序

1. **文档**：本报告评审通过后，在 `05-testing.md` 加一小节「本机记忆评测（不上 CI）」链到本文；必要时在 `04-memory.md` 加「评测」指针。
2. **L1 适配器 + 10 题 retrieve 烟测**（最小可运行）。
3. **L2 题型配额 + qa 模式**（真模型可选）。
4. **L3** 仅在有明确研究问题时开子方案，不预先实现全部适配器。

---

## 8. 待决（实现前可再定）

| 问题 | 备选 |
|---|---|
| Judge | 规则字符串包含 vs 轻量模型打分 vs 人工抽查 |
| 摄入方式 | 仅回放 user/assistant 消息触发反思，还是夹带 `remember` / 测试钩子直写 MemoryItem |
| 是否与 baibai 报告 P0（硬事实强注入）绑定同一套 L2 对照列 | 建议绑定，便于验证增强 |
| MemoryCraft vs 直接 LongMemEval | L1 直接 LongMemEval；L2 可切 MemoryCraft 减格式摩擦 |

---

*本稿为 reports 草案，供本机评测方案对齐；不修改 CI，不新增发版 blocker。*
