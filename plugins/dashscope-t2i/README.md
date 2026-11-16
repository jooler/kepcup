# dashscope-t2i（D125 执行型试点插件）

首个**执行型官方插件**（形态 B，[61 号设计 §2](../../docs/design/61-plugin-runtime-platform.md)）：
manifest 带 `runtime` 段、包内带打包后的 JS（`dist/main.js`），由宿主 PluginHost 以子进程
按 IPC 协议执行。能力条目是 `image`，**不填 `engine`**——条目解析落到托管适配器
（HostedAdapter），协议在插件内自带实现。

定位：协议与内置 `dashscope` 引擎的图片生成**同源**（qwen-image 系列同步
`multimodal-generation`），试点有意重新实现，用于 A/B dogfood 执行型运行时的全路径
（请求组装 / 参考图 / 进度 / 取消 / 错误映射 / 产物落附件），不补能力空白。

## 协议

- 提交：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation`
  - 头：`Authorization: Bearer <apiKey>`、`Content-Type: application/json`、`X-DashScope-Async: enable`
  - 体：`{ model, input: { messages: [{ role: 'user', content: [{ text }, ...{ image }] }] }, parameters: { size, n, prompt_extend, watermark, negative_prompt?, seed? } }`
  - 纯文生图只放 `text`；带参考图（`images`）即编辑（3.0 系列最多 3 张）。
  - 返回 `output.task_id`（秒级，不等出图）。
- 轮询：`GET /api/v1/tasks/{task_id}`，3s 间隔；`PENDING / RUNNING` 继续，`SUCCEEDED` 取
  `output.choices[0].message.content[].image`（PNG 直链，24h 有效），`FAILED / CANCELED` 映射错误。
- **为什么异步而非同步**：同步接口要求单条 HTTP 连接挂到出图完成（含 `prompt_extend`
  常 60s+），任何网络抖动 / 代理超时都会让整次调用失败，且无法上报阶段或响应取消；
  异步提交是秒级短请求，轮询失败可重试，进度与取消都有自然的介入点。
- 进度：提交 → `submitting`；排队 → `queued`；生成中 → `generating`（百分比估算）；
  成功 → `downloading`（100%）。SDK / 宿主各限速 1 次/秒。
- 取消：`host.signal` abort 后在轮询间隙尽快返回，**不调用删除接口**（服务端任务自然过期）。
- 超时：单次网络请求由插件声明 `timeoutMs: 30_000`；整个调用由清单
  `runtime.timeouts['media.generateImage'] = 300000`（5 分钟）声明——**宿主只钳制上限
  （15 分钟），不用固定值干涉插件**。插件自设等待上限 285s（留 15s 回传结果）。
- 错误映射：401 → `PROVIDER_AUTH_FAILED`；402 / 配额词 → `PROVIDER_QUOTA`；
  429 → `PROVIDER_RATE_LIMITED`；其余 → `PROVIDER_UNAVAILABLE`（`url error` 附带
  「model 不在本端点支持列表」指引）。
- 产物只返回厂商 URL：**下载落附件一律在 core 侧**（61 §3.2）。
- model 可由条目 `params.model` 覆盖（在售 id 更替时改清单即可，无需改代码）。

## 布局

```
plugin.json      清单：runtime（entry / hostApi / network.allow / instanceFields.apiKey）
                 + instances ['capability-model'] + 一条 image 条目（qwen-image-3.0）
package.json     仅声明 "type": "module"（Node 据此把 dist/main.js 按 ESM 加载）
src/main.ts      插件源码（definePlugin + runPluginRuntime + host.net.fetch）
build.mjs        esbuild 单文件 ESM 打包（复用 apps/desktop 的 esbuild）
icon.svg         插件图标
.kepcup-ignore   打包排除 build.mjs / src / tsconfig.json（发布包只带运行时产物）
```

## 构建与校验

```bash
node plugins/dashscope-t2i/build.mjs
node packages/app-validator/dist/cli.js validate plugins/dashscope-t2i
node scripts/scan-plugin-runtime.mjs --dir plugins/dashscope-t2i
```

- `dist/` 不入库（根 `.gitignore` 的 `dist/` 规则）；测试与打包前先跑 `build.mjs`。
- 静态扫描（市场 CI 钩子）对执行型包 fail 即不出包；本插件预期 `PASS`。

## 配置

安装后在插件详情「账号实例」添加账号并填入百炼 API Key（`apiKey`，`sensitive`），
再到 Bot 详情展开插件卡片勾选「百炼 Qwen-Image 3.0（文生图）」条目。API Key 只保存在
本机 secrets，调用时经 `invoke.context.credentials` 注入插件进程（不落盘、不入日志）。

## 备注

- 条目 `model` 取百炼 qwen-image 系列在售 id `qwen-image-3.0`（同系列还有
  `qwen-image-3.0-pro` / `qwen-image-2.1-pro` / `qwen-image-2.1-turbo`）。**本端点只接受
  qwen-image 系列**：wan 文生图（`wanx*`）与视频模型（`*t2v`，如 `wan2.7-t2v`）会被
  百炼以 `url error, please check url!` 拒绝（真机教训，见 DEV-124）。在售 id 更替时，
  改条目 `params.model` 即可（插件代码与协议不变），插件报错也会带这条指引。
- `engines.kepcup` 固定为 `>=0.5.14`（应用最低版本），**不随插件版本号抬高**——否则
  当前 0.5.x 应用会因 `PLUGIN_INCOMPATIBLE` 装不上；dev / test 应用（版本 `0.0.0*`）
  完全跳过该检查。
- 与内置引擎的 A/B 对照结论见 [todo/plugin-runtime/P4-governance-pilot.md](../../todo/plugin-runtime/P4-governance-pilot.md)
  的实施记录与 61 号 §12。
