# 计算机操控（D105）— 执行方案

> 状态：**已实施**（P0 原生 helper 2026-10-31 落地；P-B1 cua-driver provider 适配 2026-11-07 落地；
> **P-B2 2026-11-10 全面切换为 CuaDriver-only，原生 helper / script provider 已删除**，
> 见 [computer-use-cua-adapter.md](computer-use-cua-adapter.md) 与
> [computer-use-cua-adapter-findings.md](computer-use-cua-adapter-findings.md)）。
> 设计见 [docs/design/52-computer-use.md](../docs/design/52-computer-use.md)（D105，先读它的 §1 构成、§2 架构、§4-§6 集成设计再开工）。
> 上游参照：stablyai/orca 快照 commit `55507b87`（v1.4.214），本机只读镜像 `~/www/orca-mirror/orca`（浅克隆，勿改动、勿提交进 KepCup 仓库）。vendored 时在该 commit 基础上搬运。
> 约定：迭代中只跑定向测试（AGENTS.md：`node scripts/run-tests.mjs run <文件>`）；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；收口跑一次全量 `pnpm test`。改设置相关代码至少跑 settings 四件套定向测试。

## P-B1 真机人工验收清单（CI 覆盖不到的部分，发布前必跑）

CI 的 macOS runner 无 GUI 会话与 TCC 授权，`cua-driver-provider.live.test.ts` 在无
`KEPCUP_CUA_DRIVER_BIN` 时自动 skip——以下项只能在真机人工验收，不要假装 CI 覆盖了它：

1. **授权流**：干净机器上首次使用 → 系统设置的辅助功能 /
   屏幕录制行出现的是 **KepCup**（embedded 语义，不是 CuaDriver）→ 授权后工具即恢复。
   ⚠️ **禁止 `cua-driver permissions grant`**：embedded daemon 下它把 TCC 记到
   com.trycua.driver 名下，破坏授权归属且难还原（findings「授权语义」节）。授权只能
   走系统设置给 KepCup，或对系统弹出的同意框点允许；授权后重启 KepCup（TCC 按进程缓存）。
2. **macOS 26+ direct-capture 二段同意**：首次截图会如实报 `screenshot_failed`（findings
   0.40.1 新增发现 2）——验证错误文案可行动（2026-11-07 复检补：截屏失败与被挡的
   scroll/drag 报错现在都带「系统设置 › 屏幕录制给 KepCup 授权 + 重启」指引）、
   授权后截图恢复、设置页权限状态正确。
3. **唯一 provider**：darwin 上只有 CuaDriver（不再有 native / script 分支）；非 darwin
   报「尚未启用」。`KEPCUP_COMPUTER_PROVIDER` 开关已删除，不要再按旧文档设置。
4. **安装包**：含 CuaDriver.app 的包（+约 60MB/架构）在 release note 写明体积变化；
   pack-hooks 对 cua 产物做「存在才校验」的签名 + lock 哈希检查。
5. **升级重授权**：cua 期的 TCC 记在 KepCup 主应用名下——原生 helper 时代（独立
   `app.kepcup.desktop.computer-use`）的授权行不再被使用，老用户升级后需按新语义重新授权
   （release note 写明）。

### 复检遗留（2026-11-07 真机复检，待排期）

- **原生 provider drag 无读回**：`drag(rows)` 只回 `{path:synthetic, actionName:null,
  delivery:background}`，没有 verification 字段——拖错位置（实测把目录拖进另一目录）
  无从发现，与「防重放语义不可省」的硬要求有差距。候选方案：helper 侧复用
  ScrollReadback 的布局指纹做 drag 前后对比（Swift + 编排层 + core 三层改动，
  超出 P-B1 范围，列入后续工作包）。
- **wiki「computer-use-smoke-script」页失实**：写的 `scripts/computer-use-smoke.mjs`
  实际在 `apps/desktop/scripts/`；页里标「已退役」但文件仍在且有用（P-B1 复检正是靠它
  验证 scroll 读回）。wiki 在仓库外，待修正页面（改路径 + 状态改「M1 独立冒烟，仍可用」）。

## 0 工作包总览与依赖

```
G0 用户决策（签名身份 / 名称 / 默认审批档）
WP1 vendored 原生层 + 构建脚本 ─► WP2 main 编排层移植 ─► WP3 shared 契约 ─► WP4 core 工具与审批 ─► WP5 设置/引导/打包/收口
        （M1 独立冒烟在 WP1 末；M2 端到端在 WP4 末；M3=WP3+WP4+WP5 前半；M4=WP5）
```

WP2 与 WP3 可并行（接口以设计文档 §2/§3 的方法面为准）；WP4 依赖 WP2+WP3；WP5 收尾。

## G0 用户决策（开工前确认）

- [x] helper 名称与 bundle id：`KepCup Computer Use.app` / `app.kepcup.desktop.computer-use`（沿用主应用 appId 前缀）。
- [x] 签名：确认 KepCup 现有 Developer ID 身份可用于 helper（release 公证账号复用主应用的）；无则先解决再进 WP5，dev 期用 Apple Development 身份即可开工。
- [x] 审批默认档：conversation（首次使用出卡，会话内不再逐动作询问）。
- [x] P0 平台范围确认：仅 macOS。

## WP1 vendored 原生层与构建（macOS）（M1 前半）

文件：`apps/desktop/native/computer-use-macos/`（整目录自 orca `native/computer-use-macos` 原样搬运：`Package.swift` + `Sources/OrcaComputerUseMacOS{,Core}` + `Tests/`）、`apps/desktop/native/NOTICE.md`（新）、`apps/desktop/scripts/build-computer-use-macos.mjs`（新，改造自 orca `config/scripts/build-computer-macos.mjs`）、entitlements（空 dict，放 `apps/desktop/resources/build/entitlements.computer-use.mac.plist`）、`apps/desktop/resources/computer-use/darwin-${arch}/`（构建产物，gitignore）。

- [x] 搬运 SwiftPM 包，**不改任何 Sources 语义**（可以改的只有：文件头不加、包名不改——保持上游 diff 能力）。
- [x] `NOTICE.md`：来源 URL、commit `55507b87`、MIT 许可证全文引用、本仓库相对路径映射、改动说明（当前无）。
- [x] 构建脚本：SwiftPM release（单目标架构，跟随打包目标 arch，不做 lipo）→ 组 `.app`（Info.plist 模板改造：bundle id、显示名 `KepCup Computer Use`、KepCup 图标）→ codesign（身份解析沿 orca：env 显式 > Apple Development（dev）> Developer ID（release，`--options runtime --timestamp --entitlements`）> 无身份则跳过并打警告）；非 darwin exit 0。
- [x] 独立冒烟：手写一次性 node 脚本（computer-use-smoke.mjs，Electron 宿主形态，DEV-077 例外记录）（放 `apps/desktop/scripts/` 临时或 tests/ 手动夹具）直接 fork orca 的 `computer-sidecar.ts`（tsx / 编译后）发起 `listApps` / `getAppState` / 对「备忘录」`click`，验证 helper socket 通路与 TCC 弹窗行为。
- 验收：`swift build` 出包成功；冒烟脚本在本机真机跑通（首次会弹辅助功能 / 屏幕录制授权，授给 helper 而非主应用）。

## WP2 main 进程编排层移植（M1 后半）

文件：`apps/desktop/src/main/computer/`（新，自 orca `src/main/computer/` 移植，文件名保持）+ `apps/desktop/electron.vite.config.ts`（main 构建入口加 `computer-sidecar`，对齐 orca `MAIN_BUILD_ENTRY_POINTS` 做法）+ `apps/desktop/electron-builder.yml`（`asarUnpack` 加 sidecar 产物路径）+ B 口方法装配（main 侧 serverMethods 注册处，对齐 `browser-host.ts` / `core-host.ts` 的 `serverMethods` 模式）。

- [x] 移植并解耦（仅这些点动刀，其余原样）：`@orca/process-host` 的 `spawnProcess` / `windowsSystemBinary` → `node:child_process` 薄封装；orca `forked-child-entry-path` → KepCup asar.unpacked 入口解析（对齐 `stdio-proxy.mjs` 先例）；fork 改 `ELECTRON_RUN_AS_NODE=1`；诊断日志接 main 日志；`process.resourcesPath` 候选路径改为 `KepCup Computer Use.app`（保留 `KEPCUP_COMPUTER_MACOS_HELPER_APP_PATH` 环境变量覆盖，对齐 orca 的 `ORCA_COMPUTER_MACOS_HELPER_APP_PATH`）。
- [x] `macos-computer-use-permissions*` / `permission-status*` 原样移植（TCC 检测、静置、清理）。
- [x] B 口 serverMethods：`computer.invoke`（method 白名单透传 sidecar：capabilities / listApps / listWindows / getAppState / click / performSecondaryAction / scroll / drag / typeText / pressKey / hotkey / pasteText / setValue）、`computer.capabilities`、`computer.permissionsStatus`、`computer.permissionsOpen`、`computer.stop`；core 断连 / main 退出时走既有 `shutdownComputerProviders` 清理（沿 orca 的 signal/disconnect/beforeExit 处理）。
- [x] 用户 kill switch：`ipcMain.handle('computer:stop')` + preload `window.kepcup.computerStop()`（不经 core）。
- [x] desktop-script-*（win/linux 分支）一并移植但保持休眠（provider 门控不激活），避免 P1/P2 再搬一次。
- 验收：main 手动调 `computer.invoke { method:'listApps' }` 拿到应用列表；`getAppState` 树文本与截图正常；`computer:stop` 立即停会话；二次并发动作报 `CONTROLLER_BUSY`。

## WP3 shared 契约与设置目录（M3 前半，可与 WP2 并行）

文件：`packages/shared/src/domain/computer.ts`（新）、`packages/shared/src/domain/types.ts`（`approvalKindSchema` 加 `computer_control`；无人值守 `NEVER_AUTO_DECIDED` 加同名项，对齐 D99 语义）、`packages/shared/src/rpc/methods.ts`（core RPC 如需 `computer.stop` 用户面透传则登记）、`packages/shared/src/domain/host-capabilities.ts`（desktop-only 能力标记 `computerUse`）、settings-catalog：`packages/shared/src/settings-catalog/items.ts`（条目 `browser.computer-use`）+ `packages/core/src/settings/contributions/`（适配器贡献或并入现有组；`adapters.ts` 实现 toggle 写入）+ `apps/desktop/src/renderer/src/lib/features/settings-card/cards/index.ts`（`field-editor` 分支，若需登记卡片键则同步 `SettingCardEmbed.svelte`）+ 设置页 `data-settings-anchor="computer-use"`。

- [x] `domain/computer.ts`：AppRef / AppInfo / WindowInfo / SnapshotData / ScreenshotData / ActionVerification / ProviderCapabilities / 错误码枚举——以 orca `src/shared/computer-use-runtime-types.ts`（206 行）为蓝本裁剪成 KepCup 命名（zod schema + 类型）。
- [x] settings 条目（按 AGENTS.md 设置五层（键平铺 computerUseEnabled，DEV-078），注意三层校验都会跑）：id `browser.computer-use`、group `browser`、scope `global`、fields `[field('enabled','启用计算机操控','toggle')]`、`write: write('user-only')`、`card: 'field-editor'`、`store: { kind:'settings', generic:true }`（顶层键 `computerUse.enabled`，默认 false——检查 core 设置 schema / 默认值合并处是否需要登记新顶层键）、`deepLink: { surface:'settings', section:'browser', anchor:'computer-use' }`、不进 `DIRECT_ITEM_IDS`。
- [x] host-capabilities：`computerUse` 标 desktop-only，远程 / 服务端裁剪。
- [x] 定向测试：`packages/shared/test/unit/settings-catalog.test.ts` + `packages/core/test/unit/settings-item-writes.test.ts` + `packages/core/test/unit/settings-adapters-coverage.test.ts` + `apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts` + 新增 `computer-contracts.test.ts`（schema round-trip）。
- 验收：settings 四件套全绿；`pnpm --filter @kepcup/shared build` 通过。

## WP4 core 工具、审批与端到端（M2 / M3 后半）

文件：`packages/core/src/tools/computer-tools.ts`（新）、`packages/core/src/tools/index.ts`（`buildResponseTools` 注册 + 门控）、`packages/core/src/gateway/index.ts`（`computer_control` 审批决策）、`packages/core/src/permissions/approvals.ts`（卡片文案 / 分档）、`packages/core/src/start.ts`（`DeferredComputerHostRpc` 式可选注入与拒调）。

- [x] 工具实现：12 个工具 → B 口 `computer.invoke`（映射表见设计 §4）；截图进 `ToolResult.images`（模型无图像能力时 `SCREENSHOT_OMITTED_NOTE` 降级，对齐 `tool-execution.ts` 既有惯例）；树文本走 `TOOL_OUTPUT_MAX_CHARS`；`ComputerActionVerification` → `outcome`（possibly-sent → `uncertain` 并在结果文本明示「先观察再决定重试」）。
- [x] 门控：任务 loop 且 host 有 `computerUse` 能力且 `computerUse.enabled` 为真才注册；错误码透传 + 人话引导（`PERMISSION_DENIED` 指设置页 anchor）。
- [x] 审批：run 内首个 computer 动作前 `ensureControlApproval`（once/conversation/bot 分档，默认 conversation）；`type`/`paste`/`set_value` 文本标 `sensitiveParams`；审批被拒发生在动作前 → 正常失败结果（不标 uncertain）。
- [x] 工具描述承载用法规则（无障碍优先 / 观察-动作-再观察 / 索引寻址 / 坐标只取当前帧 / 权限被拒不换技术 / web 内容走 browser 工具 / 验证后才算完成），浓缩自 orca `skills/computer-use/SKILL.md`。
- [x] headless 降级：`apps/server` 场景工具不注册或拒调，表现对齐 browser（`DeferredBrowserHostRpc` 模式）。
- 验收：真机任务端到端——「把备忘录里的一条笔记标题改成 X」→ 出审批卡 → 授权 → 观察 / 动作 / 再观察完成；未授权时任务得到结构化权限引导；并发第二个任务操控时报 `CONTROLLER_BUSY` 不重试。

## WP5 权限引导 UI、打包与收口（M4）

文件：`apps/desktop/src/main/sensor-permission.ts`（仿其加 `computer-permissions` IPC）+ `apps/desktop/src/preload/index.ts` + `apps/desktop/src/main/index.ts`（`ipcMain.handle`）+ 设置页 browser 分区 `computer-use` anchor 区块（开关 + 权限状态 + 打开系统设置按钮）+ renderer 停止控件（输入坞 / 任务详情在 computer run 活跃时显示「停止操控」）+ `apps/desktop/electron-builder.yml`（mac `extraResources`：`resources/computer-use/darwin-${arch}` → `KepCup Computer Use.app`）+ `apps/desktop/scripts/pack-hooks.cjs`（mac 包 helper 存在性硬校验）+ 公证流水线（helper 由外层 .app 公证连带校验嵌套代码，不单独 notarize，见 DEVIATIONS DEV-081；`dist.mjs` 0c 每架构强制新鲜构建）+ `docs/dev/PROGRESS.md` / `DEVIATIONS.md` 记录。

- [x] 权限引导：状态三态（已授权 / 未授权 / 未知）；「打开辅助功能设置」「打开屏幕录制设置」按钮（`x-apple.systempreferences:` 深链）+ 首次拉起 helper 注册 TCC（沿 orca permission-status 静置检测）。
- [ ] 打包验证清单：dev（Apple Development）与 release（Developer ID + runtime + timestamp + notarize）各出一包；**真机验收**——新装包首次使用 TCC 弹窗指向 helper；升级重装后授权不丢（公证有效时）；无签名身份构建 → 打包 fail-fast（pack-hooks）。
- [x] 平台门控回归（单测 + web 垫片 desktop-only 拒绝；真机 Windows/Linux 回归随 P1/P2）Windows / Linux 上工具组不出现；headless 场景不可用。
- [x] 收口：跑一次全量 `pnpm test`；PROGRESS / DEVIATIONS 记录；本执行文档勾结。
- 验收：发布级安装包在干净机器完成一次完整 computer use 任务（授权 → 使用 → stop）。

## 分期与里程碑

- **M1**（WP1+WP2）：helper 通路独立冒烟跑通，不经 core。
- **M2**（WP4 前半）：core 工具端到端（可先不带审批裸跑内部验证）。
- **M3**（WP3+WP4 后半）：审批 / 设置 / 敏感参数 / 降级齐备。
- **M4**（WP5）：签名公证打包 + 真机验收 + 收口。

## 风险与注意

1. **不改 vendored 原生层语义**——helper Swift 代码一行不改；发现 bug 先在 TS 层绕，必要时回上游 commit 单独评估。
2. **签名公证是 M4 最大不确定项**——G0 先确认身份；无公证的包只做内部验证，不对外。
3. **防重放语义不可省**：`uncertain` outcome 与「先观察再重试」是 orca / ZCode 事故验证过的设计，实现时不得简化为 `Promise<void>` 式的「成功即 void」。
4. **权限被拒不兜底**：不引入 osascript / AppleScript / 系统事件替代路径；错误文案与工具描述都写明。
5. **大树性能**：真机用重应用（浏览器 / IDE）验证 `max_elements` 与 diff 行为，防 token 爆炸。
6. **上游跟进**：orca 每日发版；vendored 快照固定，协议（socket / stdio JSON-line）层面稳定，人工 diff 每 1-2 个季度一次或按 bug 驱动。
