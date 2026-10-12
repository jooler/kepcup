# Wiki 多模态入库与派生血缘（D85）：实施方案

> 状态：**已定稿，待实施**（设计定稿与审查修订：2026-10-12）。设计依据 [docs/design/36-wiki-multimodal-ingest.md](../docs/design/36-wiki-multimodal-ingest.md)（下称「36」）；相关 05、17、22、25 已同步。
> 前置：[review-fixes-2026-10-12.md](review-fixes-2026-10-12.md) 的任务 1（mime 嗅探）与任务 2（媒体调用记账）。
> 分支 / worktree：建议 `t/d85-wiki-media` @ `/home/jyy/wt/kepcup-d85`。主工作树可能有其他会话的未提交改动，不在主树里做。
> **测试纪律**：开发中只跑定向测试，用 `node scripts/run-tests.mjs run <文件>`，在 `kepcup-test:trixie` 容器里跑；typecheck / lint 在宿主跑。改了 shared 契约或迁移时，收尾全量跑一次，对照基线（33 个环境性失败，含 es-git / wiki URL 相关项）。需要 ffmpeg / MinerU 的集成测试单独标记，没有工具链时跳过（参考现有沙箱自检类用例的跳过方式）。

## 0. 总览与顺序

本文的任务都是对现有 Wiki 入库的**增强**。按与现有代码的耦合度从高到低排列，也就是推荐的实施顺序：

| # | 任务 | 规模 | 依赖 |
|---|---|---|---|
| 1 | 资产模型与仓外存储 | M | 修正文档任务 1 |
| 2 | 来源上限拆分与流式读取 | S–M | 1 |
| 3 | URL 来源保留原始 HTML | S | 1 |
| 4 | 管线重构：`wiki_derive` job、derive 通道、锁粒度、断点续跑 | L | 1 |
| 5 | 维护输入：ReadableBundle、长文本策略、SCHEMA | M | 1 |
| 6 | 环境：ffmpeg / MinerU 进 catalog | M | — |
| 7 | 图片派生 | M | 4；缩放依赖 6 |
| 8 | 文档派生（MinerU + PDF 降级） | M | 4、6 |
| 9 | 阻塞态与对话内引导 | M | 4、6 |
| 10 | 音视频派生（分段 ASR + 关键帧） | L | 4、6 |
| 11 | 「Wiki 媒体派生」总开关与 `stored` | S–M | 1 |
| 12 | 派生记账与预算 | S | 修正文档任务 2、4 |
| 13 | 删除资产、回滚对齐、体检 | M | 1 |
| 14 | RPC 与最小 UI | M | 1、13 |
| 15 | 提示词纪律 ⓪（入库意图直接 `wiki_enqueue`） | S | **8 上线之后** |

可并行：6 与 1–5 并行；7 / 8 / 10 在 4 完成后可并行。

## 1. 现状（2026-10-12 读取，以代码为准）

| 位置 | 现状 |
|---|---|
| `packages/core/src/wiki/ingest.ts` | `runWikiIngestJob` 整条流程（resolve → 写 raw → 去重 → 维护 → 提交）都在 `wiki.runExclusively(botId)` 内；去重为「hash12 + 已提交即跳过」（`isRawCommitted`） |
| `packages/core/src/wiki/source.ts` | `rawFileName` = `YYYYMMDD-{hash12}-{name}`；URL 经沙箱 curl，stdout 以 UTF-8 回传，二进制拒绝 |
| `packages/core/src/wiki/git.ts` | `commitWikiTree` 用 `index.addAll(['.'])`，工作区一切进 git |
| `packages/core/src/wiki/maintenance.ts` | `inlineTextFor`；内联上限 `WIKI_SOURCE_INLINE_MAX_CHARS = 20_000`；提交后只对 `pages/` 增量更新 `wiki_fts` |
| `packages/core/src/wiki/maintenance-tools.ts` | 可读 wiki 根内任意文件；只能写 `pages/`、`index.md`、`log.md`；只能删 `pages/` |
| `packages/core/src/wiki/service.ts` | `enqueueIngest`（dedupeKey 按 ref）、`rollback`、`deletePage`、`reconcileFts` |
| `packages/core/src/dispatch/jobs-runner.ts` | 统一后台通道，`BACKGROUND_LOOP_CONCURRENCY = 2`；启动时 `running` → `pending` 且 attempts+1；`JOB_MAX_ATTEMPTS = 3` |
| `packages/core/src/domain/attachments.ts` | `MAX_ATTACHMENT_BYTES = 30_000_000`，`readBytes` 整读 |
| `packages/shared/src/constants.ts` | `WIKI_SOURCE_MAX_BYTES = 10_000_000` |
| `packages/core/src/media/` | `understandImage`（images 为 URL / data URI，可多张）；`transcribeSpeech`（dashscope `qwen3-asr-flash`，data URI 整段上传，超时 120s） |
| `packages/core/src/env/catalog.ts` | 有 uv / Python 等；**无 ffmpeg、无 mineru** |
| core 依赖 | 无 PDF 文本提取库、无图像处理库 |

## 2. 任务

### 任务 1 资产模型与仓外存储（36 §3.1–3.2）

- 新增 `infra/paths.ts`：`botWikiStoreDir(paths, botId)` → `bots/{id}/wiki-store/`（在 wiki git 根之外）。
- 新建 `wiki/assets.ts`：
  - `assetIdOf(sha256)` = `ast_` + 前 24 位 hex；
  - `readAssetState` / `writeAssetState`，读写 `wiki-store/{id}/state.json`，原子写（临时文件 + rename）；
  - `writeAssetSnapshot`：锁内写 `raw/_assets/{id}.json`，供提交；
  - `kind` 判定复用修正文档任务 1 的 `sniffSourceKind`。
- 存储规则：
  - 文本类（text / html）原件照旧进 `raw/`（`storage: "git"`）；
  - 二进制原件进 `wiki-store/{id}/original`（`storage: "store"`），文件名与扩展名记在清单中。
- 去重改为按资产状态（36 §3.2 状态表）：
  - `maintained` → 整单跳过，并在 `sources[]` 追加本次来源；
  - 其余状态 → 从断点继续。
  - `isRawCommitted` 保留，只用于旧库兼容判断。
- 旧库兼容：首次访问资产列表或首次 lint 时，扫描 `raw/` 下非下划线开头的文件，惰性登记为 `storage: "git"`、`status: "maintained"`。不迁移已在 git 中的二进制。
- 维护工具写白名单不变；确认 `raw/_assets`、`raw/_derived` 被现有规则判为只读（加单测）。
- 测试：assetId 稳定性、状态读写原子性、同内容不同来源只生成一个资产、旧库惰性登记。

### 任务 2 来源上限拆分与流式读取（36 §4、§5.1）

- `packages/shared/src/constants.ts`：
  - 新增 `WIKI_FILE_MAX_BYTES = 2_000_000_000`、`WIKI_URL_MAX_BYTES = 10_000_000`、`WIKI_MEDIA_MAX_DURATION_SEC = 10_800`；
  - `WIKI_SOURCE_MAX_BYTES` 废弃或改为指向 URL 上限，`source.ts` 的 curl `--max-filesize` 改用 URL 常量；
  - 附件仍受 `MAX_ATTACHMENT_BYTES`（30MB）约束。
- file 来源：
  - `fs.createReadStream` 边读边算 sha256，写入 `wiki-store/.tmp-{uuid}`，完成后 rename 到 `{assetId}/original`；
  - 若是文本类，再复制进 `raw/`。
- attachment 来源：附件文件同样以流读取（不再 `readBytes` 整读）。
- `enqueueIngest`：能就地判定的大小超限直接拒绝，并给出提示（附件 > 30MB 时引导用户提供文件路径）。
- 时长超限在派生阶段用 ffprobe 判定，结果为 `failed` + `INVALID_INPUT`，不重试。
- 测试：用注入的小常量测边界；流式 hash 与整读 hash 一致。

### 任务 3 URL 来源保留原始 HTML（36 §4）

- `resolveSource` 的 URL 分支：
  - 原始响应文本作为 `html` 资产原件写入 `raw/{date}-{hash}-{name}.html`；
  - `htmlToMarkdown` 结果写入 `raw/_derived/{id}/full.md`，`manifest.json` 中登记步骤 `html_md`。
  - 文本资产不走 `wiki_derive`，在 ingest 内同步完成。
- 回归：`test/integration/wiki-url.test.ts` 改为断言原 HTML 与 full.md 并存。

### 任务 4 管线重构（36 §3、§3.3）

- `JobType` 新增 `wiki_derive`；`wiki_ingest` 的 payload 支持内部来源 `{ sourceType: 'asset', ref: assetId }`（不暴露给 `wiki_enqueue` 工具）。
- `wiki_ingest`（外部来源）：
  - 锁外完成 resolve 和原件存储；
  - 文本类直接进锁维护；
  - 二进制类：开关关闭 → 在锁内做一次小提交（只含资产快照），状态置 `stored`；开关开启 → 登记 `wiki_derive`，dedupeKey 为 `wiki_derive:{assetId}`。
- `wiki_derive`：
  - **独立 derive 通道**：调度器新增一个全局并发为 1 的通道，不占 `BACKGROUND_LOOP_CONCURRENCY`；
  - 不持有 Bot 锁；
  - 按 manifest 逐步执行，产出写入 `wiki-store/{id}/staging/`；
  - 全部成功 → 状态置 `derived`，登记 `wiki_ingest(asset)`（dedupeKey 为 `wiki_ingest:asset:{id}`）。
- `wiki_ingest(asset)`，在锁内执行：
  - 把 staging 中的文本搬入 `raw/_derived/{id}/`（关键帧图片留在 `wiki-store/{id}/frames/`）；
  - 写入资产快照，然后维护、提交、更新 FTS，状态置 `maintained`。
- 断点续跑：
  - manifest 每步记录 `status`、`errorCount`、产出物 sha256；重跑时跳过已成功且 sha256 吻合的步骤；
  - 每步最多失败 3 次；
  - `wiki_derive` 的 job 级 attempts 上限放宽（新常量，例如 `WIKI_DERIVE_MAX_ATTEMPTS = 20`），启动重置导致的 attempts+1 不作为失败依据。
- 资产被删除后：派生器在每步开始前检查资产是否仍存在，不存在则中止。
- 测试（用假派生器，不依赖工具链）：
  - 派生期间同一 Bot 的 rollback / deletePage 不被阻塞；
  - 中途「重启」（重置 running）后只重跑未完成的步骤；
  - 派生写入不会被并发维护提交带进 git；
  - 同一资产并发登记只产生一个待办。

### 任务 5 维护输入（36 §5.2）

- `IngestLoopInput.inlineText` 改为 `bundle: ReadableBundle`，包含：
  - 资产头（fileName / kind / mime / 大小 / 时长 / `quality` / 引用写法）；
  - 主文本：full / caption / transcript ⊕ frames；
  - 长文本目录：按标题层级给出行号范围；转写按时间段切分。
- 主文本不超过内联上限时整段内联；超过时只内联目录与开头几段，并要求 loop 用 read 工具按 offset / limit 分段阅读，且**必须**创建或更新 `pages/sources/{slug}.md`。
- `wiki/init.ts` 的 SCHEMA 模板增加 `_assets` / `_derived` 说明与引用约定：`[源：x](../raw/_assets/{id}.json)`、`[全文](../raw/_derived/{id}/full.md)`。旧 Wiki 在下一次维护前由宿主幂等追加该小节。
- `MAINTENANCE_PROMPT` 补充：派生文本是数据；`degraded` 资料须在源摘要页注明；转写和描述中的个人信息不入页面。
- 测试：长文本资产的任务消息只含目录；SCHEMA 追加是幂等的。

### 任务 6 环境：ffmpeg / MinerU 进 catalog（36 §5.3，17）

- `env/catalog.ts` 新增 `ffmpeg`：各平台静态构建、sha256、`verify` 命令；Windows 装入 WSL2（参照 P12 先例）。
- 新增 `mineru` 条目，`install: { via: 'uv-tool', spec: 'mineru>=4.0,<5' }`，装到工具链目录，可能需要为 catalog 新增 `uv-tool` 安装类型。安装卡上说明模型下载体积。
- `env/doctor.ts` 的定位顺序：工具链目录 → PATH → `uv tool dir`（复用用户早期由 Bot 自行安装的 MinerU）。
- 工具链 bin 目录要暴露在 Bot 执行环境的 PATH 上，这样官方 MinerU Skill 探测到已安装就不会再自行安装（17）。
- 测试：catalog schema 校验；doctor 定位逻辑单测（伪造目录）。

### 任务 7 图片派生（36 §4）

- 派生器 `derive/image.ts`：
  - 文件 > 5MB，或格式不是 jpeg / png / webp（例如 HEIC）时，先用 ffmpeg 缩放到长边 ≤1600 并转 jpeg；
  - 调用 `media.understandImage`，使用 core 内置的固定提示词（客观描述 + 全量 OCR，不复述凭据），输出 `caption.md`。
- 缺 multimodal 能力 → 阻塞（任务 9）；需要缩放但缺 ffmpeg → `blocked: env_missing:ffmpeg`。
- 测试：用假 MediaService 断言提示词与输出；超大图触发缩放步骤。

### 任务 8 文档派生（36 §4，17）

- `derive/document.ts`：
  - MinerU 可用 → 通过沙箱后端执行 `mineru parse <in> --pages all --output <tmp>/full.md`（一次性 CLI、本地、网络 none），`quality=full`；
  - MinerU 不可用且是 PDF → 用新增依赖 unpdf（或同类纯 JS 库）提取文本，`quality=degraded`，并登记一次 `env_missing:mineru` 引导事件（不阻塞入库）；
  - Office / EPUB 在缺 MinerU 时 → `blocked`。
- 沙箱交接：
  - 原件以硬链接（失败则复制）放入沙箱可写的临时目录，输出也写到临时目录；
  - core 校验后搬入 staging；
  - 数据目录不向沙箱暴露；沙箱不可用 → `blocked: env_missing:sandbox`。
- 测试：降级路径用小 PDF 夹具；MinerU 路径用标记跳过的集成测试。

### 任务 9 阻塞态与对话内引导（36 §3.3，05）

- 派生器开工前做依赖探测：工具定位、能力模型是否已配置、沙箱是否可用。不满足 → 状态置 `blocked` + reason，job 以 `done` 结束（不消耗 attempts）。
- `budget_exceeded` 不进入 blocked，沿用 jobs runner 的 defer 机制推迟到次日。
- 首次进入某个 blocked reason 时，经 `orchestrator.deliverEventToBot` 投递 internal 事件 `wiki_derive_blocked`（同一资产同一原因只投一次，记录在 state.json）。事件文案引导 Bot 发起环境安装卡（D13）或能力设置卡（D58）。没有发起对话时，回落到 Bot 私聊。
- 解除阻塞：
  - 环境管理器安装成功事件 → 扫描对应 reason 的 blocked 资产，重新登记 `wiki_derive`；
  - 能力模型配置变更（settings 变更事件）→ 同上；
  - UI 上的「重试」→ 同上。
- 测试：缺 ffmpeg → 进入 blocked，事件只发一次；模拟安装成功 → 自动续跑；attempts 不增长。

### 任务 10 音视频派生（36 §4）

- `derive/audio.ts`：
  - 用 ffprobe 读取时长，超过 `WIKI_MEDIA_MAX_DURATION_SEC` 判为失败；
  - 用 ffmpeg 转为 16kHz 单声道，按 `WIKI_ASR_SEGMENT_SEC`（120）切段；
  - 逐段执行 `asr_segment:{n}`，每段是一个可续跑步骤；
  - 合并为带时间码的 `transcript.md`。
- `derive/video.ts`：
  - 抽取音轨后走音频流程，无音轨时 transcript 为空；
  - `keyframes`：场景切换检测（`select='gt(scene,T)'`）加最小间隔，数量不足时均匀补齐，上限 `WIKI_KEYFRAME_MAX`（20），长边 ≤1280，输出到 `wiki-store/{id}/frames/`；
  - 按 `WIKI_CAPTION_BATCH`（4）张一批调用 `understandImage`（`caption_batch:{n}`），汇总为 `frames.md`。
- 不得在缺 ffmpeg 时降级为「仅 ASR」。
- 测试：用假 ffmpeg / 假 MediaService 覆盖步骤编排与续跑；真实 ffmpeg 的集成测试用一段几秒的生成视频（`ffmpeg -f lavfi testsrc`），有工具链才跑。

### 任务 11 「Wiki 媒体派生」总开关（36 §5.4）

- 用户级设置 `wiki.mediaDerive: boolean`，默认 true（shared settings schema）。
- 设置 UI：放在 Wiki / 能力相关分区，文案按 36 §5.4 写明会上传到所配置的多模态 / ASR 模型。
- 关闭时二进制资产置为 `stored`；`wiki.deriveStored(botId)` 提供批量派生，开关打开时不自动回扫。
- 测试：开关关闭 → stored + 快照已提交；打开后派生 → 不会被判为重复而跳过。

### 任务 12 派生记账与预算（36 §5.3）

- 派生器调用 MediaService 时传上下文 `{ botId, loopType: 'wiki_derive' }`（复用修正文档任务 2 的机制）；`loopTypeSchema` 新增 `wiki_derive`。
- `wiki_derive` 在开工前检查 Bot 当日预算（与其他后台 job 一致）。
- 测试：派生后 `usage_ledger` 出现 `wiki_derive` 行；预算超限时推迟。

### 任务 13 删除资产、回滚对齐、体检（36 §6，05）

- `WikiService.deleteAsset(botId, assetId)` 在锁内执行：
  - 删除 `wiki-store/{id}/`、`raw/_derived/{id}/`、`raw/_assets/{id}.json`，以及文本类资产在 `raw/` 中的原件；
  - 在 log.md 追加一行，提交；
  - 登记 `wiki_lint`。
- `rollback` 后对齐：
  - 树中已没有快照、但 store 中仍有的资产 → 置为 `derived`（可重新维护）；
  - 有快照、但 store 中原件已删的资产 → UI 显示「原件已删除」。
- `wiki_lint` 的任务消息增加两项检查：资产链接与派生链接是否有效；`degraded` 资产是否在源摘要页注明。
- 测试：删除后回滚，原件不恢复；派生进行中删除资产，派生中止。

### 任务 14 RPC 与最小 UI（36 §5.5）

- RPC：`wiki.assets`、`wiki.asset`、`wiki.openAssetOriginal`（经 shell facade 用系统程序打开原件）、`wiki.retryAsset`、`wiki.deriveStored`、`wiki.deleteAsset`；事件 `wiki.asset_changed`。
- Wiki 面板新增「资料」页签：列出资产，显示状态与原因，提供重试 / 删除 / 打开原件。
- 页面渲染：指向 `_assets/*.json` 的链接渲染为资产卡片。
- 测试：RPC 契约测试；渲染层组件单测。

### 任务 15 提示词纪律 ⓪（22，17）

- **只在任务 8 合入之后做。** 在此之前改提示词会让 PDF 入库失去现有路径。
- 在系统提示的附件阶梯中加入 ⓪：用户表达「学一下 / 记住 / 整理进知识库」时，直接调用 `wiki_enqueue`（附件 id 或路径），不安装、不调用技能来做入库；同一条消息还要求当场回答内容时，先入库，再按阶梯处理即时阅读。
- 测试：提示词快照测试更新。

## 3. 收尾

- 全量测试跑一次（涉及 shared 契约、新 job type）。
- 更新 `docs/design/36-wiki-multimodal-ingest.md` 的状态行与 README 的 D85 行（实施情况、日期）。
- `docs/dev/PROGRESS.md` 记录实现与测试证据。

## 4. 非目标（本期）

`wiki_vec`；MinerU 依赖常驻服务的档位（等 17 的 spike 结论）；URL 二进制无损抓取；清洗 git 历史；附件通道扩容到 GB 级。
