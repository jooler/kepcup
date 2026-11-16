# 能力模型插件化（D124）

一句话目标：媒体能力模型（图片 / 视频 / 语音 / 多模态）从「7 个全局槽位 + 内置双厂商适配器」开放为**插件扩展**——插件声明模型条目（一个模型一条）、用户配置厂商账号实例、Bot 级勾选启用条目、Bot 运行时经既有媒体网关按条目执行。设计依据：[docs/design/60-capability-model-plugins.md](../../docs/design/60-capability-model-plugins.md)（D124）。

## 给执行智能体的规则

- **阅读顺序**：本 README → [CURRENT-STATE.md](CURRENT-STATE.md)（现状基线，必读）→ [docs/design/60](../../docs/design/60-capability-model-plugins.md) → 对应阶段任务书 → 阶段任务书「必读」里点名的文件。
- **不得自行决定的事**：60 号「决策」节 12 条与「§10 待确认决策」的取舍不得改动；固定契约（见下）的名字不得改动；解析顺序（条目 > 全局槽位）不得反转；`VendorAdapter` 七方法签名不得改动。
- **自由度**：阶段内文件组织、内部函数命名、测试用例拆分可自定；引擎注册表内部结构（interface 细节）在满足「固定契约」的前提下可微调。
- **测试规则**：迭代中只跑定向（`node scripts/run-tests.mjs run <文件>`）；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；每阶段收口跑该阶段任务书「验收」列出的定向测试**一次**；全量 `pnpm test` 只在 P4 收口跑一次。
- **提交分支**：每阶段一分支，`feat/capability-plugins/p<N>-<slug>`，基线为开工时当前开发分支。
- **偏差**：与任务书步骤不符的实现决策记 `DEVIATIONS.md`（DEV-xxx 顺延，开工前 `rg "DEV-" DEVIATIONS.md | tail -5` 查最后一个编号）。
- **全局不要做**：不改 `settings-catalog`（本设计零新增条目，见 60 §6）；不动 `memory` 的 embedding/rerank 全局槽位消费；不动 `VENDOR_DESCRIPTORS` / `ADAPTERS` 既有路径行为；不改 `media/http.ts` 错误归一语义；不做任务持久化 / webhook（仍是非目标）。
- **代码规范**：与既有代码一致（biome、中文注释密度跟随同目录文件）；zod 一律 `strictObject`（plugin-manifest 全文件约束）。

## 范围

| 包含 | 不包含 |
|---|---|
| manifest 增 `contributions.capabilityModels` + kind `'capability-model'` | 可执行插件（沙箱 JS 适配器）——方向性否决 |
| core 引擎注册表 `MEDIA_ENGINES`（现三适配器改造） | 通用 HTTP 模板引擎（60 §10 Q1，远期） |
| `CAPABILITY_KINDS` 增 capability-model kind + materializer（实例/凭据） | embedding / rerank 条目消费（60 §10 Q4） |
| `botRuntime.capability_entries` + Bot 级勾选 RPC/UI | 渲染层语音播报（D106）的条目化（60 §10 Q3） |
| MediaService 条目解析链 + facade setup 扩展 | 全局七槽位 schema / UI 改动（原样保留） |
| `usage_ledger` 扩列（迁移 0075） | 用量页新视图（现有 model 维度已可区分） |
| 内置「阿里云百炼」「火山方舟」数据型官方插件 | 市场新工具 / 服务端提交流程（D104 P2/P3 既有范围） |
| 工具描述注入条目清单 + 生成工具可选 `model` 参数 | 对话轮媒体工具（对话轮无媒体工具，现状不变） |

## 阶段依赖图

```text
P1 shared 契约与迁移 ──▶ P2 core 引擎与运行时 ──▶ P3 renderer UI 与设置 ──▶ P4 内置插件与收口
   (manifest/botRuntime/0075)   (MEDIA_ENGINES/kind/                 (百炼/方舟插件、市场、
                                 MediaService/RPC/facade)              定向收口、文档回写)
```

P1 与 P2 可部分并行（P2 的引擎注册表不依赖 P1 的 botRuntime 字段），但 P2 的 manifest 校验与 RPC 依赖 P1 的 schema 落地；P3 依赖 P2 的 RPC；P4 依赖 P1–P3 全部。

## 固定契约（名字不得改动）

**shared**
- manifest 贡献字段：`contributions.capabilityModels`（`CapabilityModelEntry[]`，≤32）
- 条目字段：`id / capability / model / engine / displayName? / description? / params? / instance?`
- 实例 kind：`'capability-model'`（`PLUGIN_INSTANCE_KINDS` 成员）
- Bot 字段：`botRuntimeSchema.capability_entries`（`{plugin, entry}[]`，≤16）
- 能力枚举：条目 `capability` 用既有 `ModelCapability` 去掉 `'chat'` 后的七值

**core**
- 引擎注册表：`MEDIA_ENGINES`；首批引擎 id：`dashscope`、`volcengine-ark`、`openai-compatible`
- kind 适配器：`capabilityModelKind`（`CAPABILITY_KINDS` 追加末位：skill → mcp → connector → mail → im → capability-model）
- 错误码：`PLUGIN_ENGINE_UNKNOWN`（安装期）、`INSTANCE_AMBIGUOUS`（运行期，多实例未指定）
- RPC：`plugins.listCapabilityEntries` / `plugins.setBotCapabilityEntries` / `plugins.testCapabilityEntry`
- setup 需求扩展：`{kind:'capability-model', pluginId?, instanceId?, entryId?}`（既有 kind 复用，payload 扩展）
- 生成工具新参数：`generate_image` / `generate_speech` / `generate_video` 的可选 `model`

**存储**
- 迁移 0075（main）：`plugin_items` / `plugin_instances` kind CHECK 扩 `'capability-model'`（按 0066 重建模式）；`usage_ledger` 增 `capability TEXT`、`model_entry_id TEXT`（nullable）
- secrets 名：沿用 `plugin:{pluginId}:instance:{instanceId}:{key}`（D105 既有，不改）

## 术语

- **条目（entry）**：插件清单声明的一个可调用模型（`CapabilityModelEntry`），用户视角「一个模型一条」。
- **引擎（engine）**：core 内注册的协议适配实现（`MEDIA_ENGINES` 成员），持有 `VendorAdapter` + 凭据字段声明。
- **实例（instance）**：用户添加的厂商账号（`plugin_instances` kind `'capability-model'`），持有凭据。
- **插件粒度 = 平台协议族**（如「阿里云百炼」），条目粒度 = 模型；一个插件可只含一条条目。

## 完成定义

- 60 号「验收锚点」五条全过（证据 = 测试文件 / 提交号，记入 P4 实施记录）。
- 未安装任何能力模型插件的环境行为与今日逐字节一致（P2 定向回归证据）。
- 全量 `pnpm test` 收口一次全绿（P4）。
- 60 号文档补「现状」节（仿 51 §15）、16 号文档补「插件条目」指引、DEV 偏差清单确认无未决项。
