# dashscope-t2i（D125 执行型试点插件）

首个**执行型官方插件**（形态 B，[61 号设计 §2](../../docs/design/61-plugin-runtime-platform.md)）：
manifest 带 `runtime` 段、包内带打包后的 JS（`dist/main.js`），由宿主 PluginHost 以子进程
按 IPC 协议执行。能力条目是 `image`，**不填 `engine`**——条目解析落到托管适配器
（HostedAdapter），协议在插件内自带实现。

定位：协议与内置 `dashscope` 引擎的图片生成**同源**（qwen-image 系列同步
`multimodal-generation`），试点有意重新实现，用于 A/B dogfood 执行型运行时的全路径
（请求组装 / 参考图 / 进度 / 取消 / 错误映射 / 产物落附件），不补能力空白。

## 协议

- 生成：`POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`
  - 头：`Authorization: Bearer <apiKey>`、`Content-Type: application/json`
  - 体：`{ model, input: { messages: [{ role: 'user', content: [{ text }, ...{ image }] }] }, parameters: { size, n, prompt_extend, watermark, negative_prompt?, seed? } }`
  - 纯文生图只放 `text`；带参考图（`images`）即编辑（3.0 系列最多 3 张）。
  - 返回 `output.choices[0].message.content[].image`（PNG 直链，24h 有效）。
- 进度：请求开始 → `submitting`；拿到图片 → `downloading`（100%）。同步接口没有中间
  状态可上报，SDK / 宿主各限速 1 次/秒。
- 取消：`host.signal` 不能跨进程中断宿主代理请求；插件在响应返回后立即检查 abort，
  已取消则丢弃结果并报「调用已取消」。
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
- 与内置引擎的 A/B 对照结论见 [todo/plugin-runtime/P4-governance-pilot.md](../../todo/plugin-runtime/P4-governance-pilot.md)
  的实施记录与 61 号 §12。
