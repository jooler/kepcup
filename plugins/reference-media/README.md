# reference-media（D125 执行型参考插件）

第一方**执行型插件**（形态 B，[61 号设计 §2](../../docs/design/61-plugin-runtime-platform.md)）：
manifest 带 `runtime` 段、包内带打包后的 JS（`dist/main.js`），由宿主 PluginHost（P2）
以子进程按 IPC 协议执行。media 契约是**假实现**——不模拟网络、不调厂商 API：

- `generateImage`：两个 progress 事件（已排队 → 生成中，间隔 1.1s 以穿过 SDK 的
  1 次/秒限速窗口）后返回内置 1×1 PNG 的 data URL；
- `submitVideo` / `videoStatus` / `cancelVideo`：3 秒后 `succeeded` 的假任务，
  `videoUrl` 指向 `example.invalid` 占位（与 `runtime.network.allow` 一致）。

## 布局

```
plugin.json      清单（runtime: { entry: 'dist/main.js', hostApi: '^1', network.allow: ['example.invalid'] }；
                 contributions.capabilityModels 两条条目——reference-image（image）与
                 reference-video（video，P2 验收假视频轮询），均不填 engine）
package.json     仅声明 "type": "module"（Node 据此把 dist/main.js 按 ESM 加载）；非 workspace 包
src/main.ts      插件源码（definePlugin + runPluginRuntime，import @kepcup/plugin-sdk）
build.mjs        打包脚本：src/main.ts → dist/main.js（esbuild 单文件 ESM）
icon.svg         插件图标
```

## 构建

```bash
node plugins/reference-media/build.mjs
```

esbuild 复用仓库 devDependencies 的既有版本（apps/desktop，0.28.2），不引入新依赖；
`@kepcup/plugin-sdk` / `@kepcup/shared` alias 到 workspace 源码打进 bundle。打包约定
（`--bundle --platform=node --format=esm`、禁 native / `__dirname`）见
[packages/plugin-sdk/README.md](../../packages/plugin-sdk/README.md)。

## 校验

```bash
node packages/app-validator/dist/cli.js validate plugins/reference-media
```

## 备注

- `engines.kepcup` 对齐仓库应用版本（0.5.14，D125 P4 收口版本）；`runtime` 段随该版本可用。
- 实例凭据：执行型插件的实例字段声明面是 `runtime.instanceFields`（D125 P4 / DEV-114，
  复用 D105 字段 schema；`sensitive: true` 走实例 secrets，调用时经 `ctx.credentials`
  注入）。参考插件是假实现、不需要凭据，因此没有声明；真实插件参见
  [`plugins/dashscope-t2i`](../dashscope-t2i/)。
