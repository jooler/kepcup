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
- `ctx`：`{ host, entryId, model, instanceId, locale, credentials, signal }`——`credentials`
  是宿主调用时注入的实例敏感字段键值（进程内存活，永不落盘、永不入日志）；`instanceId`
  是本次调用的实例 id（无实例时为空串，D125 P4 / DEV-114：多实例插件用它把凭据与实例
  的非敏感配置对齐）；`signal` 在宿主发 `cancel` 帧（用户取消 / 超时）时 abort，插件应
  尽快返回。SDK 的 ready 帧会声明 `invoke.context.instanceId` 能力，宿主才发送该字段
  （旧 SDK 不声明 → `instanceId` 恒为空串，帧 schema 不会因未知字段失效）。
- 实例字段来自 manifest `runtime.instanceFields`（`pluginFieldSchema` 同形，≤16 个；
  `sensitive: true` 的值存进实例 secrets，调用时进 `ctx.credentials`；非敏感值可从
  `ready()` 的实例 `fields` 读取）。执行型条目不填 `engine`，凭据面完全由该声明决定。
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

## 进程 cwd 与私有数据目录（D125 补丁 / DEV-131）

- 插件进程的 **cwd 是宿主管理的私有数据目录** `{home}/plugin-data/{ns}/{name}/`（0700，
  与插件版本无关）：宿主在安装执行型插件时创建、更新时确保存在（更新失败不删）、
  builtin 执行型插件在首次拉起时创建，卸载 / 安装回滚时删除。插件沿**相对路径**写入
  即落在该目录。注意 cwd **不再是安装目录**：读取包内相对资产请用 `import.meta.url`
  解析绝对路径（或打包时内联），不要用 `process.cwd()`。
- 这**不是 Host API 的 fs 能力**：没有 `host.files`，也不放开 fs / secrets / env；
  市场静态扫描对 `fs` / 子进程 / 网络的限制完全不变。需要如实理解：扫描是代码审查层，
  **不是 OS 沙箱**——插件进程仍以用户权限运行，本次改动不把「不能读任意本地文件」当成
  安全承诺；Host API 只是不提供文件读写通道。
- **生成产物由 core 下载并落盘**：执行型插件条目的 `generate_image` /
  `generate_speech` / `generate_video` 默认写入 `{cwd}/artifacts/`（宿主管理，不受任务
  写域门槛约束），随后由 `GeneratedMediaDelivery` 作为消息附件投递；任务可用
  `output_dir` 让产物改落自己的 workspace 写域（付费前预检，写文件前仍逐个文件过写域
  检查）。生成结果的契约只含引用（URL / base64）；落盘与投递由宿主完成，插件不参与
  投递语义。

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
