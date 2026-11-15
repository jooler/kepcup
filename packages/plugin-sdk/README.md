# @kepcup/plugin-sdk（D125 插件运行时平台）

KepCup 执行型插件（形态 B，[docs/design/61-plugin-runtime-platform.md](../../docs/design/61-plugin-runtime-platform.md) §2）
的插件侧 SDK：`definePlugin()` 入口 helper、`host` 宿主 API 命名空间类型、以及把 IPC 帧
dispatch 到插件实现的运行时客户端。协议帧 schema 与能力契约 schema 的**单一事实来源在
`@kepcup/shared`**（`plugin-runtime/protocol.ts` + `media/types.ts` + `media/schema.ts`），
本 SDK 不复刻任何 schema——升级协议 = 升级 shared，SDK 跟着走。

## 插件最小骨架

```ts
import { definePlugin, host, runPluginRuntime } from '@kepcup/plugin-sdk';

export const plugin = definePlugin({
  contracts: {
    media: {
      async generateImage(ctx, params) {
        host.progress({ phase: 'generating', message: '生成中' });
        return { images: [{ url: 'https://vendor.example/out.png' }] };
      },
    },
  },
});

runPluginRuntime(plugin); // 缺省挂到 Node fork 内置 IPC（宿主 PluginHost 的对端）
```

- `runPluginRuntime(spec, transport?)`：第二参数可传自定义 `PluginFrameTransport` 或
  `{ send, on, once, off }` 形的通道（测试用）；缺省用 `process`（fork IPC）。
- `ctx`：`{ host, entryId, model, locale, credentials, signal }`——`credentials` 是宿主
  调用时注入的实例敏感字段键值（进程内存活，永不落盘、永不入日志）；`signal` 在宿主
  发 `cancel` 帧（用户取消 / 超时）时 abort，插件应尽快返回。
- 七个 media 方法（`generateImage / synthesizeSpeech / transcribeSpeech / understandImage /
  submitVideo / videoStatus / cancelVideo`）全部可选，只实现支持的；未实现的被调用时
  SDK 回 `NOT_IMPLEMENTED` error 帧。`embed` / `rerank` 不开放（61 §5）。
- 业务错误抛 `new PluginInvokeError(code, message, details?)`：`code` 可用 `PROVIDER_*`
  族显式声明 auth / quota 映射；未分类异常回退 `PROVIDER_UNAVAILABLE`。
- 输出自检：result 帧发送前 SDK 按 shared media wire schema 校验输出，不合契约改发
  `PLUGIN_CONTRACT_VIOLATION`——fail-safe，绝不部分投递。

## host 命名空间（Host API v1，61 §4）

| 成员 | 语义 | 状态 |
|---|---|---|
| `host.net.fetch(url, init?)` | HTTP 客户端，白名单 / SSRF / 审计在宿主强制 | P2 已实现（`host-api` 信封 → core 能力桥） |
| `host.secrets.get(key)` | 本插件实例键只读读取 | P2 已实现（键必须匹配 `plugin:{pluginId}:instance:*`） |
| `host.storage.{get,set,delete,list}` | 插件 KV（配额 10MB，存非敏感数据） | P2 已实现（`plugin_storage` 表 + 配额） |
| `host.log.{info,warn,error}` | 结构化日志（宿主限速 100 条/调用） | 已实现（event 帧 `kind:'log'`） |
| `host.progress(p)` | 进度上报（SDK 限速 1 次/秒） | 已实现（event 帧 `kind:'progress'`） |
| `host.signal` | 当前在途调用的 `AbortSignal` | 已实现（cancel 帧联动） |

`net / secrets / storage` 由 `host-api` 信封承载（与九帧调用协议并列，判别字段
`type: 'host-api'` / `'host-api-response'`，见 DEV-113）：`runPluginRuntime(plugin)`
的进程入口模式自动接线；显式传入测试通道时不会接线，调用这些成员抛
`HostApiNotConnectedError`（可用 `wireHostApi()` 在测试里自行注入）。宿主发来的
`ping`（看门狗心跳）由通道自动回 pong——**插件需用 P2 及以上的 SDK 重新打包**，
否则约 30s 后会被看门狗击杀（DEV-116）。

## 打包约定（esbuild 单文件）

执行型插件是**单文件 ESM JS**，包内自包含（无 `node_modules`）：

```bash
esbuild src/main.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=dist/main.js
```

- `--bundle --platform=node --format=esm` 是固定约定（61 §2：`runtime.entry` 指向打包
  单文件 JS）；Node 内置模块可用，第三方依赖全部打进单文件。
- **禁止**：native 模块（`.node` / `.wasm`）、`__dirname` / `__filename`（ESM + 单文件
  语境无意义，市场扫描会拒）、运行期远程代码加载（`eval` / `new Function` / 远程动态
  `require`）。
- manifest 里 `engines.kepcup` 锁**宿主应用**的最低版本；`runtime.hostApi` 锁 Host API
  的 semver 范围（如 `'^1'`）。握手时宿主 `init.hostApiVersion` 与 SDK 支持版本不匹配
  → SDK 回 `PLUGIN_UPGRADE_REQUIRED` error 帧退出（复用既有错误码，61 §3.1）。
- 插件目录需要 `"type": "module"`（`package.json`）让 `dist/main.js` 按 ESM 加载。

仓库内参考实现：[plugins/reference-media](../../plugins/reference-media/)（`build.mjs`
演示了如何复用仓库 devDependencies 里的 esbuild 并把 workspace 源码 alias 进 bundle）。

## 客户端内置行为（宿主与插件的分工）

- **并发 = 1**：串行排队由宿主负责（61 §3.1）；SDK 防御性拒绝并发 invoke（回
  `PLUGIN_CONTRACT_VIOLATION`）。
- **cancel**：命中在途调用即 abort `host.signal`；过路 cancel（未知 callId）忽略。
- **progress 限速**：1 次/秒，窗口内合并为最新一条尾随发送；调用结束丢弃尾随事件。
- **shutdown / 通道断开**：abort 在途调用 → `done` resolve → 插件进程退出。
- `init` 握手：版本校验 → `ready()` 回调 → 回 `ready` 帧（声明的 contracts 列表）；
  `ready()` 抛错 → `PLUGIN_CRASHED` error 帧后退出。
