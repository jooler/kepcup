# P2 · PluginHost 运行时与媒体契约接线

> 状态：**待实施** · 依赖：本方案 P1 + capability-model-plugins P2（`MediaEntrySource`）· 分支：`feat/plugin-runtime/p2-plugin-host`
> 必读：[CURRENT-STATE](CURRENT-STATE.md) §2/§3/§4 → [61 号设计 §3 / §4 / §5](../../docs/design/61-plugin-runtime-platform.md) → `packages/core/src/agent/external/`（进程管理先例）、`packages/core/src/media/service.ts`、`packages/core/src/plugins/registry.ts`

## 1 目标

core 侧运行时全部机制：`PluginHost`（进程生命周期 / 看门狗 / 调用队列）、`CapabilityBridge`（Host API v1 强制面）、`HostedAdapter`（media 契约代理）接入 `MediaEntrySource` 解析链、安装管线执行型校验、迁移 0076。**验收标准：未安装执行型插件时全链路行为与今日逐字节一致。**

## 2 范围

| 包含 | 不包含 |
|---|---|
| `PluginHost`：懒启动/握手/队列/看门狗/空闲回收/崩溃重启 | 并发池化（61 §10 Q2） |
| `CapabilityBridge`：net(白名单+SSRF+审计)/credentials 注入/secrets 读/storage/log/progress/signal | `host.secrets.set`（Q1）、fs（Q5） |
| `HostedAdapter`（media 七方法 → invoke 转发）+ 错误映射 | 新契约实现 |
| `MediaEntrySource` 增 `source:'plugin'` 分支；`testCapabilityEntry` 兼容 | UI（P3） |
| 安装管线：runtime 段层级校验 / entry 存在 / hostApi 解析 / 包防护（native、路径逃逸） | 扫描 CI（P4） |
| 迁移 0076 `plugin_storage`；RPC `plugins.runtime.{list,restart}` | 活动抽屉 UI（P3） |

## 3 开工前核对

```bash
git log --oneline -3 && ls packages/core/migrations/main | tail -3   # 0075 已在则本阶段 0076
rg "DEV-" DEVIATIONS.md | tail -5
node scripts/run-tests.mjs run packages/core/test/unit/media-adapters.test.ts packages/core/test/unit/media-service.test.ts   # 行为基线先绿
```

## 4 步骤

### 步骤 1：PluginHost

`packages/core/src/plugins/runtime/host.ts`（组装根在 PluginInstanceService 之后构造，late-wire 进 MediaService 所需引用——沿用 attachXxx 模式）：

1. 进程管理：`child_process.fork(entryPath, {serialization:'advanced', execArgv:[]})`，cwd = 插件安装目录；状态机 `stopped|starting|ready|busy|error`（61 §3.1 全规则：懒启、握手 `init/ready`、hostApi semver 校验、空闲 5 分钟优雅停、崩溃重启）。
2. 看门狗：15s 心跳、2 次无响应击杀；调用级超时来自契约（media：image 120s / tts 120s / asr 300s / video 900s）；超时 = cancel → 2s → kill → `PLUGIN_TIMEOUT`。
3. 调用队列：每插件串行（`maxConcurrent` 预留字段），`call(contract, method, params, ctx)` 返回 promise；`event` 帧转发（progress → 注入的 run 进度回调；log → core logger 加插件前缀）；`cancel(callId)` 与 AbortSignal 联动。
4. 每次调用写环形历史（50 条，含 `PLUGIN_CRASHED` / `PLUGIN_TIMEOUT` / `PLUGIN_CONTRACT_VIOLATION`）；状态迁移广播 `plugin.runtime` 事件（加进 `CoreEventsMap` 与 `RPC_EVENT_NAMES`，自动三端桥接）。
5. 进程环境：`execArgv:[]`、不传透 env（白名单构造最小 env：PATH/TEMP/locale）；**stderr 收集进插件日志（前缀截断限速）**。

### 步骤 2：CapabilityBridge

`packages/core/src/plugins/runtime/bridge.ts`：

1. `net.fetch`：清单 `network.allow` 域名匹配（精确 host 或 `*.domain`，大小写不敏感）→ 不命中拒绝 `PLUGIN_NETWORK_DENIED`；复用 `web_fetch` 的 SSRF 守卫（私网/重定向）；响应 ≤20MB（超限拒绝）；JSON/文本直返、二进制转 base64；审计计数（每插件每域调用次数，进日志）。
2. `credentials`：invoke 时从 PluginInstanceService + SecretsService 组装（条目实例解析遵循 60 号 `INSTANCE_AMBIGUOUS` 语义），只含实例 `sensitive:true` 字段；**不写日志、不进历史、不进错误消息**。
3. `secrets.get`：键必须匹配 `plugin:{pluginId}:instance:*`（其它前缀拒绝）；只读。
4. `storage`：`plugin_storage` 表 CRUD（迁移 0076），10MB 配额（写前聚合校验），随插件卸载清除（挂进 registry 卸载钩子）。
5. `progress` 限速透传；`signal`：宿主侧 abort → 发 `cancel` 帧。

### 步骤 3：HostedAdapter 与解析接线

1. `packages/core/src/plugins/runtime/hosted-adapter.ts`：实现 `VendorAdapter`——七方法逐一映射为 `host.call('media', method, params, ctx)`；`submitVideo/videoStatus/cancelVideo` 保持现有三态机语义（插件返回 `VideoTaskPhase` 同形状）；错误映射：`PLUGIN_CRASHED/TIMEOUT/CONTRACT_VIOLATION/NETWORK_DENIED` → `PROVIDER_UNAVAILABLE` 族；插件 `error.code` 为 `PROVIDER_AUTH_FAILED`/`PROVIDER_QUOTA` 时透传（分家语义不变）。
2. `MediaEntrySource`：`ResolvedEntry` 增 `source:'engine'|'plugin'`；`#resolveEntry` 分支选择 `HostedAdapter` 或 `MEDIA_ENGINES[engine].adapter`；**全局槽位路径与引擎路径逐字节不动**。
3. `testCapabilityEntry`：插件条目探测经 `HostedAdapter` 同一 invoke 路径（超时用契约默认）。
4. `plugins.listCapabilityEntries` 增插件条目的 `source:'plugin'` 与实例配置状态（复用 D124 字段）。

### 步骤 4：安装管线校验

`packages/core/src/plugins/registry.ts`（清单校验后追加）：

- 含 `runtime` 段：tier 必须 builtin/verified/developer（community → 拒）；`entry` 文件存在且在包目录内（路径逃逸拒绝）；包内扫描：`.node/.wasm/可执行位文件` → 拒；`hostApi` 与 `PLUGIN_RUNTIME_HOST_API_VERSION`（常量，P1 定义 `'1'`）major 不匹配 → 拒（提示升级）。
- 同意卡 payload 增能力披露字段（数据先行，UI 在 P4/P3 渲染）。

### 步骤 5：RPC 与测试

- `plugins.runtime.list`：全部执行型插件 `{pluginId, status, detail?, lastError?, recent: 历史 50 条}`；`plugins.runtime.restart {pluginId}`。
- 测试：`packages/core/test/unit/plugin-host.test.ts`（用 reference-media 包走 fork 全链路：握手/调用/progress/取消/崩溃重启/超时击杀——**真实子进程集成测试**，超时阈值调小注入）；`plugin-bridge.test.ts`（白名单命中/拒绝、SSRF 拒、secrets 前缀拒、storage 配额）；`media-entry-resolution.test.ts` 扩插件条目分支；`media-*` 全目录回归（零变化护栏）。

```bash
node scripts/run-tests.mjs run packages/core/test/unit/plugin-host.test.ts packages/core/test/unit/plugin-bridge.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/media-entry-resolution.test.ts packages/core/test/unit/media-adapters.test.ts packages/core/test/unit/media-service.test.ts packages/core/test/unit/media-service-usage.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/plugins
```

## 5 验收

- [ ] reference-media 插件端到端可用：Bot 绑定条目 → `generate_image` 走子进程出图（1×1 PNG 落附件）、假视频任务轮询成功。证据：
- [ ] 白名单外域名被拒（`PLUGIN_NETWORK_DENIED`）且插件卡可见；SSRF 私网地址被拒。证据：
- [ ] 看门狗：注入短超时后死循环插件被击杀，工具收 `PROVIDER_UNAVAILABLE` 人话错误，后续调用自动重启进程。证据：
- [ ] 合同违规：插件返回非法 output → `PLUGIN_CONTRACT_VIOLATION`、无部分投递。证据：
- [ ] community 层级含 `runtime` 清单被拒装；`.node` 文件被拒装。证据：
- [ ] 未装执行型插件环境：`media-*` 与 plugins 全部既有测试逐字节绿（零变化）。证据：
- [ ] 迁移 0076 落库、配额生效、卸载清除。证据：

## 6 实施记录

- 分支 / 提交：
- PluginHost 组装根落点与 MediaService late-wire 方式：
- DEV 偏差：
