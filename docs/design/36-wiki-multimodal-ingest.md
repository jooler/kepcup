# 36 Wiki 多模态入库与派生血缘

用户会把 PDF、图片、视频、音频交给 Bot「学一下」。现有 Wiki 已能把附件/文件字节落入 `raw/`，但维护 loop 对非文本几乎读不到内容；PDF 靠 MinerU 技能「人工导出再 enqueue」半闭环，**派生 Markdown 与原始文件没有一等公民血缘**。本篇给出完整、可靠的多模态入库方案：派生产物必须保留并关联原始件；图片/音视频经多模态模型或 ASR 摘要后进 Wiki。决策：**D85**。

**状态：已定稿，待实施。** 调研与代码摸底日期：2026-10-12。产品拍板（同日）：P0 视频必须含关键帧；单源上限 **2GB**；MinerU **宿主派生**；`wiki_vec` 留 **P1**；设置提供「Wiki 媒体派生」总开关（默认开）。

相关：D9 / [05](05-wiki-and-skills.md)（LLM Wiki）、D57 / [17](17-mineru-document-parsing.md)（MinerU）、D63 / [22](22-file-skill-routing.md)（文件技能路由）、D68 / [25](25-capability-tools.md)（`understand_image` / `transcribe_audio`）、D61 / [20](20-conversation-media.md)（附件）、D54 / [16](16-capability-models.md)（能力模型与 MediaService）、P09。

## 决策

- **D85 Wiki 多模态入库与派生血缘**：
  1. **仍走 Karpathy 三层**：`raw/` 不可变源 + `pages/` 合成知识 + `SCHEMA.md` 规范。检索以 Wiki 页面为主（compiled knowledge），不以扁平 chunk RAG 替代维护 loop。
  2. **新增「派生」层（一等公民）**：在 `raw/` 旁引入 `raw/_assets/` 清单与派生文件；原始件与派生件（PDF→md、图→caption、音→transcript、视频→asr+keyframes 描述）**一并保留**，用稳定 id / sha256 / `derived_from` 互链。维护 loop 只读「可读文本视图」，但页面引用必须能回溯到原始件。
  3. **派生由宿主管线执行，不靠模型自觉**：ingest 在跑维护 loop **之前**按 mime 路由确定性派生（宿主调用 MinerU CLI、MediaService 的 multimodal / asr；视频抽轨/抽帧走本机 ffmpeg 工具链）。Bot 技能路径（D57）保留为对话中「读一下这页」的交互通道，**不是** Wiki 入库的派生路径。
  4. **索引**：P0 继续 `wiki_fts`（页面）；派生文本与源摘要写入页面后自然可检索。P1 为页面加 `wiki_vec`（与 `memory_vec` 同嵌入模型），不把原始二进制直接向量化。
  5. **缺能力时对话内引导**：派生需要 multimodal / asr / MinerU / ffmpeg 环境时，走既有 `SETUP_REQUIRED` / 环境审批；失败可重试，终态失败才通知 Bot。
  6. **「Wiki 媒体派生」总开关**：设置中提供主开关（默认 **开**）。关闭后：文本 / URL / 已是 Markdown 的资料仍可入库；PDF/Office/图/音/视频只落原件 + 资产清单，**跳过派生与维护合成**（或仅登记失败原因「用户关闭媒体派生」——实现取「落原件、跳过维护、可日后重试」），高级用户可关以省费用与时间。
  7. **非目标（本期）**：GraphRAG / HippoRAG 整图替换；把 Wiki 改成纯向量库；iframe/Node 内解析；云端默认上传用户文件（MinerU 上云仍须用户同意，同 D57）。

## 1 现状摸底（代码事实）

| 环节 | 现状 | 缺口 |
|---|---|---|
| 结构 | `bots/{id}/wiki/{SCHEMA,index,log,raw,pages}` + es-git | 无 `_assets` 清单、无派生目录约定 |
| 入库入口 | `wiki_enqueue`：`attachment` / `url` / `file` → `wiki_ingest` job | 不识别「需要派生」；file 来源 mime 写死 `text/plain` |
| 原始落盘 | `raw/{date}-{hash12}-{name}`，同 hash 且已提交则跳过 | 只存一份字节；URL 的 HTML→md **直接覆盖** bytes，原始 HTML 丢失 |
| 维护可读文本 | `inlineTextFor`：仅 text-like mime 或 URL `converted` | PDF/图/音/视频 → `null`，维护 loop 几乎只能「看见文件名」 |
| 文档解析 | 预置 MinerU 技能；Bot 导出 md 后再 `wiki_enqueue(file)` | 依赖模型自觉；PDF 与 md 无强制关联；零核心状态机 |
| 多模态工具 | `understand_image` / `transcribe_audio`（任务可用） | **明确不承担** Wiki 批量离线（25 原非目标）；无视频理解工具 |
| 检索 | `wiki_fts`（FTS5，页面） | 无 wiki 向量；raw 不进 FTS |
| 上限 | `WIKI_SOURCE_MAX_BYTES = 10MB`；job 最多 3 次 | 长视频/大 PDF 顶满；本决策改为 **2GB**（见 §4） |
| 技能阶梯 | D63 推荐 MinerU/pdf 等 | 与「自动派生」并行时需防重复劳动 |

结论：**基建（排队、串行、git、FTS、UI）可用；缺的是「二进制 → 可读派生 → 血缘 → 再维护」的确定性管线。**

## 2 业界对照（2026）

| 思路 | 代表 | 对 KepCup 的启示 |
|---|---|---|
| LLM Wiki（compiled KB） | Karpathy gist；arxiv *Retrieval as Reasoning via LLM-Wiki*（2026） | 保持 pages + 链接 + lint，不要退回纯 chunk lookup |
| Wiki + raw chunks 双通道 | rag-swarm、LLM-WIKI-RAG | 查询可同时用「合成页」与「源摘要」；血缘用 hash / transaction |
| 多模态桌面 Wiki | pixillab/llm_wiki | PDF 本地/MinerU；图 caption + 回跳源；音视频先文本化 |
| 视频 RAG | Video-RAG / AdaVideoRAG / SceneRAG | **ASR + 关键帧 caption（+ 可选 OCR）** 是实用主路径；P0 两者都要 |
| 血缘 | PROV-O 实践、治理型 RAG | `source → activity(derive) → derived → page`；回答可引用 raw 路径 |
| GraphRAG / HippoRAG / Mem0 | 学术与产品 | P2 可选增强；**不换底座** |

产品对照（模式层）：Obsidian = 人写 Wiki + 本地附件；Notion AI / Cursor 索引 ≈ 扁平 RAG；Claude Projects ≈ 会话内资料。KepCup 已选 LLM Wiki，应对齐 Karpathy + 补上多模态派生与血缘。

## 3 目标架构

```
wiki_enqueue(attachment|file|url)
        │
        ▼
┌─────────────────────────┐
│ wiki_ingest             │
│  1. resolve → 原始字节  │
│  2. 写入 raw/ 原件      │──► raw/2026…-hash-report.pdf
│  3. 登记 asset 清单     │──► raw/_assets/{assetId}.json
│  4. 若媒体派生开关开    │
│     derive（按 mime）   │──► raw/_derived/{assetId}/*.md|.json|.jpg
│  5. 组装 readable view  │
│  6. 维护 loop → pages/  │
│  7. commit + wiki_fts   │
└─────────────────────────┘
```

### 3.1 目录约定（兼容现有）

```text
wiki/
  SCHEMA.md
  index.md
  log.md
  pages/
  raw/
    20261012-abcdef123456-report.pdf          # 原件（append-only）
    20261012-aabbccddeeff-page.md             # 纯文本也可直接落此
    _assets/
      ast_01H….json                           # 资产元数据（清单，见 §3.2）
    _derived/
      ast_01H…/
        manifest.json                         # 派生清单（工具、模型、耗时、状态）
        full.md                               # PDF/Office 全文 Markdown（MinerU）
        caption.md                            # 图片描述
        transcript.md                         # 音频/视频 ASR
        frames/                               # 视频关键帧（P0 必须）
          000123.jpg
        frames.md                             # 帧时间码 + caption 汇总
```

- `_assets/`、`_derived/` 对维护 loop **只读**（与 `raw/` 同权）；不得手改。
- git：原件 + 派生 + 清单一并提交，保证回滚血缘不丢。P0 **提交**关键帧缩略图（单帧上限与张数见 §4）；P1 可增配置「只留 caption、不提交 jpg」以腾空间。
- 旧库无清单时：首次维护或 lint 可惰性补登记（按 raw 文件扫 hash）。

### 3.2 资产元数据（`_assets/{id}.json`）

```json
{
  "id": "ast_01H…",
  "sha256": "…",
  "rawRelPath": "raw/20261012-abcdef123456-report.pdf",
  "sourceType": "attachment",
  "sourceRef": "att_…",
  "fileName": "report.pdf",
  "mime": "application/pdf",
  "bytes": 1234567,
  "createdAt": 1791…,
  "kind": "document",
  "status": "derived",
  "derivedOf": null,
  "readableRelPath": "raw/_derived/ast_01H…/full.md",
  "error": null
}
```

派生清单 `manifest.json` 记录：`parentAssetId`、`tool`（`mineru` / `understand_image` / `transcribe_audio` / `ffmpeg+…`）、`model`（能力模型 id，可空）、`startedAt` / `finishedAt`、`outputs[]`（相对路径 + sha256 + role：`full_text` | `caption` | `transcript` | `keyframe`）、`status`：`pending|running|succeeded|failed|skipped`。

**血缘规则**

- 一切派生 `derivedOf = 原件 assetId`；禁止派生再派生超过一层（需要对 full.md 再切页时，切页结果只作维护临时上下文，不落第二层资产）。
- 页面引用约定（写入 SCHEMA）：优先链原件 `[源](../raw/…pdf)`，需要定位时附加派生 `[文本层](../raw/_derived/ast_…/full.md)`；MinerU 页/块定位符可写入页面脚注（同 17）。
- 撤回附件：删原件 raw + 对应 `_derived/` + `_assets` 记录，再 enqueue lint（扩展现有撤回逻辑）。

### 3.3 管线状态机

单次 `wiki_ingest` job 内顺序状态（写在 job progress / asset.status，可观测）：

```
resolve → store_raw → classify → [media_derive_off? skip_derive] → derive → maintain → commit_index
                ↘ skip_duplicate（同 hash 已提交）
derive 失败且可重试 → job pending（attempts++）
derive 失败耗尽 → failed + wiki_ingest_failed 通知
maintain 失败 → 同现网（保留 raw/派生，便于重试复用）
```

- **幂等**：同一 `sha256` 已 `commit` → 整单 skip（同现网）；若 raw 在、派生失败过 → **复用 raw，只重跑 derive+maintain**。
- **串行**：仍按 botId mutex（现 `wiki.runExclusively`）；派生耗时长不拆并行 Bot 内多 ingest（避免 git 冲突）；P2 可评估「派生并行、maintain 串行」。
- **总开关关闭**：`classify` 后对 `document|image|audio|video` 记 `status=skipped`（原因 `media_derive_disabled`），不跑维护合成；纯文本 / 已转换 URL markdown 仍走维护。用户日后打开开关可对 skipped 资产「重试派生」。

## 4 按类型的派生策略

| kind（mime/扩展名） | 策略 | 可读视图 | 依赖 |
|---|---|---|---|
| `text` / markdown / json / csv… | 不派生，inline 原文 | 原文 | 无 |
| `html`（URL） | 保留**原始 HTML 字节**到 raw，另写 `_derived/…/full.md` | full.md | 现有 html-to-markdown |
| `document`：pdf / 扫描件 / office / epub… | **宿主调用 MinerU** 导出 `full.md`；原件进 raw。MinerU 不可用时 P0 允许降级为本地 pdf 文本提取，manifest 标 `quality=degraded` | full.md | MinerU（宿主）或降级提取；上云需同意 |
| `image`：png/jpg/webp/gif… | `MediaService.understandImage` 固定提示词 → `caption.md`（事实描述 + OCR） | caption.md | capability `multimodal` |
| `audio` | `transcribeSpeech` → `transcript.md` | transcript.md | capability `asr` |
| `video` | **P0 必做**：ffmpeg 抽音轨 → ASR → `transcript.md`；按间隔抽关键帧（上限 N）→ 每帧 caption → `frames/` + `frames.md`；可读视图 = transcript ⊕ frames 摘要 | 二者拼接 | asr + multimodal + **ffmpeg 工具链** |

**何时全文抽取 vs 多模态摘要**

- **可结构化文本的容器（PDF/Office）→ 全文 Markdown**（宿主 MinerU），摘要由维护 loop 写入 pages。
- **天然非文本（图/音/视）→ 模型摘要/转写**；不把像素/波形塞进 pages。
- 图中有大量文字：caption 提示词明确要求 OCR；仍保留原图供重派生。
- 视频：**ASR 与关键帧 caption 并列**（产品拍板）；纯音乐/无对白时以视觉摘要为主，ASR 可为空但仍抽帧。

**大小与时长预算（已定）**

- 单源上限：`WIKI_SOURCE_MAX_BYTES` 从 10MB **提高到 2GB**（`2_000_000_000`；实现时改 `packages/shared` 常量并同步附件/校验文案）。超过则 `INVALID_INPUT`，不入队硬撑。
- 视频关键帧（P0）：默认每 6–10s 一帧，最多 **20** 帧；单帧边长上限 1280，jpeg 质量中等；帧文件进 git。
- 音频/视频 ASR：单次超时与 MediaService 一致；超长分片留 P1。
- 大文件磁盘：2GB 原件 + 派生可能显著占空间；UI 在 enqueue 前可提示预估；P1 再做「丢弃关键帧图、保留 md」选项。

## 5 与现有模块的接线

### 5.1 ingest / maintenance

- `resolveSource`：file 来源按扩展名 / sniff 填真实 mime（修 `text/plain` 写死）。
- URL：raw 存原始响应字节；markdown 进 `_derived`。
- `runWikiMaintenance` 的 `inlineText` 改为 **ReadableBundle**：元数据 + 主文本（full/caption/transcript）+ frames 摘要 + raw/derived 路径列表。
- 维护提示词：根据可读视图更新 pages；引用原件；派生作文本层；禁止写入用户个人信息。

### 5.2 MinerU（宿主派生，已定）

- core 经沙箱或受控 host exec 调 `mineru parse … --pages all --output …`；安装/模型下载走环境管理器审批（D13）。
- 对话分页读 PDF 仍用官方 Skill（D57）；与入库共享同一 MinerU 安装。
- 未装 MinerU：环境缺口引导安装；可短暂降级 pdf 文本并标 `degraded`，不得假装「已完整 OCR」。

### 5.3 MediaService 与 ffmpeg

- 复用 `understandImage` / `transcribeSpeech`；Wiki 派生用 **core 固定提示词**。
- 视频 P0 依赖本机 **ffmpeg**（工具链目录或 PATH 探测）；缺失时同环境安装审批，不得静默改成「仅 ASR」。
- 缺 multimodal/asr：asset 失败 + 原因码；用户触发场景可走 D58 设置卡（P1 打磨体验）。

### 5.4 设置：Wiki 媒体派生总开关（已定）

- 位置：设置 → 与 Wiki / 能力相关分区（或「高级」），文案 **「Wiki 媒体派生」**，说明关闭后 PDF/图/音/视频不会自动解析进知识库（仍可保存原件）。
- 默认：**开**。
- 存储：用户级 settings（非按 Bot）；关闭立即作用于后续 `wiki_ingest`；已 skipped 的资产可手动重试。
- 与能力模型配置独立：开关开着但未配 multimodal/asr → 仍失败并引导配置，而不是静默跳过。

### 5.5 工具与 UX

- `wiki_enqueue` 参数可不变；可选 `derive?: 'auto'|'skip'`（默认跟随总开关）。
- 响应 loop 仍只读。
- UI：资产详情看原件 / 派生 / 状态；失败「重试派生」；P0 测试覆盖视频帧。
- 系统提示：即时理解用技能 / `understand_*`；沉淀用 `wiki_enqueue`（宿主派生）。

## 6 检索与保留

| 层级 | P0 | P1 | P2 |
|---|---|---|---|
| pages → wiki_fts | ✓ | ✓ | ✓ |
| pages → wiki_vec | —（已定 P1） | ✓（同 memory 嵌入模型，换模重建） | ✓ |
| 源摘要页 | 维护 loop 可为大文档建 `pages/sources/…` | 强制每个成功派生建一页源摘要（含血缘） | 实体图链接 |
| raw 二进制 | 不进 FTS | 同左 | 同左 |
| 保留 | git 历史（含关键帧）；撤回删原件+派生 | 可选「丢弃关键帧图、保留 md」 | 归档冷存储 |

矛盾/过时：继续 `wiki_lint`；增检查「页面引用的 raw/_derived 是否仍存在」。

## 7 失败、重试与安全

- Job `attempts` 沿用 `JOB_MAX_ATTEMPTS`；派生临时错误可重试；`INVALID_INPUT`（超 2GB、撤回）不重试。
- 派生输出经 `<untrusted>` 进入维护模型；禁止执行资料内指令。
- 凭据/PII：派生提示词与 SCHEMA 双禁。
- MinerU 上云须显式同意（D57）；默认本地。
- 沙箱：mineru/ffmpeg 只写允许的 wiki `raw/_derived` 路径。

## 8 分期

### P0 — 可靠闭环（已定范围）

1. `_assets` / `_derived` 约定 + 清单读写；撤回级联。
2. ingest：真实 mime；HTML 保留原件；ReadableBundle；**`WIKI_SOURCE_MAX_BYTES = 2GB`**。
3. 派生路由：
   - document → **宿主 MinerU**（可 degraded 降级）；
   - image → caption；
   - audio → transcript；
   - **video → ASR + 关键帧 + frames.md**（依赖 ffmpeg；缺则失败引导，不做「仅 ASR」偷懒路径）。
4. 设置 **「Wiki 媒体派生」** 总开关（默认开）及 skipped/重试语义。
5. 维护提示词与 SCHEMA 血缘引用规范。
6. 测试：PDF / 图 / 音 / **视频（含帧）** 集成；开关关闭跳过；失败重试；同 hash skip；撤回清理派生；2GB 边界（可用较小夹具测校验逻辑）。
7. 文档：05 / 17 / 25 交叉引用已更新；实现时改 constants 与用户可见文案。

### P1 — 体验与检索

1. 长音频分片 ASR；关键帧「不提交 jpg」选项。
2. **`wiki_vec`** + `wiki_search` 可选混合检索。
3. UI 资产面板、缺能力设置卡打磨、批量进度条。
4. 派生费用/耗时统计（可选）。

### P2 — 增强（可选）

1. 源摘要页强制化、轻量实体建议。
2. 派生质量评分与换模再派生。
3. 导出资产包；评估 GraphRAG 插件化（默认关）。

## 9 验收标准

- 用户上传 PDF 并说「学一下」：原件在 `raw/`，宿主 MinerU 产出的 `full.md` 在 `_derived/`，清单互链；`wiki_search` 能命中要点；页面能链回 PDF。
- 上传图片 / 音频：分别有 caption / transcript；缺 multimodal/asr 时有明确失败与配置引导。
- **视频 P0**：`transcript.md` + `frames/` + `frames.md` 均存在；可读视图含音轨与关键帧描述；无 ffmpeg 时失败可理解，不得静默变成仅 ASR。
- 单源 **>2GB** 被拒绝；≤2GB 可入队（受磁盘与超时约束）。
- 「Wiki 媒体派生」关闭：媒体只落原件/清单并 skipped；打开后可重试派生。
- 同文件重复 enqueue 不双写；撤回后派生消失且 lint 排队。
- 回归：纯 markdown/URL 不差于现网；MinerU 技能对话分页读取仍可用；`wiki_vec` 不在 P0 验收范围。

## 10 非目标（重申）

- 用扁平 RAG / Claude Projects 替换 LLM Wiki。
- 在渲染进程或 iframe 内跑解析 / Node / better-sqlite3。
- 默认把用户文件上传到第三方解析云。
- Bot 之间共享 Wiki 目录（D9）。
- 完整 GraphRAG 操作系统。
- P0 交付 `wiki_vec`（已定 P1）。

## 修订记录

| 日期 | 变更 |
|---|---|
| 2026-10-12 | 初稿：现状摸底、业界对照、派生血缘架构、P0–P2。 |
| 2026-10-12 | 产品拍板并入正文：P0 视频必须关键帧；上限 2GB；宿主 MinerU；wiki_vec=P1；「Wiki 媒体派生」总开关默认开；删除「待确认」节。 |
