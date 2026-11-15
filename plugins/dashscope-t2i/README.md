# dashscope-t2i（D125 执行型试点插件）

首个**执行型官方插件**（形态 B，[61 号设计 §2](../../docs/design/61-plugin-runtime-platform.md)）：
manifest 带 `runtime` 段、包内带打包后的 JS（`dist/main.js`），由宿主 PluginHost 以子进程
按 IPC 协议执行。能力条目 `wan-t2i` 是 `image`，**不填 `engine`**——条目解析落到托管适配器
（HostedAdapter），协议在插件内自带实现。

定位：百炼 wan 系列文生图与内置 `dashscope` 引擎**同源**（`X-DashScope-Async` 提交 +
`GET /api/v1/tasks/{id}` 轮询），试点有意重新实现，用于 A/B dogfood 执行型运行时的全路径
（提交 / 轮询 / 进度 / 取消 / 错误映射 / 产物落附件），不补能力空白。

## 协议

- 提交：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis`
  - 头：`Authorization: Bearer <apiKey>`、`X-DashScope-Async: enable`
  - 体：`{ model, input: { prompt, negative_prompt? }, parameters: { size, n, seed? } }`
  - 返回 `output.task_id`。**只支持纯文生图**：带参考图（`images`）直接拒绝，图生图 /
    编辑走内置 qwen-image 条目。
- 轮询：`GET /api/v1/tasks/{task_id}`，2s 间隔；`PENDING / RUNNING` 继续，`SUCCEEDED` 取
  `output.results[].url`，`FAILED / CANCELED` 映射错误。
- 进度：提交 → `submitting`；排队 → `queued`；生成中 → `generating`（百分比估算）；
  成功 → `downloading`（100%）。SDK / 宿主各限速 1 次/秒。
- 取消：`host.signal` abort 后尽快返回，**不调用删除接口**（服务端任务自然过期）。
- 错误映射：401 → `PROVIDER_AUTH_FAILED`；402 / 配额词 → `PROVIDER_QUOTA`；
  429 → `PROVIDER_RATE_LIMITED`；其余 → `PROVIDER_UNAVAILABLE`。
- 产物只返回厂商 URL：**下载落附件一律在 core 侧**（61 §3.2）。

## 布局

```
plugin.json      清单：runtime（entry / hostApi / network.allow / instanceFields.apiKey）
                 + instances ['capability-model'] + 一条 image 条目（params: size / n）
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
再到 Bot 详情展开插件卡片勾选「百炼万相文生图（异步）」条目。API Key 只保存在本机
secrets，调用时经 `invoke.context.credentials` 注入插件进程（不落盘、不入日志）。

## 备注

- 条目 `model` 取 16 号文档登记的 wan 系列预置 id（`wan2.7-t2v`）。16 号当前只登记了
  wan 系列的视频预置；若真机验证发现文生图端点不接受该 id，只需把 manifest 的
  `model` 改为厂商在售的 wan 文生图 id（插件代码与协议不变），见
  [docs/dev/DEVIATIONS.md](../../docs/dev/DEVIATIONS.md) 的 DEV-124。
- 与内置引擎的 A/B 对照结论见 [todo/plugin-runtime/P4-governance-pilot.md](../../todo/plugin-runtime/P4-governance-pilot.md)
  的实施记录与 61 号 §12。
