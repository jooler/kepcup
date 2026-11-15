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
                 contributions.capabilityModels 一条 image 条目，不填 engine）
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

- `engines.kepcup` 当前对齐仓库应用版本（0.5.14）；`runtime` 段真正可用的最低版本以
  P2（PluginHost 接线）发版为准，届时按需抬高。
- 实例凭据：本阶段 manifest schema 对执行型条目没有凭据字段声明位（D124 的实例字段
  从引擎 `credentialFields` 并集派生，执行型条目无引擎）——假实现不需要凭据；声明位
  在 P2 安装管线补（61 §2「凭据字段名进同意卡披露」）。
