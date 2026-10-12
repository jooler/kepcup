# 现有业务修正（D83 / D85 方案审查衍生）：实施方案

> 状态：**任务 1 / 2 / 4 已实施并合入 main**（2026-10-12，`t/review-fixes`，未推送；实现要点与已知限制见 `docs/dev/PROGRESS.md` 同日小节）；**任务 3（邮件实机验收）待做**，需真实邮箱与授权码。（2026-10-12 由 34 / 36 方案审查整理。）本文只含**对现有业务的修正与优化**，不依赖 D85 / D83 的新结构，可最先做。
> 姊妹文档：[wiki-multimodal-ingest.md](wiki-multimodal-ingest.md)（D85，增强）、[kepcup-supplier.md](kepcup-supplier.md)（D83，纯新增）。本文任务 2 是两者的共同前置。
> 分支 / worktree：建议 `t/review-fixes` @ `/home/jyy/wt/kepcup-review-fixes`。主工作树可能有其他会话的未提交改动，不在主树里做。
> **测试纪律**（AGENTS.md）：开发中只跑定向测试：`node scripts/run-tests.mjs run <文件>`，在 `kepcup-test:trixie` 容器里跑，不在容器里跑 `pnpm test` / `pnpm install`。typecheck / lint 在宿主跑（`export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH`）。改了 `packages/shared` 契约时，收尾全量跑一次，对照已记录的基线（33 个环境性失败）。

## 0. 总览

| # | 任务 | 规模 | 依赖 | 下游 |
|---|---|---|---|---|
| 1 | Wiki 来源 mime 嗅探，非文本不再内联进提示词（修现网 bug） | S | — | D85 资产模型 |
| 2 | 媒体调用记入 `usage_ledger`（所有 provider） | S–M | — | D85 派生记账、D83 信用金 |
| 3 | 邮件通道 P0 实机验收与修复 | S + 修复 | — | — |
| 4 | Wiki 服务过时注释清理 | S | 与 1 同提交 | — |

建议顺序：1 → 4（同一提交）→ 2 → 3（3 可随时穿插，需要真实邮箱）。

## 1. Wiki 来源 mime 嗅探（修现网 bug）

### 现状（2026-10-12 读取，以代码为准）

- `packages/core/src/wiki/ingest.ts` 的 `resolveSource`：file 来源把 `mime` 写死为 `'text/plain'`（约第 254 行）；attachment 来源直接用上传时的 `attachment.mime`。
- `packages/core/src/wiki/maintenance.ts` 的 `inlineTextFor` 只看 mime：`isTextLike` 为真就 `bytes.toString('utf8')`。
- 后果：经 file 来源入库的 PDF / 图片 / 音视频会被当成文本解码，最多 `WIKI_SOURCE_INLINE_MAX_CHARS`（2 万）字乱码进入维护 loop 的 `<material>`。
- 内联为空时，`taskMessage` 给出的兜底是「请用 read 工具读取 raw/…」——对二进制原件同样会读出乱码。

### 做法

1. 在 `wiki/source.ts` 新增纯函数 `sniffSourceKind(bytes, fileName, declaredMime)`，返回 `{ mime, kind }`，其中 `kind ∈ text | html | document | image | audio | video | binary`：
   - 魔数优先：`%PDF`、PNG、JPEG、GIF、WebP（RIFF…WEBP）、ZIP（再按扩展名区分 docx / xlsx / pptx / epub）、OLE（doc / xls / ppt）、MP4 / MOV（`ftyp`）、WebM / MKV（EBML）、MP3（ID3 或帧同步）、WAV（RIFF…WAVE）、OGG、FLAC；
   - 无魔数时：前 8KB 无 NUL 且能按 UTF-8 无损解码 → 文本类，再按扩展名细分 markdown / json / csv / html；
   - 其余 → `binary`。
2. file 来源用嗅探结果替换写死的 `text/plain`。attachment 来源也做一次嗅探：声明为文本但实际是二进制时，以嗅探结果为准。
3. `inlineTextFor` 改为基于 `kind` 判断：只有 `text` / `html` 才内联，且内联前再次确认无 NUL。
4. `taskMessage` 的兜底文案按 kind 区分：
   - 文本类：保持「请用 read 工具读取」；
   - 二进制：改为「（二进制资料：{kind}，{fileName}，当前没有可读文本层；只在 log.md 登记来源，不要用 read 读取原件）」。这样 D85 落地前，二进制资料不会生成胡编的页面。
5. 维护提示词 `MAINTENANCE_PROMPT` 补一句：raw/ 中的二进制文件不可直接阅读。

### 测试

- 单测（新建或并入 `test/unit/wiki-*.test.ts`）：`sniffSourceKind` 覆盖各魔数、无扩展名文本、声明 text 实为 PDF、UTF-8 非法字节。
- 集成：在 `test/integration/wiki.test.ts` 加一例——file 来源入库一个最小 PDF 夹具，断言维护 loop 收到的任务消息不含 PDF 字节，且带有「二进制资料」兜底。

### 验收

- file 来源的 PDF / PNG / MP4 入库后，维护提示词里没有乱码；markdown / txt / json / csv 行为不变。
- `wiki-url.test.ts` 原有用例不回归。

## 2. 媒体调用记入 `usage_ledger`

### 现状

- `usage.record` 只在 LLM loop 中调用（orchestrator、dispatcher、reflection、wiki maintenance、skills authoring、subagent、conversation-summary 等）。
- `packages/core/src/media/service.ts`（`MediaService`）的 embed / rerank / understandImage / transcribeSpeech / synthesizeSpeech / generateImage / generateVideo **都不记账**。
- 调用方：
  - `tools/image-tools.ts`：`generate_image`、`understand_image`；
  - `tools/speech-tools.ts`：`generate_speech`、`generate_video`、`transcribe_audio`；
  - `memory/service.ts`：`media.embedTexts`、`media.rerank`，经 embedder 被 `memory/retrieve.ts` 和各记忆写入路径调用；
  - `rpc/bindings.ts`：`media.*` 直接 RPC，用于设置页测试与语音输入（26）。
- 每日后台预算 `usage/budget.ts` 按 token 统计后台 `loop_type`。媒体调用不入账 → 后台向量化等开销对预算不可见。

### 做法

1. `MediaService` 增加可选的调用上下文参数 `ctx?: { runId?, botId?, conversationId?, loopType }`。每次调用成功后，在 `MediaService` 内统一写一行 `usage_ledger`：
   - `provider` = 厂商 id，`model` = 模型 id；
   - token 字段：厂商响应带 usage 时填入（embedding / 部分多模态接口有），否则为 0；
   - `cost_usd` = null。
   - 一行即一次调用，次数可直接按行统计，**不新增列、不加迁移**。
2. 调用方传入上下文：
   - 工具调用：用所在 run 的 `runId` / `botId` / `conversationId` / `loopType`（turn / task）。
   - 记忆向量与重排：`loopType` 取发起它的 loop。写入路径通常在 reflection / consolidation 内；检索路径在 turn 内。拿不到上下文时用新值 `'memory'`。
   - RPC 直调：语音输入用 `'voice_input'`，设置页连通性测试**不记账**（显式 `ctx = null`）。
3. `loopTypeSchema`（`packages/shared/src/domain/types.ts`）按需新增值（如 `memory`、`voice_input`）。这是 shared 契约变更：
   - 同步检查 `usage.summary` 的输出校验和渲染层用量页的分组文案；
   - 同步检查 `budget.ts` 的 `loop_type not in ('turn','task')` 口径：`voice_input` 是用户前台行为，应排除在后台预算之外。
4. 后台预算：媒体行的 token 照常计入；token 为 0 的行暂不折算（与现有「订阅型 agent 无 token 行」的折算口径分开，避免误伤）。D83 会另加信用金维度。

### 测试

- 单测 `test/unit/media-service.test.ts`：每种能力成功调用后写一行，失败不写，`ctx = null` 不写。
- 集成：`test/integration/memory.test.ts` 中一次记忆写入后，`usage_ledger` 出现 embedding 行，`loop_type` 正确。
- shared 契约改动 → 收尾全量一次。

### 验收

- 用量页能看到图片 / 语音 / 视频 / 向量调用的行数与归属 Bot。
- 现有用量汇总、预算行为不回归（turn / task 仍不计入后台预算）。

## 3. 邮件通道 P0 实机验收（35，D84）

### 现状

P0 代码已合入 main：e0f6500（P0）、7b0aa93（审查修复）、ae79978（状态提示改造）。`docs/design/35-mail-channel.md` 的状态已改为「P0 已实现，实机验收待完成」。

### 做法（按 35 §9 / §12）

1. **QQ 邮箱**（授权码）：确认 CAPABILITY 含 IDLE 并实际走 IDLE；新信在数秒内唤醒所有绑定 Bot 的私聊；断网恢复后自动重连。
2. **163 / 126**：确认已发送 IMAP ID、走轮询；轮询间隔配置生效；未发 ID 时的错误提示可理解。
3. **Gmail**（应用专用密码）：IDLE 每 ≤10 分钟重发；会话过期后重连。
4. **发信**：`mail_send` 审批卡字段完整（收件人 / 抄送 / 主题 / 全文）；拒绝后不发；外发带污点规则生效。
5. 多 Bot 绑定同一邮箱：每个 Bot 都被唤醒且只唤醒一次。
6. 发现的问题按「定向测试 + 修复」处理；全部通过后：
   - 把 35 的状态改为「P0 已实现并验收」并写日期；
   - 同步更新 `docs/design/README.md` 中 35 那一行。

### 验收

上述 1–5 全部有实测记录（截图或日志摘要），记入 `docs/dev/PROGRESS.md` 的邮件小节。

## 4. Wiki 服务过时注释清理

- `packages/core/src/wiki/service.ts` 的第 30 行附近与第 79 行附近，注释提到「recall cascade」。代码中 wiki 侧不存在撤回级联：只有 ingest 时复核来源消息是否已撤回。
- `MessagesFacade.attachmentsFor` 已声明但未使用。
- 做法：注释改为如实描述；删除未用的 facade 方法及其装配（检查 `start.ts` 中的注入点和测试替身）。D85 的 `wiki.deleteAsset` 落地时再按需引入新依赖。
- 与任务 1 同一提交即可；跑 `wiki.test.ts` 定向确认。

## 5. 非目标

- 资产模型、派生管线、上限调整（见 [wiki-multimodal-ingest.md](wiki-multimodal-ingest.md)）。
- 信用金列、供应商相关一切（见 [kepcup-supplier.md](kepcup-supplier.md)）。
- `transcribe_audio` 上限：文档已统一为 20MB，与代码 `TRANSCRIBE_MAX_BYTES` 一致，无需改动。
