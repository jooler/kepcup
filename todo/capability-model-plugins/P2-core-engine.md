# P2 · core 引擎注册表与运行时解析链

> 状态：**待实施** · 依赖：P1 · 分支：`feat/capability-plugins/p2-core-engine`
> 必读：[CURRENT-STATE](CURRENT-STATE.md) §1/§3/§4 → [60 号设计 §1 / §3 / §4 / §7](../../docs/design/60-capability-model-plugins.md) → `packages/core/src/media/service.ts`、`packages/core/src/plugins/kinds.ts`

## 1 目标

core 侧全部机制：`MEDIA_ENGINES` 引擎注册表（现三适配器原样改造）、`capability-model` kind 适配器与实例 materializer（凭据落地）、`MediaService` 条目解析链（条目 > 全局槽位）、facade setup 需求扩展、三个新 RPC、usage 扩列写入。**既有行为零变化**是本阶段第一验收项。

## 2 范围

| 包含 | 不包含 |
|---|---|
| `MEDIA_ENGINES` + 三引擎注册（dashscope / volcengine-ark / openai-compatible） | 新厂商引擎实现（无——首批就是现有适配器） |
| `capabilityModelKind` + materializer（实例、凭据、secrets） | 插件详情 / Bot 详情 UI（P3） |
| `MediaService`：`#resolveEntry`、解析顺序、`entryParams` 透传、`INSTANCE_AMBIGUOUS` | 渲染层语音播报条目化（60 §10 Q3） |
| `#mediaFacade` 扩展（botId 透传 + setup 需求 payload 扩展） | 工具描述注入（P3，但工具 `model` 参数通道本期打通） |
| RPC：`plugins.listCapabilityEntries` / `setBotCapabilityEntries` / `testCapabilityEntry` | 市场条目（P4） |
| `#recordUsage` 写 capability / model_entry_id；安装管线 engine 校验 | embedding/rerank 条目消费（永不，本期范围外） |

## 3 开工前核对

```bash
git log --oneline -3 && ls packages/core/migrations/main | tail -3   # P1 迁移已在
rg "DEV-" DEVIATIONS.md | tail -5
node scripts/run-tests.mjs run packages/core/test/unit/media-adapters.test.ts packages/core/test/unit/media-service.test.ts packages/core/test/unit/media-service-usage.test.ts   # 行为基线先绿
```

## 4 步骤

### 步骤 1：引擎注册表

`packages/core/src/media/engines.ts`（新文件）：

```ts
export interface MediaEngine {
  id: string;
  displayName: string;
  capabilities: readonly ModelCapability[];   // 引擎可服务的能力（UI/校验用）
  adapter: VendorAdapter;                     // 现有契约，逐字复用
  credentialFields: readonly PluginField[];   // 实例表单字段声明
}
export const MEDIA_ENGINES: Readonly<Record<string, MediaEngine>> = { ... };
```

1. `dashscope`：adapter = 现 `dashscopeAdapter`（**原对象原样注册**，不改一行行为）；`credentialFields = [{key:'apiKey', type:'string', sensitive:true, required:true, title:'API Key'}, {key:'baseUrl', type:'string', required:false, title:'API 根地址（覆盖默认）'}]`；`capabilities` = 现描述符 dashscope 的能力集。
2. `volcengine-ark`：同构，adapter = 现 `volcengineAdapter`。
3. `openai-compatible`：adapter = 现 `openAICompatibleAdapter`；`capabilities = ['embedding']`。
4. `VendorCallContext`（`media/types.ts`）加可选 `entryParams?: Record<string, unknown>`——适配器本期不读它（行为零变化），通道留给后续引擎使用；`params` 白名单消费原则写进接口注释（60 §7：引擎逐键读取，未知键忽略 + warn）。

### 步骤 2：kind 适配器与 materializer

`packages/core/src/plugins/kinds.ts` + 新文件 `packages/core/src/plugins/kinds/capability-model.ts`（或就近同构文件）：

1. `capabilityModelKind: CapabilityKindAdapter`——`kind:'capability-model'`、`contributionSchema = z.array(capabilityModelEntrySchema).max(32)`、`hasInstances: true`、`instanceFields(manifest)` = 该插件条目 `engine` 并集对应的 `MEDIA_ENGINES[engine].credentialFields` 去重（保序：条目声明序）。
2. `CAPABILITY_KINDS` 追加末位（投影顺序 skill → mcp → connector → mail → im → capability-model）。
3. materializer：注册进 `PluginInstanceService`——落 `plugin_instances` 行（config_json 存非敏感字段），敏感字段（`sensitive:true`）入 secrets `plugin:{pluginId}:instance:{instanceId}:{key}`，**与 mail/im materializer 同构**（参照现有实现逐字段对齐）；卸载回滚走既有账本机制。
4. 安装管线追加校验步（registry 贡献校验处）：条目 `engine` ∉ `MEDIA_ENGINES` → `PLUGIN_ENGINE_UNKNOWN`（错误信息列出已注册引擎 id），拒绝安装。

### 步骤 3：MediaService 条目解析

`packages/core/src/media/service.ts`：

1. 新增条目仓库接口（构造注入，避免 media → plugins 反向依赖）：`MediaEntrySource { entriesFor(botId: string|undefined, capability): Promise<ResolvedEntry[]> }`——实现放 `plugins/` 侧（读已装插件投影 + `botRuntime.capability_entries` ∩ `effectivePluginIds` ∩ 插件 `enabled`），core 装配时注入。`ResolvedEntry = { pluginId, entryId, model, engine, params?, instanceId? }`。
2. `#resolve(capability, opts?: { botId?, model? })` 改造：先 `#resolveEntry`（`opts.botId` 且有条目时；`opts.model` 匹配条目 `model`/`displayName`，未命中回首个），条目路径失败语义：无实例 → `INSTANCE_AMBIGUOUS`（多实例且条目未指定 `instance`）/ 缺凭据 → `CAPABILITY_NOT_CONFIGURED`（payload 带定位，见步骤 4）；无条目 → **原 `#resolve` 全局槽位路径逐字节保留**；两者皆无 → `CAPABILITY_NOT_CONFIGURED`（现状语义）。
3. 六个媒体方法（generateImage / synthesizeSpeech / transcribeSpeech / understandImage / submitVideo / embed 等）加可选 `resolve` 透传参数 `{ botId?, model? }`，缺省 = 现行为。
4. `#recordUsage`：条目命中时写 `capability`、`model_entry_id`（`'{pluginId}/{entryId}'`），`provider` 记 pluginId；全局槽位路径写 NULL（provider 仍记实例 id）。**失败不记、记账失败只打日志的既有语义不变。**
5. `testCapabilityEntry(pluginId, entryId, {instanceId?, keyOverride?})`：按条目能力走 `testCapability` 同款探针（复用探针常量：1×1 PNG / 静音 WAV / 「你好」/ video 提交即取消），凭据取实例（keyOverride 支持未保存先测）。

### 步骤 4：facade 与 setup 需求

`packages/core/src/dispatch/orchestrator.ts`（`#mediaFacade` :5781-5818）：

1. media 方法调用透传 `{ botId }`（run 上下文已有）。
2. setup 需求结构扩展：`{kind:'capability-model', pluginId?, instanceId?, entryId?}`——条目路径缺凭据时填充；`CAPABILITY_NOT_CONFIGURED` / `PROVIDER_AUTH_FAILED` 捕获集与 `SETUP_REQUIRED` 中断链（D58）不动。
3. `MediaToolFacade` 接口（`tools/image-tools.ts` :36-82）同步加 `model?` 参数通道（`generate_image` / `generate_speech` / `generate_video` zod schema 增可选 `model: z.string().max(200)`；描述文案注明「可留空用默认」；工具描述注入条目清单在 P3，本阶段描述保持不变）。

### 步骤 5：RPC

`packages/core/src/rpc/bindings.ts`（`plugins.*` 组）：

- `plugins.listCapabilityEntries` → 已装插件条目全集：`{pluginId, pluginName, tier, entries:[{entryId, capability, model, displayName, engine, instanceState:'none'|'single'|'multi', configured:boolean}]}`；
- `plugins.setBotCapabilityEntries {botId, entries:[{plugin, entry}]}` → 整集替换 `botRuntime.capability_entries`（≤16、校验插件已装且条目存在，未知 ref 拒绝 `INVALID_INPUT` 列出违规项；同 `setBotPlugins` 的写锁与事件广播模式）；
- `plugins.testCapabilityEntry {pluginId, entryId, instanceId?, keyOverride?}` → 步骤 3.5。

### 步骤 6：定向测试

新增 `packages/core/test/unit/media-engines.test.ts`（注册表形状 / 未知引擎校验）；新增 `packages/core/test/unit/media-entry-resolution.test.ts`（解析顺序三分支、`INSTANCE_AMBIGUOUS`、缺凭据 payload、model 匹配与回退、**未装插件时逐字节走旧路径**）；扩展 `media-service-usage.test.ts`（条目行两列断言 + 全局路径 NULL 断言）；扩展 plugins 侧 kind/materializer 既有测试（实例落库、secrets、卸载回滚、engine 校验拒装）。

```bash
node scripts/run-tests.mjs run packages/core/test/unit/media-engines.test.ts packages/core/test/unit/media-entry-resolution.test.ts packages/core/test/unit/media-service-usage.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/media-adapters.test.ts packages/core/test/unit/media-service.test.ts packages/core/test/unit/media-tools.test.ts packages/core/test/unit/media-delivery.test.ts   # 行为零变化护栏
node scripts/run-tests.mjs run packages/core/test/unit/plugins   # 插件目录定向
```

## 5 验收

- [ ] `MEDIA_ENGINES` 三引擎注册，adapter 为现有对象，`media-adapters` / `media-service` 既有测试全绿（行为零变化）。证据：
- [ ] `capability-model` kind 进 `CAPABILITY_KINDS`，实例可添加、凭据入 secrets、卸载可回滚。证据：
- [ ] 安装含未知引擎条目的插件被拒（`PLUGIN_ENGINE_UNKNOWN`）。证据：
- [ ] 解析顺序「条目 > 全局槽位 > 未配置」成立；多实例未指定返回 `INSTANCE_AMBIGUOUS`。证据：
- [ ] 条目调用 `usage_ledger` 行带 `capability` / `model_entry_id`，全局路径两列 NULL。证据：
- [ ] 三个 RPC 行为符合步骤 5 规格（含未知 ref 拒绝）。证据：

## 6 实施记录

- 分支 / 提交：
- MediaEntrySource 注入点与实现位置：
- DEV 偏差：
