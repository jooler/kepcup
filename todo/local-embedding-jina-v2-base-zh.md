# 本地向量默认模型：bge-small-zh-v1.5 → jina-embeddings-v2-base-zh

> 状态：**已实现**（2026-10-07 完成代码落地与本机尖峰验证；P4 应用内全流程验收与 Windows/Linux 实测待做，见跨平台清单）。
>
> 本文是给编码 Agent 的**自包含交接**：不依赖本 chat 历史即可开工。
>
> **硬约束**：只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
>
> **相关设计**：`docs/design/16-capability-models.md`「向量来源的本地实现」、`docs/dev/phases/P07-memory.md` 本地向量段、`docs/dev/DEVIATIONS.md` DEV-007 决定段；`todo/cross-platform-acceptance.md` P07 小节含三平台实测项。

## 0. 先读什么（按顺序）

1. `docs/design/16-capability-models.md` — 「向量来源的本地实现（DEV-007 已落实）」
2. `docs/design/04-memory.md` — 记忆检索 / `memory_vec` / 换 embedder id 重建
3. `docs/dev/DEVIATIONS.md` — DEV-007（运行库不进安装包、`onnxruntime` + `embedding-model` 一张审批卡）
4. `docs/dev/phases/P07-memory.md` — 向量服务与环境目录条目
5. 代码锚点（实现时打开）：
  - `packages/core/src/env/catalog.ts` — `EMBEDDING_MODEL_VERSION`、`embedding-model` 条目（url/sha256/sizeBytes）、与 `onnxruntime` 的链式前置
  - `packages/core/src/memory/embedder.ts` — `EMBEDDING_MODEL_ID`、`LocalEmbedder`、池化（mean）、归一化、会话缓存
  - `packages/core/src/memory/bpe-tokenizer.ts` — 现用 RoBERTa 字符级 BPE（**原 bert-tokenizer.ts（BERT WordPiece）已删除：jina 不是 WordPiece 词表，见 §3.3 结论**）
  - `packages/core/src/memory/service.ts` / `vec-rebuild.ts` / `retrieve.ts` — 换 id/dim 后重建与检索
  - `packages/core/src/env/gpu.ts` — EP 选型（保持）
  - `apps/desktop/.../lib/i18n/locales/zh-CN.ts` — `settings.embeddingNote` 等文案中的型号名
  - 单测：`bpe-tokenizer.test.ts`、`local-embedder.test.ts`、`memory-embedder.test.ts`、catalog 校验相关



## 1. 背景与目标



### 1.1 决策（已锁定）


| 项      | 决定                                                                 |
| ------ | ------------------------------------------------------------------ |
| 默认本地模型 | `jinaai/jina-embeddings-v2-base-zh`（中英双语）                          |
| 不采用为默认 | EmbeddingGemma 2（无中文专项分、栈不贴合）；bge-m3（质量更高但 ~558MB int8、延迟难进预算）     |
| 运行时    | **继续** `onnxruntime-node` + 环境管理器按需安装（DEV-007 形态不变）                |
| 制品偏好   | 优先 **量化 ONNX（q8 / 官方 quantized，约 162MB）**；fp16/fp32 仅作对照或质量回退      |
| 输出     | **768 维**、单位归一；序列按模型能力可用至 8192，首期实现可先与现网一致做合理截断（见开放项）              |
| 池化     | **mean pooling**（Jina / sentence-transformers 惯例），**不是** BGE 的 CLS |
| 许可     | Apache 2.0（可商用）                                                    |




### 1.2 相对现状的变化（实现必对上）


|             | 现：`bge-small-zh-v1.5`           | 目标：`jina-embeddings-v2-base-zh`                                          |
| ----------- | ------------------------------- | ------------------------------------------------------------------------ |
| 语言          | 中文为主                            | **中英双语 + 混输**                                                            |
| 参数 / 体积     | ~33M / ONNX ~90MB               | ~161M / q8 ONNX ~**162MB**（fp16 ~321MB）                                  |
| 维度          | 512                             | **768**                                                                  |
| 上下文         | 512                             | 8192（能力；产品截断 512，见 §3.3 结论）                                                      |
| 池化          | CLS                             | **mean**                                                                 |
| 分词          | 自写 BERT WordPiece + 中文词表        | **RoBERTa 字符级 BPE**（`vocab.json` 60516 词 + `merges.txt` 39382 合并，NFC+小写、`<s>…</s>`；**不是 WordPiece**） |
| embedder id | `local:bge-small-zh-v1.5@{ver}` | `local:jina-embeddings-v2-base-zh@{ver}`（换 id → 自动 `memory_vec_rebuild`） |
| 审批卡合计       | 模型+ORT ≈ 200MB                  | 模型 q8+ORT ≈ **276MB**（162.76 + 113.57 MB，sizeBytes 如实相加）                |




### 1.3 非目标

- 不引入 EmbeddingGemma 2 / LiteRT / SentenceTransformers 作为默认路径
- 不把 bge-m3 做成默认下载（若日后要「高质量档」另开 todo）
- 不启用 Jina sparse/ColBERT（本模型亦非 M3）；只做稠密向量
- 不改厂商 `/v1/embeddings` 路径
- 不把运行库打进应用安装包
- 不 git commit / push / PR



### 1.4 成功标准

1. 用户批准环境安装后，本地向量来源就绪；`embedding.status` 显示新型号与 dim=768。
2. 中英及中英混杂短句语义方向正确（同义高、无关低）；至少覆盖：纯中、纯英、中英混合各一组。
3. macOS arm64 warm 单条耗时**实测记录**（原 ≤50ms 预算对 161M 可能偏紧——以实测为准写入 PROGRESS；若 >80ms 在开放项给出截断长度/量化取舍建议，**不擅自换回 bge**）。
4. 已安装旧 bge 的用户：换 catalog 版本后走既有安装/重建路径，旧向量表按新 embedder id/dim 重建，检索不崩。
5. 相关单测/集成更新并通过（`node scripts/run-tests.mjs run <相关测试文件>`），交付前全量 `pnpm test` 一次（见 [docs/dev/05-testing.md](../docs/dev/05-testing.md#开发中如何跑测试)）；catalog sha256/体积校验通过。



## 2. 实施顺序

```
P0 制品钉死 + 分词/池化尖峰（不改产品默认前先在本机跑通）
 → P1 catalog + LocalEmbedder 常量/加载/池化
 → P2 分词器（JinaBERT）与单测
 → P3 文案 / 设计文档 / DEV-007 附录 / 跨平台验收项
 → P4 本机验收（语义 + 延迟 + 重建）
```

---



## 3. P0 — 制品与尖峰（已完成，结论见 §7 结论栏）

### 3.1 钉住下载文件【选定候选 B：Xenova 导出 @ ModelScope】

- [x] ONNX 来源：`Xenova/jina-embeddings-v2-base-zh`（ModelScope 镜像，与既有 bge 条目同域名白名单，**无需扩白名单**）；量化制品 `onnx/model_quantized.onnx`（q8，161,565,239 字节）。
- [x] sha256/sizeBytes 实算写入 catalog（§7 结论栏）；旁路文件钉 `vocab.json` + `merges.txt` + `config.json`（该导出**没有 vocab.txt**）。
- [x] 用 `~/.kepcup/toolchains/onnxruntime/1.30.0` + Node 脚本（/tmp，不进仓库）跑通推理：「今天天气怎么样?」↔「How is the weather today?」余弦 **0.68**（官方示例量级约 0.78；q8 量化下同向明显）。

### 3.2 池化与输出名【只有 last_hidden_state，embedder 内 mean 池化】

- [x] Xenova 导出输出仅 `last_hidden_state` [batch, seq, hidden]（无 `sentence_embedding`）；输入仅 `input_ids` + `attention_mask`。`LocalEmbedder` 对全体位置（batch=1 无 padding，mask 恒 1，含 `<s>/</s>`）做 mean 后 L2 归一。
- [x] CLS 池化代码已删除（含对应单测断言改为 mean 断言）。

### 3.3 分词尖峰【结论：RobertaTokenizer 字符级 BPE，纯 TS 实现，无新依赖】

- [x] 官方 tokenizer 是 **RobertaTokenizer**（`vocab.json` 60516 词 + `merges.txt` 39382 合并，`<s>…</s>` 包裹）：NFC + 小写归一、`Whitespace` 预切分（`\w+ | [^\w\s]+`，空白丢弃、标点成块）、字符级 BPE（无 byte fallback，未收录符号 → `<unk>` id 3）。**与 BERT WordPiece 完全不同**——原任务书「确认是否仍可用 WordPiece」的答案是**不能**，`bert-tokenizer.ts` 已删除，新写 `memory/bpe-tokenizer.ts`（约 120 行，含版本头/CRLF 兼容与畸形行拒绝）。
- [x] 纯 TS 实现与 HF `tokenizers`（Python，直接读 tokenizer.json）在 8 组中英混句上**逐 id 完全一致**（含 emoji→unk、全角、空白折叠、未知 BMP 外字符）。
- [x] 序列上限：**512**（模型 ALiBi 支持 8192）。依据：记忆条目 schema 上限 2000 字符、典型一行短句远低于此；实测 1024 token 单条 warm 约 367ms（arm64 CPU），512 兼顾长文覆盖与整理重建吞吐。开放项保留「是否升 1024/2048」。

### 3.4 延迟尖峰（macOS arm64，q8）

- [x] warm 单条：短中文约 **4.3ms**、短英文约 **4.0ms**（纯 CPU EP）；生产配置（CoreML EP）经正式 dist 代码实测约 **26ms**（CoreML 调度开销，仍 ≤50ms 预算）。会话创建约 **170ms**（CPU）/ 约 2s（CoreML 编译，一次性）；1024 token 单条约 **367ms**。

---



## 4. P1 — catalog + LocalEmbedder（已完成）

### 4.1 `env/catalog.ts`

- [x] `EMBEDDING_MODEL_VERSION = '2.0.0'`（目录名 `toolchains/embedding-model/2.0.0/`）
- [x] `embedding-model` 条目：displayName/source/files 四件套全部实算（模型 161,565,239 + vocab 854,399 + merges 336,141 + config 1,413 = 162,757,192 字节，全平台一致）
- [x] 审批卡 reason「约 200MB」→「约 276MB」（162.76 + 113.57 MB）
- [x] ModelScope 有 Xenova 导出镜像，白名单测试无需扩展

### 4.2 `memory/embedder.ts`

- [x] `EMBEDDING_MODEL_ID = 'jina-embeddings-v2-base-zh'`；id 形如 `local:jina-embeddings-v2-base-zh@2.0.0`
- [x] dim 从 config.json 读（768），`FALLBACK_DIM` 改 768
- [x] 池化 mean（`last_hidden_state` 全位置均值）+ 单位归一
- [x] 注释/错误文案清除 bge/CLS 表述；`ready()` 检查 vocab.json + merges.txt
- [x] `MAX_SEQUENCE_LENGTH = 512`（注释写明模型 8192 与取舍依据）

### 4.3 安装与重建接线

- [x] `onEmbeddingModelInstalled` → `memory_vec_rebuild` 逻辑未动：version 变化即换 embedder id，既有重建路径生效（集成测试覆盖）
- [x] 旧 bge 文件靠 `toolchains/embedding-model/1.5/` 目录隔离（开放项 4 保留「释放磁盘」选项）

---

## 5. P2 — 分词器（已完成）

- [x] 新文件 `memory/bpe-tokenizer.ts`（**WordPiece 不兼容，bert-tokenizer.ts 已删除**）
- [x] 单测 `bpe-tokenizer.test.ts`：CJK 合并、大小写/标点/空白、未知符号→`<unk>`、截断、空串、畸形 merges 行拒绝；纯 TS 实现与 HF tokenizers 逐 id 对齐（8 组中英混句 + emoji/全角/空白折叠，2026-10-07 尖峰记录）
- [x] local-embedder/memory-embedder/env-catalog 测试同步更新（mean 池化断言按位置变化张量构造）

---

## 6. P3 — 文档与产品文案（已完成；docs 只记现状，不记升级记录）

- [x] `docs/design/16-capability-models.md`：表格型号/体积/维度/池化/分词/来源改 jina；性能预算写 macOS 实测数
- [x] `docs/dev/phases/P07-memory.md`、`DEVIATIONS.md` DEV-007 决定段、`docs/design/14-models-and-browser.md`、`docs/design/11-storage.md`：事实改 jina（按要求**不**追加升级记录/方案对比）
- [x] `docs/dev/PROGRESS.md`：按用户要求**不**追加升级记录（docs 为事实描述）
- [x] `todo/cross-platform-acceptance.md`：P07 三平台项改 jina；Win/Linux 待测
- [x] i18n `settings.embeddingNote`：型号/768 维/约 276MB（设置页无其它硬编码型号，走 i18n）

---

## 7. P4 — 本机验收清单

- [ ] 清空或使用临时 profile：走一遍环境审批 → 下载 → `embedding.status` ready、dim=768（**应用内全流程未跑**；推理路径已用 toolchains 的真实 onnxruntime-node 直接验证）
- [x] 语义烟测（直接 embed，q8 + CPU EP 实测）：

  | 对                                   | 期望       | 实测    |
  | ----------------------------------- | -------- | ----- |
  | 「我喜欢喝美式」↔「我偏爱美式咖啡」                  | 高相似      | 0.654 |
  | 「I prefer oat milk latte」↔「我喜欢燕麦拿铁」 | 跨语言仍明显同向 | 0.378 |
  | 「喜欢美式」↔「今天股市大涨」                     | 低相似      | 0.040 |
  | 「今天天气怎么样?」↔「How is the weather today?」 | 跨语言同向    | 0.682 |

- [ ] 切换本地→厂商→再回本地：重建任务完成、无崩溃（未跑，留待应用内验收）
- [x] 记录：模型合计 162,757,192B、ORT 113,574,683B、warm 短句约 4ms（CPU）/ 约 26ms（CoreML）、1024 token 约 367ms、会话创建约 170ms-2s（写入本表与 design/16）；生产 dist 代码 + CoreML EP 复测语义一致（同义 0.654 / 跨语言 0.680 / 无关 0.040）。

### 尖峰结论栏（2026-10-07 填写）

| 项                  | 结论                                                                  |
| ------------------ | ------------------------------------------------------------------- |
| 选用的 ONNX 路径 / 量化    | `Xenova/jina-embeddings-v2-base-zh` `onnx/model_quantized.onnx`（q8）@ ModelScope |
| sha256（model）      | `0a221ee9e6a6647ccc59cee7bdd26a7b8cf0c0cd3481a65f358d9585a23f02f4`  |
| sha256（vocab/merges/config） | `62a86185…1a4b5` / `34c90c55…ad331` / `7dd45199…010d4`（完整值见 catalog） |
| 词表方案（纯 TS / 其他）    | 纯 TS 字符级 BPE（`bpe-tokenizer.ts`；RobertaTokenizer 语义，与 HF 逐 id 对齐）    |
| maxLen             | 512（模型 8192；1024 token warm ~367ms）                                  |
| macOS warm ms      | 短句 ~4ms（CPU EP）/ ~26ms（CoreML EP）；会话创建 ~170ms-2s；1024 token ~367ms |
| 是否需扩 catalog 域名    | 否（ModelScope 已在白名单）                                                  |


---



## 8. 开放项（不要在实现里擅自拍板）

1. ~~warm 延迟若持续 >100ms 是否放宽预算/双档模型~~ ——实测短句约 4ms，问题不存在；仅超长文本（1024 token ~367ms）受截断上限约束（见 2）。
2. 序列截断 512 vs 1024 vs 2048：实现取 **512**（任务书首期建议范围内，依据见 §3.3）；是否放宽待真实负载/整理吞吐数据再议。
3. bge-m3 是否作为设置里可选「大模型」第二环境条目（另开 todo）。
4. 旧 bge 目录（`toolchains/embedding-model/1.5/`，约 90MB）是否在设置里提供「释放磁盘」清理。



## 9. 参考链接（只读）

- 模型卡：[https://huggingface.co/jinaai/jina-embeddings-v2-base-zh](https://huggingface.co/jinaai/jina-embeddings-v2-base-zh)
- Xenova ONNX：[https://huggingface.co/Xenova/jina-embeddings-v2-base-zh](https://huggingface.co/Xenova/jina-embeddings-v2-base-zh)
- Jina 介绍：[https://jina.ai/models/jina-embeddings-v2-base-zh/](https://jina.ai/models/jina-embeddings-v2-base-zh/)
- 对比结论来源：2026-10-07 评估——相对 bge-small-zh，双语覆盖与 C-MTEB（约 63.79 vs 57.82）更优；相对 bge-m3 体积/延迟更适合默认下载；相对 EmbeddingGemma 2 中文证据与现有 ORT 栈更贴。

