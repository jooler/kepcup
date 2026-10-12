# 36 Wiki 多模态入库与派生血缘

用户会把 PDF、图片、视频、音频交给 Bot「学一下」。现有 Wiki 能把附件/文件字节落入 `raw/`，但维护 loop 对非文本几乎读不到内容；PDF 靠 MinerU 技能「人工导出再 enqueue」半闭环，**派生 Markdown 与原始文件没有一等公民血缘**。本篇给出完整、可靠的多模态入库方案：二进制原件存在 git 之外、可真删除；派生文本进 git 并与原件互链；派生由宿主在独立通道确定性执行、可断点续跑，缺环境时阻塞并引导而不是烧掉重试次数。决策：**D85**。

**状态：已定稿，待实施。** 调研与代码摸底：2026-10-12。产品拍板（同日）：P0 视频必须含关键帧；`file` 来源单源上限 **2GB**；MinerU **宿主派生**；`wiki_vec` 留 **P1**；设置提供「Wiki 媒体派生」总开关（默认开）。同日按代码审查修订（见修订记录）：二进制移出 git、按来源拆分上限、ASR 分片进 P0、派生拆为独立 job、按资产状态去重与续跑。

相关：D9 / [05](05-wiki-and-skills.md)（LLM Wiki）、D57 / [17](17-mineru-document-parsing.md)（MinerU）、D63 / [22](22-file-skill-routing.md)（文件技能路由）、D68 / [25](25-capability-tools.md)（`understand_image` / `transcribe_audio`）、D61 / [20](20-conversation-media.md)（附件）、D54 / [16](16-capability-models.md)（能力模型与 MediaService）、D13（环境安装审批）、P09。

## 决策

- **D85 Wiki 多模态入库与派生血缘**：
  1. **仍走 Karpathy 三层**：`raw/` 不可变源 + `pages/` 合成知识 + `SCHEMA.md` 规范。检索以 Wiki 页面为主，不以扁平 chunk RAG 替代维护 loop。
  2. **git 只存文本，二进制存仓外**：文本类原件（markdown / txt / json / csv / 抓取的 HTML）照旧进 `raw/`；**二进制原件（PDF/Office/图/音/视频）与关键帧图片一律进仓外内容存储 `wiki-store/`**，git 中只留资产清单（指针）与派生文本。删除资产 = 物理删除原件与图片，回滚不会把它们带回来。
  3. **派生层是一等公民**：每个原件一个资产（`assetId` 由 sha256 决定），派生文本（PDF→full.md、图→caption、音→transcript、视频→transcript+frames）写入 `raw/_derived/{assetId}/`，manifest 记录工具、模型、每个产出物的状态与 sha256。页面引用回溯到资产。
  4. **派生由宿主执行、与维护解耦**：新增 `wiki_derive` job，在**独立 derive 通道**（全局并发 1，不占 `BACKGROUND_LOOP_CONCURRENCY`）、**Bot 互斥锁之外**、**wiki 工作区之外的暂存目录**中运行；成功后登记 `wiki_ingest(asset)` 走现有维护 loop（锁内搬入派生文本 → 维护 → 提交）。Bot 技能路径（D57）仅用于对话中读原文，不是入库派生路径。
  5. **缺环境/缺能力 = 阻塞，不是失败**：缺 ffmpeg / MinerU / multimodal / asr 时资产进入 `blocked`（原因码），**不消耗 attempts**；以 internal 事件让 Bot 在对话里发起安装卡或能力设置卡，环境就绪后自动续跑。
  6. **按资产状态幂等、按产出物续跑**：同 sha256 且已 `maintained` 才整单跳过；其余状态从断点继续。应用重启只重跑未完成的产出物。
  7. **上限按来源拆分**：`file` ≤ **2GB**（流式复制 + 流式 hash）；附件维持 30MB（`MAX_ATTACHMENT_BYTES`）；URL 维持 10MB 且仅文本。音视频另设时长上限。
  8. **ASR 分片与关键帧都是 P0**：音视频经 ffmpeg 转码分段后逐段转写；关键帧用场景切换检测 + 上限，多帧合批 caption。
  9. **索引**：P0 继续 `wiki_fts`（页面）；P1 加 `wiki_vec`。原始二进制不向量化、不进 FTS。
  10. **「Wiki 媒体派生」总开关**：用户级设置，默认开。关闭时二进制资料只存原件 + 资产清单（`stored`，原因 `media_derive_disabled`），不派生、不维护；打开后可对已存资产「派生」。
  11. **费用与隐私显式化**：派生的每次能力模型调用记入 usage 并受 Bot 每日后台预算约束；开关说明明确列出会发往已配置能力模型（可能是云端）的资料类型。MinerU 上云仍须单独同意（D57）。
  12. **非目标（本期）**：GraphRAG / HippoRAG 整图替换；纯向量库；渲染进程/iframe 内解析；默认上传到第三方**解析**云；清洗 git 历史中的派生文本。

## 1 现状摸底（代码事实）

| 环节 | 现状（代码位置） | 缺口 / 风险 |
|---|---|---|
| 结构 | `bots/{id}/wiki/{SCHEMA,index,log,raw,pages}` + es-git（`wiki/init.ts`） | 无资产清单、无派生目录约定 |
| 提交 | `commitWikiTree` 用 `index.addAll(['.'])`（`wiki/git.ts`）：工作区一切进 git | 大二进制进 git → 磁盘翻倍、删不掉、回滚会复活；派生写到一半会被并发提交带走 |
| 入库入口 | `wiki_enqueue`：`attachment` / `url` / `file` → `wiki_ingest` job（`wiki/service.ts`） | 无「对已有资产重试」入口 |
| file 来源 | `readFileSync` 整读；**`mime` 写死 `text/plain`**（`wiki/ingest.ts`） | **现网 bug**：经 file 来源的 PDF/图片被 `inlineTextFor` 当文本解码，最多 2 万字乱码进提示词；整读不支持大文件 |
| 附件来源 | `MAX_ATTACHMENT_BYTES = 30MB`，上传整块进内存（`domain/attachments.ts`） | 大文件只能走 file 来源 |
| URL 来源 | 沙箱 curl，stdout 以 UTF-8 回传；含 NUL/非 UTF-8 即拒（`wiki/source.ts`）；HTML→md **覆盖** bytes | 二进制 URL 不可用；原始 HTML 丢失；stdout 传输不可能承载 GB 级 |
| 去重 | 文件名内嵌 hash12（48 bit）；「同 hash 且已提交」整单跳过 | 引入「只存不派生」后，已提交的原件将永远无法再派生 |
| 维护可读文本 | `inlineTextFor`：仅 text-like 或 URL converted；内联上限 `WIKI_SOURCE_INLINE_MAX_CHARS = 20k` | 长文档只能靠 read 工具翻，无策略 |
| 串行 | 整条 ingest 在 `wiki.runExclusively(botId)` 内 | 长派生会挡住同 Bot 的 lint、用户 rollback / deletePage RPC |
| 调度 | `BACKGROUND_LOOP_CONCURRENCY = 2`（全局）；启动时 `running` → `pending` 且 attempts+1；`JOB_MAX_ATTEMPTS = 3` | 长派生占满后台槽位饿死摘要/反思；关三次应用即终态失败 |
| 撤回 | wiki 侧**无**撤回级联代码；仅 ingest 时复核来源消息未撤回；`MessagesFacade.attachmentsFor` 声明未用 | 「扩展现有撤回逻辑」不成立，需新建删除路径 |
| ASR | `transcribeSpeech`：dashscope `qwen3-asr-flash` 同步接口，data URI 整段上传，超时 120s；工具层上限 20MB | 长音频必须分片 |
| 图片理解 | `understandImage`：URL/data URI，`images[]` 可多张；工具层上限 5MB；core 无图像处理库 | 手机原图/HEIC 需缩放转码 |
| 环境 | `env/catalog.ts` 有 uv / Python 等，**无 ffmpeg、无 mineru**；MinerU 目前由 Bot 在对话中 `uv tool install`（17 的 spike 未验证） | 宿主无法定位/安装 ffmpeg 与 MinerU；审批卡只存在于对话轮次，后台 job 无处弹 |
| PDF 文本 | core 无 PDF 提取依赖 | 降级路径需新增依赖 |
| 检索 | `wiki_fts`（FTS5，仅 `pages/`） | 无 wiki 向量 |

结论：**排队、git、FTS、维护 loop 可复用；需要新建的是「仓外原件存储 + 资产状态机 + 独立派生通道 + 环境阻塞引导」。**

## 2 业界对照（2026）

| 思路 | 代表 | 对 KepCup 的启示 |
|---|---|---|
| LLM Wiki（compiled KB） | Karpathy gist；*Retrieval as Reasoning via LLM-Wiki*（2026） | 保持 pages + 链接 + lint，不退回纯 chunk lookup |
| Wiki + raw chunks 双通道 | rag-swarm、LLM-WIKI-RAG | 合成页与源摘要并用；血缘用 hash |
| 多模态桌面 Wiki | pixillab/llm_wiki | PDF 本地/MinerU；图 caption + 回跳源；音视频先文本化 |
| 视频 RAG | Video-RAG / AdaVideoRAG / SceneRAG | **ASR + 关键帧 caption** 是实用主路径；关键帧按场景切换取而非均匀取 |
| 大文件版本化 | git-lfs / DVC | git 存指针、二进制存内容寻址仓 —— 本方案 `wiki-store/` 同构 |
| 血缘 | PROV-O 实践 | `source → activity(derive) → derived → page` |
| GraphRAG / HippoRAG / Mem0 | 学术与产品 | P2 可选增强；不换底座 |

## 3 目标架构

```
wiki_enqueue(attachment|file|url)
  │  （校验来源与上限，登记 wiki_ingest）
  ▼
wiki_ingest(source)                                   ── 锁外
  1. resolve：流式读取 + 流式 sha256 → assetId
  2. 资产已存在？ maintained → 跳过（追加 sources[]）
                  其它状态 → 从断点继续
  3. 文本类：原件进 raw/（git） → 直接进入第 6 步
     二进制：原件进 wiki-store/{assetId}/original（仓外）
  4. 开关关 → status=stored，锁内提交资产清单，结束
  5. 登记 wiki_derive(assetId)，本 job 结束
  ▼
wiki_derive(assetId)                                  ── derive 通道，锁外
  按 kind 逐个产出物派生到 wiki-store/{assetId}/staging/
  每步写 manifest；缺环境/能力 → blocked（不耗 attempts）
  全部成功 → status=derived → 登记 wiki_ingest(asset:assetId)
  ▼
wiki_ingest(asset)                                    ── Bot 锁内
  6. 搬入 raw/_derived/{assetId}/ + 写 raw/_assets/{assetId}.json
  7. 组装 ReadableBundle → 维护 loop → pages/
  8. commit + wiki_fts → status=maintained
```

### 3.1 存储布局

```text
bots/{id}/
  wiki/                                   # git 仓库（只含文本）
    SCHEMA.md  index.md  log.md
    pages/
    raw/
      20261012-abcdef123456-notes.md       # 文本类原件（沿用现有命名）
      20261012-aabbccddeeff-page.html      # URL 原始 HTML（不再覆盖）
      _assets/
        ast_3f9a….json                     # 资产清单快照（§3.2）
      _derived/
        ast_3f9a…/
          manifest.json                    # 派生清单
          full.md                          # PDF/Office 全文（或 HTML→md）
          caption.md                       # 图片描述 + OCR
          transcript.md                    # 音视频转写（带时间码）
          frames.md                        # 关键帧时间码 + caption
  wiki-store/                              # 仓外内容存储（不进 git）
    ast_3f9a…/
      original                             # 二进制原件（文件名/扩展名见清单）
      frames/000123.jpg                    # 关键帧（≤1280 边长）
      state.json                           # 资产实时状态（UI 读这里）
      staging/                             # 派生暂存（完成后搬入 wiki/raw/_derived）
```

- **为什么关键帧也在仓外**：图片是二进制，且可能含敏感画面；放仓外后删除即真删除，也不再需要「不提交 jpg」的 P1 选项。`frames.md` 中的 caption 是文本，进 git。
- `raw/_assets/`、`raw/_derived/` 对维护 loop **只读**（与 `raw/` 同权，现有 maintenance-tools 的写白名单天然拒绝）。
- `wiki-store/` 不在 wiki 根内，维护 loop 的文件工具碰不到；原件只经宿主派生器读取。
- **实时状态 vs 提交快照**：`wiki-store/{id}/state.json` 是实时状态（派生中、阻塞、失败都在这里，UI 读它）；`raw/_assets/{id}.json` 是锁内提交时写入的血缘快照。两者以 `assetId` 关联。
- **旧库兼容**：已存在的 `raw/` 文件（含历史上经 file 来源进入 git 的二进制）不迁移；首次 lint 或资产列表请求时惰性登记为 `storage: "git"` 的资产，状态 `maintained`。

### 3.2 资产清单（`raw/_assets/{assetId}.json` / `state.json` 同构）

```json
{
  "id": "ast_3f9a0c…",
  "sha256": "3f9a0c…（64 hex）",
  "kind": "document",
  "mime": "application/pdf",
  "fileName": "report.pdf",
  "bytes": 1234567,
  "storage": "store",
  "rawRelPath": null,
  "sources": [
    { "type": "attachment", "ref": "att_…", "conversationId": "cnv_…", "at": 1791… }
  ],
  "status": "maintained",
  "reason": null,
  "derive": { "tool": "mineru", "quality": "full" },
  "readable": ["raw/_derived/ast_3f9a0c…/full.md"],
  "createdAt": 1791…,
  "updatedAt": 1791…
}
```

- `assetId = "ast_" + sha256 前 24 位 hex`：同内容同资产，天然幂等；不再另造 ULID。去重以 sha256 为准，文件名里的 hash12 仅作旧命名兼容。
- `storage`：`"git"`（文本原件在 `rawRelPath`）或 `"store"`（原件在 `wiki-store/{id}/original`）。
- `sources[]`：同一份内容从多个来源进入时追加记录，不重复派生。
- `kind`：`text | html | document | image | audio | video`，由 §5.1 的 mime 嗅探决定。

**资产状态**

| status | 含义 | 下一步 |
|---|---|---|
| `stored` | 原件已存，未派生（开关关闭，`reason=media_derive_disabled`） | 用户「派生」→ `wiki_derive` |
| `deriving` | 派生进行中 / 排队中 | — |
| `blocked` | 缺环境或能力（`reason=env_missing:ffmpeg` / `env_missing:mineru` / `capability_missing:asr` / `capability_missing:multimodal` / `budget_exceeded`） | 条件满足后自动或手动续跑 |
| `derived` | 派生完成，待维护 | `wiki_ingest(asset)` |
| `maintained` | 已进入 pages 并提交 | 重复入库整单跳过 |
| `failed` | 派生步骤真实报错耗尽重试，或维护 loop 终态失败 | 手动「重试」 |

**派生清单 `manifest.json`**：`assetId`、`kind`、`steps[]`。每个 step：`name`（`extract_audio` / `asr_segment:{n}` / `keyframes` / `caption_batch:{n}` / `mineru` / `pdf_text` / `image_caption` / `html_md`）、`tool`、`model`（能力模型 id，可空）、`status`（`pending|running|succeeded|failed|skipped`）、`errorCount`、`lastError`、`startedAt` / `finishedAt`、`outputs[]`（相对路径 + sha256 + role：`full_text|caption|transcript|keyframe|frames_summary`）。`quality`：`full | degraded`（如 MinerU 不可用时的 PDF 文本降级）。

**血缘规则**

- 派生只有一层：所有产出物都属于原件资产，不登记为新资产；长文档切块只作维护临时上下文。
- 页面引用约定（写入 SCHEMA）：引用原件写 `[源：report.pdf](../raw/_assets/ast_….json)`；需要定位文本层时附加 `[全文](../raw/_derived/ast_…/full.md)`，MinerU 页/块定位符或音视频时间码写在脚注。UI 把指向 `_assets/*.json` 的链接渲染为资产卡片（打开原件 / 查看派生）。
- 文本类资产（`storage: "git"`）照旧可直接链 `../raw/{file}`。

### 3.3 管线与状态机

**job 划分**

| job | 运行位置 | 做什么 |
|---|---|---|
| `wiki_ingest`（来源：attachment / file / url） | 后台通道，锁外 resolve；仅「只存」或文本直通时进锁 | 解析来源、存原件、建资产；文本类直接进维护；二进制登记 `wiki_derive` |
| `wiki_derive`（assetId） | **derive 通道**：全局并发 1、不占 `BACKGROUND_LOOP_CONCURRENCY`、锁外 | 逐步派生到 staging，写 manifest；完成后登记 `wiki_ingest(asset)` |
| `wiki_ingest`（来源：`asset`，内部来源类型，不暴露给 `wiki_enqueue` 工具） | 后台通道，Bot 锁内 | 搬入派生文本 → 写资产快照 → 维护 loop → 提交 → FTS |

- **锁粒度**：Bot 互斥锁只覆盖「搬入 + 维护 + 提交」以及「只存」的小提交。派生期间该 Bot 的 lint、rollback、deletePage 不受影响。派生只写 `wiki-store/{id}/staging/`，不在 wiki 工作区内，不会被并发 `addAll` 带进提交。
- **dedupeKey**：`wiki_derive:{assetId}`、`wiki_ingest:asset:{assetId}`，同一资产同时只有一个待办。
- **断点续跑**：派生器按 manifest 逐步执行，跳过 `succeeded` 且产出物 sha256 吻合的步骤。应用重启导致的 attempts+1 对 `wiki_derive` 不作为失败依据：失败判定看**步骤** `errorCount`（每步上限 3），job 级 attempts 仅作兜底（上限放宽到 `JOB_MAX_ATTEMPTS` 的若干倍，实现常量）。
- **阻塞不耗重试**：派生器在执行前做依赖探测（ffmpeg / mineru 定位、能力模型已配置、Bot 当日预算）；不满足 → `blocked` + reason，job 以 `done` 结束（不是 `failed`）。
- **解除阻塞**：
  - 环境管理器安装成功（ffmpeg / mineru）→ 扫描该原因码下的 `blocked` 资产，重新登记 `wiki_derive`；
  - 能力模型配置变更 → 同上（`capability_missing:*`）；
  - `budget_exceeded` → 由 jobs runner 推迟到次日（现有 defer 机制），不进 `blocked`；
  - 用户在 UI 点「重试」。
- **通知 Bot**：首次进入 `blocked` 时投递 internal 事件 `wiki_derive_blocked`（同一资产同一原因只投一次）。Bot 用自己的话告诉用户缺什么，并在对话里发起环境安装卡（D13）或能力设置卡（D58）。终态 `failed` 沿用现有 `wiki_ingest_failed` 事件。无发起对话时回落到 Bot 私聊（现有先例）。
- **总开关关闭**：`wiki_ingest` 在第 4 步对二进制资产置 `stored`，锁内做一次只含资产快照的小提交（提交信息 `wiki: store asset {fileName}`，不跑维护 loop）。打开开关后，UI 提供「派生全部已存资产」批量入口；单个资产的「派生」同样可用。开关不自动回扫历史资产（避免一次性大额费用）。

## 4 按类型的派生策略

| kind | 判定 | 派生 | 可读视图 | 依赖 |
|---|---|---|---|---|
| `text` | text/*、json、csv、yaml、markdown | 不派生，原件进 `raw/` | 原文 | 无 |
| `html` | URL 抓取结果是 HTML | 原始 HTML 进 `raw/`；`html_md` → `_derived/full.md` | full.md | 现有 html-to-markdown |
| `document` | pdf / doc(x) / ppt(x) / xls(x) / epub | `mineru` → full.md（`quality=full`）。MinerU 不可用时：**仅 PDF** 可降级 `pdf_text`（`quality=degraded`）并照常维护，同时登记一次 `env_missing:mineru` 提示；Office/EPUB 无降级 → `blocked` | full.md | MinerU（宿主）；降级用新增 PDF 文本依赖 |
| `image` | png / jpg / webp / gif / heic… | 必要时 ffmpeg 缩放到 ≤1600 边长、转 jpeg（>5MB 或非 jpeg/png/webp）；`image_caption`（固定提示词：事实描述 + 全量 OCR） | caption.md | multimodal；大图/HEIC 需 ffmpeg |
| `audio` | audio/* | ffmpeg 转 16kHz 单声道并按 `WIKI_ASR_SEGMENT_SEC` 切段 → 逐段 `asr_segment:{n}` → 合并为带时间码的 transcript.md | transcript.md | asr + ffmpeg |
| `video` | video/* | 抽音轨→同音频流程；`keyframes`：场景切换检测（`select='gt(scene,T)'`）+ 最小间隔，取不足时均匀补齐，上限 `WIKI_KEYFRAME_MAX`；关键帧按 `WIKI_CAPTION_BATCH` 张一批 `caption_batch:{n}` → frames.md；无音轨/纯音乐时 transcript 为空，仍抽帧 | transcript ⊕ frames | asr + multimodal + ffmpeg |

**原则**

- 能结构化提取文本的容器（PDF/Office）→ 全文 Markdown；天然非文本（图/音/视）→ 模型转写/描述。不把像素或波形塞进 pages。
- ffmpeg 缺失时**不得**静默降级为「视频仅 ASR」或「跳过大图」：一律 `blocked: env_missing:ffmpeg`。
- MinerU 的 PDF 降级必须在 manifest 和源摘要页上标明 `degraded`，不得假装完整 OCR。

**上限与预算（实现常量，均在 `packages/shared` constants）**

| 常量 | 值 | 说明 |
|---|---|---|
| `WIKI_FILE_MAX_BYTES` | `2_000_000_000` | file 来源单源上限（替代原 `WIKI_SOURCE_MAX_BYTES` 对 file 的约束） |
| `MAX_ATTACHMENT_BYTES` | 30MB（不变） | 附件来源上限；更大的文件引导用户给路径 |
| `WIKI_URL_MAX_BYTES` | `10_000_000`（不变） | URL 来源上限，且仅文本 |
| `WIKI_MEDIA_MAX_DURATION_SEC` | 3 小时 | 音视频时长上限（ffprobe 读取），超出 `INVALID_INPUT` |
| `WIKI_ASR_SEGMENT_SEC` | 120 | 单段时长；以所配 ASR 模型限制为准可调小 |
| `WIKI_KEYFRAME_MAX` | 20 | 关键帧上限（可在 P1 按时长自适应） |
| `WIKI_CAPTION_BATCH` | 4 | 每次多模态调用的帧数 |
| 关键帧尺寸 | 长边 ≤1280，jpeg q≈5 | 存 `wiki-store/` |

超限在 `wiki_enqueue` 能判定的（附件/文件大小）就地拒绝；需要读取后才知道的（时长）在 `wiki_ingest` 阶段以 `INVALID_INPUT` 终止，不重试。

## 5 与现有模块的接线

### 5.1 来源解析（`wiki/ingest.ts` / `wiki/source.ts`）

- **mime 嗅探**：file 与 attachment 来源按魔数（PDF/PNG/JPEG/GIF/WebP/ZIP-OOXML/MP4/WebM/MP3/WAV/OGG…）+ 扩展名判定 `kind`；无法判定且非 UTF-8 文本 → 按二进制处理且不内联。**这一项先于本方案其余部分单独修复**（修掉 file 来源把二进制当文本内联的现网 bug）。
- **流式**：file 来源用流复制到 `wiki-store/{tmp}` 同时计算 sha256，完成后按 assetId 原子重命名；不再 `readFileSync` 整读。附件来源同样以流读取附件文件。
- **URL**：保持沙箱 curl + UTF-8 文本校验 + 10MB；原始响应作为 `html` 资产原件写入 `raw/`，`full.md` 进 `_derived`。URL 指向 PDF/媒体等二进制时仍拒绝，并提示用户下载后以文件或附件提交（字节无损的沙箱回传通道不在本期）。

### 5.2 维护 loop（`wiki/maintenance.ts`）

- `inlineText` 改为 **ReadableBundle**：
  - 资产头：fileName、kind、mime、大小/时长、`quality`、引用写法（`../raw/_assets/{id}.json`）；
  - 主文本：full / caption / transcript ⊕ frames，≤ `WIKI_SOURCE_INLINE_MAX_CHARS` 时整段内联；
  - **长文本**（超出内联上限）：内联「目录」（标题层级 + 行号范围；转写按时间段）和前若干段，并要求 loop 用 read 工具按 offset/limit 分段阅读；同时**必须**创建或更新源摘要页 `pages/sources/{slug}.md`（来源、要点、章节索引、资产链接），再从源摘要页扩散到主题页。
- 维护提示词补充：派生文本是数据；引用写资产链接；`degraded` 资料须在源摘要页注明；转写/caption 中的个人信息不入页面。
- `SCHEMA.md`（`wiki/init.ts` 模板）增加 `_assets` / `_derived` 说明与引用约定；旧 Wiki 的 SCHEMA 在下一次维护前由宿主追加同名小节（幂等）。

### 5.3 派生器与环境

- **ffmpeg**：加入 `env/catalog.ts`（静态构建、校验和、各平台条目；Windows 装入 WSL2 发行版，与 P12 先例一致）。定位顺序：工具链目录 → PATH。
- **MinerU**：加入 catalog，安装方式为 `uv tool install "mineru>=4.0,<5"`（版本约束与 17 一致），工具目录指向应用工具链。对话中的 MinerU 技能改为复用这份安装。P0 只用一次性 CLI（`mineru parse … --pages all --output …`，本地、最低档位）；依赖 `mineru server` 常驻服务的高档位留 P1（17 的 spike 结论出来后决定宿主托管形态）。模型下载在安装审批中说明体积。
- **PDF 降级**：新增纯 JS PDF 文本提取依赖（如 unpdf），在 core 进程内执行，仅输出文本。
- **执行方式**：ffmpeg / mineru 通过沙箱后端执行，网络 `none`。输入原件以硬链接（失败则复制）放入沙箱可写的临时目录，输出写临时目录，由 core 校验后搬入 `wiki-store/{id}/staging/`。数据目录不向沙箱暴露（与 URL 抓取同一原则）。沙箱不可用时 fail-closed → `blocked: env_missing:sandbox`。
- **MediaService**：复用 `understandImage` / `transcribeSpeech`，core 内置固定提示词。每次调用记入 usage（`loopType: 'wiki_derive'`，有费用信息记 cost，否则记调用次数），并计入 Bot 每日后台预算。

### 5.4 设置：「Wiki 媒体派生」总开关

- 位置：设置 → Wiki / 能力相关分区。文案「Wiki 媒体派生」；说明：开启后，交给 Bot 学习的 PDF/Office 由本机 MinerU 解析，**图片、音频、视频帧会发送到你配置的多模态 / 语音识别模型**（若为云端服务即会上传）；关闭后这些资料只保存原件，不会进入知识库，之后可随时手动派生。
- 默认 **开**；用户级（非按 Bot）；关闭立即作用于后续 `wiki_ingest`。
- 与能力模型配置独立：开着但未配 multimodal/asr → `blocked: capability_missing:*` 并引导配置，不静默跳过。

### 5.5 RPC、工具与 UX

- `wiki_enqueue` 工具参数不变（不提供让模型绕过开关的 `derive` 参数）。工具说明补充：附件 >30MB 时请用户提供文件路径（file 来源，≤2GB）；入库是后台的、可能需要较长时间。
- 新增 RPC：
  - `wiki.assets(botId)`：资产列表（读 `state.json`，含状态、原因、进度）；
  - `wiki.asset(botId, assetId)`：详情（manifest、派生文本路径）；
  - `wiki.openAssetOriginal(botId, assetId)`：用系统程序打开原件；
  - `wiki.retryAsset(botId, assetId)`、`wiki.deriveStored(botId)`（批量派生已存资产）；
  - `wiki.deleteAsset(botId, assetId)`（§6）。
- UI（P0 最小集）：Wiki 面板「资料」页签列出资产（状态、原因、重试、删除、打开原件）；页面中的资产链接渲染为卡片。
- 系统提示：即时理解用技能 / `understand_*`；沉淀用 `wiki_enqueue`（宿主派生）。

## 6 删除、回滚与保留

- **删除资产** `wiki.deleteAsset`（新建，Bot 锁内）：删除 `wiki-store/{id}/`（原件、关键帧、状态）、`raw/_derived/{id}/`、`raw/_assets/{id}.json`，以及文本类资产的 `raw/` 原件；在 log.md 追加记录、提交，然后登记 `wiki_lint` 清理悬空引用。进行中的 `wiki_derive` 在下一步开始前检测到资产被删即中止。
- **消息撤回**：core 目前没有消息撤回的写路径，只有 ingest 时的来源复核。将来接入撤回时，对「所有 `sources` 都已撤回」的资产调用同一删除函数；仍有其它来源的只移除对应 `sources` 条目。
- **已知局限**：派生文本（full.md / transcript / caption）与页面一样留在 git 历史中；原件与关键帧在仓外，删除后不可恢复。清洗 git 历史不在本期。
- **回滚**（`wiki.rollback`）：只作用于 git 仓库，不动 `wiki-store/`。回滚后清单快照在树中消失、但仓外仍存在的资产标为 `derived`（可重新维护）；快照存在、但仓外原件已删除的资产，在 UI 中显示「原件已删除」，lint 报告悬空引用。

## 7 检索

| 层级 | P0 | P1 | P2 |
|---|---|---|---|
| pages → wiki_fts | ✓ | ✓ | ✓ |
| pages → wiki_vec | — | ✓（同 memory 嵌入模型，换模重建） | ✓ |
| 源摘要页 | 长文本资产必建；其它由维护 loop 决定 | 每个派生成功的资产必建 | 实体图链接 |
| 原件 / 派生文本 | 不进索引（经页面间接可检索） | 同左 | 可选：派生文本分块作为第二检索通道 |

`wiki_lint` 增加检查：页面里的 `_assets` / `_derived` 链接是否仍存在；`degraded` 资产是否在源摘要页标注。

## 8 失败、重试与安全

- 可重试：网络/厂商临时错误、MinerU/ffmpeg 非零退出（按步骤 `errorCount`）。不可重试：超限、来源已撤回或删除、格式无法识别 → `failed`（`INVALID_INPUT`）。
- 阻塞不是失败：缺环境/能力/沙箱 → `blocked`，见 §3.3。
- 派生输出以 `<untrusted>` 进入维护模型；资料内指令一律不执行（沿用 `neutralizeUntrusted`）。
- 凭据/PII：caption/ASR 提示词要求不复述凭据；维护提示词与 SCHEMA 双禁；run steps 照旧经 secrets 脱敏。
- MinerU 默认本地，`--remote` 上云须用户显式同意（D57），宿主派生永不自动上云。
- 能力模型调用的隐私依据见 §5.4 文案；本地能力模型同样适用。

## 9 分期

### P0-pre — 独立先修

1. file / attachment 来源 mime 嗅探；非文本不再内联（修现网 bug，不依赖本方案其它部分）。

### P0 — 可靠闭环

1. 存储：`wiki-store/` 仓外原件与关键帧；`raw/_assets` 快照；`state.json` 实时状态；旧 raw 惰性登记。
2. 来源：流式复制 + sha256；按来源拆分上限常量（file 2GB / 附件 30MB / URL 10MB 文本）；URL 保留原始 HTML；时长上限。
3. 状态机：`wiki_derive` job + derive 通道（全局并发 1）；锁外派生、锁内搬入/维护/提交；按资产状态去重；按步骤续跑；`blocked` 不耗 attempts 与自动解除；内部 `asset` 来源。
4. 派生器：MinerU（一次性 CLI）+ PDF 降级；图片（缩放 + caption）；音频（转码分段 ASR）；视频（ASR 分段 + 场景关键帧 + 合批 caption）。
5. 环境：catalog 增 ffmpeg / mineru；沙箱执行与临时目录交接；`wiki_derive_blocked` 事件与对话内安装/设置引导。
6. 费用：派生调用记 usage、受每日后台预算约束。
7. 设置「Wiki 媒体派生」（默认开、披露文案）；`stored` 与批量派生。
8. 维护：ReadableBundle、长文本目录 + 源摘要页、SCHEMA 引用约定。
9. 删除：`wiki.deleteAsset` 与 lint 联动；回滚后资产状态对齐。
10. RPC 与最小 UI（资料列表、状态、重试、删除、打开原件、资产链接卡片）。
11. 测试：见 §10；大文件边界用小夹具 + 注入常量测校验逻辑；ffmpeg/MinerU/MediaService 以假实现覆盖状态机，另有带真实 ffmpeg 的定向集成测试。

### P1 — 体验与检索

1. `wiki_vec` + `wiki_search` 可选混合检索。
2. MinerU 高档位（宿主托管 `mineru server`，依 17 spike 结论）。
3. 关键帧数按时长自适应；可选 OCR 专用步骤。
4. 资产面板打磨、批量进度、入库前费用/耗时预估。
5. 字节无损的 URL 二进制抓取。

### P2 — 增强（可选）

1. 每资产强制源摘要页、轻量实体建议。
2. 派生质量评分与换模再派生。
3. 派生文本作为第二检索通道；导出资产包；评估 GraphRAG 插件化（默认关）。
4. git 历史中派生文本的清洗工具。

## 10 验收标准

- **PDF**：用户提供 PDF 并说「学一下」→ 原件在 `wiki-store/`，`raw/_assets/{id}.json` 与 `raw/_derived/{id}/full.md` 已提交，`manifest.json` 记录 mineru；页面链接到资产；**原件不在 git 对象中**。MinerU 未装时 PDF 以 `degraded` 入库并收到一次安装引导；Office 文件进入 `blocked: env_missing:mineru`。
- **图片 / 音频**：分别产出 caption / 带时间码的 transcript；>5MB 图片被缩放后成功；缺 multimodal/asr → `blocked` + 设置引导，配置后自动续跑。
- **视频**：transcript（多段合并）+ `wiki-store/{id}/frames/*.jpg` + `frames.md` 均存在；10 分钟以上视频能完成（分段 ASR）；无 ffmpeg → `blocked: env_missing:ffmpeg`，不出现「仅 ASR」结果；安装 ffmpeg 后自动续跑。
- **续跑**：派生中途退出应用，重启后只重跑未完成步骤；连续退出三次资产不会变成 `failed`。
- **锁与通道**：视频派生进行中，同一 Bot 的 rollback / deletePage / lint 可正常执行；其它 Bot 的对话摘要与反思不被饿死。
- **去重**：同一文件重复 enqueue（含不同来源）只派生一次、只维护一次，`sources[]` 追加。
- **开关**：关闭时二进制资料为 `stored` 且已提交快照；打开后「派生」可完成全流程（不会被判为重复而跳过）。
- **上限**：file >2GB 拒绝；附件 >30MB 拒绝并引导给路径；URL 二进制拒绝；超时长音视频拒绝且不重试。
- **删除**：`wiki.deleteAsset` 后 `wiki-store/{id}` 与派生目录消失、lint 已登记；回滚到更早提交不会恢复原件。
- **费用**：派生调用出现在 usage 中；Bot 当日预算耗尽时派生推迟到次日。
- **回归**：纯 markdown / URL 入库不差于现网；MinerU 技能对话分页读取可用；`wiki_vec` 不在 P0 验收范围。
- 「`wiki_search` 能命中要点」作为 e2e 观察项（依赖模型质量），不作硬验收。

## 11 非目标（重申）

- 用扁平 RAG / Claude Projects 替换 LLM Wiki。
- 在渲染进程或 iframe 内跑解析 / Node / better-sqlite3。
- 默认把用户文件上传到第三方解析云。
- Bot 之间共享 Wiki 目录（D9）。
- 完整 GraphRAG 操作系统。
- P0 交付 `wiki_vec`。
- 清洗 git 历史；附件上传通道扩容到 GB 级。

## 修订记录

| 日期 | 变更 |
|---|---|
| 2026-10-12 | 初稿：现状摸底、业界对照、派生血缘架构、P0–P2。 |
| 2026-10-12 | 产品拍板并入正文：P0 视频必须关键帧；上限 2GB；宿主 MinerU；wiki_vec=P1；「Wiki 媒体派生」总开关默认开。 |
| 2026-10-12 | 按代码审查重写：二进制原件与关键帧移至仓外 `wiki-store/`（git 只存文本与清单，删除即真删）；上限按来源拆分（file 2GB / 附件 30MB / URL 10MB 文本）并改为流式；ASR 分片进 P0；新增 `wiki_derive` job 与独立 derive 通道，派生移出 Bot 锁；去重改为按资产状态（修复「只存后无法再派生」）；步骤级断点续跑；缺环境/能力改为 `blocked` 不耗 attempts，并补 ffmpeg/MinerU catalog 与对话内引导；派生费用计入 usage 与预算；开关文案披露云端上传；撤回级联改为新建 `wiki.deleteAsset`（现网无此逻辑）；关键帧改为场景检测 + 合批 caption；长文本目录 + 源摘要页策略；PDF 降级依赖与沙箱交接方式落地；file 来源 mime 误内联列为先修 bug。 |
