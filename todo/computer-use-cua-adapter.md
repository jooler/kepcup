# 计算机操控 P-B1：cua-driver provider 适配

> 状态：**已实施（2026-11-07）**，本期范围全部落地；实施依据见
> [computer-use-cua-adapter-findings.md](computer-use-cua-adapter-findings.md)（WP0 探针 + 0.40.1 复核）。
> 与方案的偏差：①发布形态为完整 `CuaDriver.app` bundle（裸二进制被 AMFI SIGKILL，findings 架构级新发现 1）；
> ②`tree_format:"both"` + element_token 索引表（0.40 契约收敛，`element_index` 平铺形态已移除）；
> ③D 层冒烟落在 `computer-orchestration-smoke.mjs --provider=cua`（编排 smoke 是 sidecar 全链路的
> 维护入口，WP1 时代的 computer-use-smoke.mjs 已注明退役）。
> 前置阅读：`docs/design/52-computer-use.md`（D105 设计）、`todo/computer-use.md`（已落地的原生实现）、`docs/dev/DEVIATIONS.md` DEV-077~082。
> 本期范围：**只在 provider 层换实现**。不动审批、不动 core 工具、不新增工具、只验 macOS。Win/Linux 启用与新增工具（`launch_app` / `invoke_menu` / `zoom` / `verify_state`）是 P-B2，不在本期。
> 约定：迭代中只跑定向测试（`node scripts/run-tests.mjs run <文件或目录>`）；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`；收口跑一次全量 `pnpm test`。

## P-B2 全面切换（2026-11-10，已实施）

> 用户确认：计算机操控**只使用 CuaDriver**，不再自行实现；后续跟随上游更新适配；
> 原设计中 CuaDriver 不能满足的要求，设计方案做妥协（见 docs/design/52 修订节）。

- [x] macOS 唯一 provider = CuaDriver；删除 `KEPCUP_COMPUTER_PROVIDER` 开关与 native / script 分支。
- [x] 删除自研 macOS Swift helper、vendored orca 原生层、native / desktop-script provider 及其测试。
- [x] 权限状态/引导改为主进程 Electron `systemPreferences`：AX 触发系统提示，屏幕录制打开系统设置面板；TCC 归 KepCup 主应用。
- [x] `computer:stop` / `permissionsOpen` 通过杀掉 sidecar 终止 CuaDriver daemon；权限读取/打开只标记「下一次 invoke 前重启」，避免打断在途动作（同时修复主进程停不掉子进程 provider 的缺陷）。
- [x] 打包：`CuaDriver.app` 必需，`cua-driver.lock.json` 随包；`fetch-cua-driver.mjs --arch` 支持交叉打包；pack-hooks 强制校验。
- [x] 设计文档记录 12 条妥协（TCC 归属、无独立 helper、索引语义、focusedElementId、annotated/OCR、scroll/drag 验证、后台输入限制、max_elements 截断、direct-capture 二段同意、体积、Win/Linux）。
- [ ] 真机验收：干净机器重授权、macOS 26+ 二段同意、设置页刷新、stop 杀 daemon、发布包 lock 随包。
- [ ] 发布签名包：确认 `mac.signIgnore` 未重签 `CuaDriver.app`、`afterSign` 的哈希/上游签名校验通过、公证接受不同 Team ID 的嵌套 bundle。
- [ ] 上游跟进：季度或按需升版（`--record` 回填 lock → 复核 `click`/`get_window_state` 契约 → 单测 + live + smoke → 只改 `cua-driver-*.ts`，不扩散到 core 工具/审批）。

## 0 一页结论

| | 现役（自研 Swift helper） | 本期目标（cua-driver provider） |
|---|---|---|
| 自有非测试代码 | 15,531 行 | 约 4,000-6,000 行（保留 core 工具 + 审批 + B 口） |
| 平台 | macOS | 本期仍只验 macOS（结构上为三端留好位置） |
| 长尾怪癖 | 全部自有 | 上游承担 |
| 契约 | 自有 | 上游（吸收周期按季度，不跟发版） |
| per-action 审批 | 有 | **保留**（审批在 core 工具层，不随 provider 变） |

**为什么这套改动可控**：审批、工具描述、`outcome: 'uncertain'` 语义、敏感参数掩码全部位于 `packages/core/src/tools/computer-tools.ts`，在 `computer.invoke` 之上；provider 在 B 口之下。换 provider 不触碰它们——**这也是本期唯一的硬验收标准：core 既有测试零改动通过**。

## 1 接缝（先读这段，它决定了所有工作包）

```
packages/core/src/tools/computer-tools.ts          审批 / 描述 / outcome / 掩码   ← 不动
        │  computer.invoke（COMPUTER_INVOKE_METHODS，13 个方法）                 ← 不动
apps/desktop/src/main/computer/computer-sidecar.ts 方法分发 + treeBaselines       ← 不动
        │  provider 接口（5 个方法）
apps/desktop/src/main/computer/computer-provider-lifecycle.ts                     ← 只加一个分支
        ├─ MacOSNativeProviderClient       现役，保留作回退（不删）
        ├─ DesktopScriptProviderClient     win/linux 休眠壳，保留
        └─ CuaDriverProviderClient         本期新增
```

provider 接口（`macos-native-provider-client.ts` 的公开面，新实现照此实现）：

```ts
capabilities(): Promise<ComputerProviderCapabilities>
listApps(): Promise<ComputerListAppsResult>
listWindows(params: unknown): Promise<ComputerListWindowsResult>
snapshot(params: unknown): Promise<ComputerSnapshotResult>      // 树 + 截图 + 状态
action(method: NativeActionMethod, params: unknown): Promise<ComputerActionResult>
shutdown(): void
```

`NativeActionMethod` = `click | performSecondaryAction | scroll | drag | typeText | pressKey | hotkey | pasteText | setValue`。

**所以适配器的全部工作 = 把这 5 个返回类型从 cua 的输出造出来。** 返回类型定义在 `packages/shared/src/domain/computer.ts:75-190`，这些 schema 是验收基准，适配器必须过 zod。

## 2 工作包总览与依赖

```
WP0 探针 (M0)
 └─► WP1 二进制 + 生命周期
      └─► WP2 传输客户端
           ├─► WP3 归一化 ─┐
           └─► WP4 方法映射 ┴─► WP5 能力/权限 ─► WP6 装配/开关 ─► WP7 测试收口 (M4)
```

WP0 是**止损点**：它回答不了的问题，后面全是猜的。WP3 与 WP4 可并行。

## G0 开工前要确认的 3 件事

- [x] **驱动版本**：pin **0.40.1**（实施日最新稳定版，取代方案时的 0.38.x）而非对齐 OpenBot 的 0.34.0——吸收周期是季度，起点应当是最新而不是别人三个月前的。定下后写进 `resources/cua-driver.lock.json`，之后只按季度吸收。
- [x] **保留 macOS 原生 provider 作回退**（已保留，默认 provider 仍是 native）。删掉它就失去了「上游停更 / 某次破坏性变更太疼 / 某平台驱动回归」时的止损能力，而保留的成本接近零。
- [x] **本期只做 macOS**（P-B2 再开三端）。三端启用要额外的 CI runner、真机冒烟、Linux AT-SPI/GNOME 扩展，属于 P-B2。

> **已核实，无需决策**：索引契约**不用改**。`computer-tools.ts:54` 的 `ADDRESS_RULE` 本来就写着「观察会重排索引，旧索引失效」——cua 的快照内索引刚好就是这个语义。原生 helper 的跨快照稳定索引是对模型文档的**超集**行为，丢掉它不构成契约变更，也不影响任何既有测试断言。

## WP0 可行性探针（0.5-1 天，M0）

**目的**：用真二进制回答 6 个决定架构的问题，产出写入 `todo/computer-use-cua-adapter-findings.md`。**任一问题答案与预期不符（尤其 Q3/Q4），立即停在这里并回到方案 A**——此时沉没成本最低。

工具：本机开发期可直接用 `/Applications/CuaDriver.app/Contents/MacOS/cua-driver`；CI 用 WP1 的 fetch 脚本产物。注意本机若为 0.28.2 而目标版本不同，结论需在目标版本上复核。

- [x] **Q1 截图怎么拿**：`get_window_state` 的 `screenshot_out_file` 落盘 vs content item base64，哪种更省。要求：拿到 PNG 后能填 `ComputerScreenshotData{ data, format:'png', width, height, scale }`，且 `screenshot_scale` 与 `window_bounds` 足以无损换算坐标。
- [x] **Q2 树文本能否直接用**：`structuredContent.tree_markdown` 能否原样作为 KepCup 的 `treeText`（core 只当不透明文本 + 不可信包裹，不解析）。同时确认 `element_count` / `filtered_element_count` / 截断字段的名字。
- [x] **Q3 索引语义**：`element_index` 是否每次快照重排？`snapshot_id` 从哪里取？拿旧索引动作时报什么错误码？stale 与「动作已发出」可区分吗？**这一问决定 WP3 的工作量。**
- [x] **Q4 坐标空间**：cua 的 `click` / `drag` 的 `x,y` 是**窗口局部截图像素**，KepCup 的契约是**窗口点**。确认 `x_px = x_pt * screenshot_scale` 是否恒等；混合 DPI、窗口跨屏、`max_dimension` 降尺度三种情况下是否仍然成立。
- [x] **Q5 动作结果映射**：cua 的 `effect` / `verified` / verification / escalation 字段，能否映射到 `computerActionVerificationSchema` 的两个状态（`verified` / `unverified` + 8 个 reason 枚举）。特别是 `suspected_noop` / `unverifiable` 要落到哪个 reason，**不得简化成 verified**。
- [x] **Q6 权限归属**：直连 spawn（不经 `open -a`）时 TCC 是否记在 KepCup.app 名下；daemon 未启动时 `permissions status --json` 是否可用；`permissions grant` 是否会把授权记到 CuaDriver.app（若是，**禁止使用**，只能自己开系统设置面板）。

- 验收：findings 文档写完，6 问全部有答案 + 证据（命令、原始输出片段）；给出适配器预估行数与风险评级。**若预估 > 4,000 行或 Q3/Q4 无法无损映射，在本 WP 结束并回到方案 A。**

## WP1 二进制获取与 daemon 生命周期（1 天，M1 前半）

文件（新）：`apps/desktop/resources/cua-driver.lock.json`、`apps/desktop/scripts/fetch-cua-driver.mjs`、`apps/desktop/src/main/computer/cua-driver-paths.ts`、`cua-driver-process.ts`、`apps/desktop/electron-builder.yml`。

- [x] **pin 文件**：`{ version, tag, repository, assets: { "<os>-<arch>": { asset, assetSha256, files: { name: sha256 } } }, license, licenseSha256 }`。校验失败拒绝使用，不做「警告后继续」。
- [x] **fetch 脚本**：`dev` / CI 用，缓存 `~/.cache/kepcup/cua-driver/<version>/`，输出 `apps/desktop/resources/cua-driver/<os>-<arch>/`（gitignore）。支持 `--offline` 只用缓存。非 darwin 直接 exit 0。
- [x] **启动**：`serve --embedded --socket <私有目录>/driver.sock --no-overlay`（embedded 必须，findings Q6）；socket 目录 `0700`、socket `0600`，启动前检查路径长度上限（Unix socket 有 104 字节限制）。
- [x] **环境**：`CUA_DRIVER_EMBEDDED=1`、`CUA_DRIVER_PARENT_LIVENESS_STDIN=1`（保持 stdin 打开，父进程死则 daemon 死）、`CUA_DRIVER_RS_TELEMETRY_ENABLED=0`、`CUA_DRIVER_RS_UPDATE_CHECK=0`。
- [x] **孤儿清理**：启动前探测并 `stop` 上一次残留的 daemon；退出走 SIGTERM → 2s → SIGKILL，随后删 socket 目录（参照 `macos-native-provider-process-reaping.ts` 既有做法）。
- [x] **打包**：`electron-builder.yml` 加 `extraResources`；macOS 用 `signIgnore` 保留上游签名，不重签（否则公证会失败）。安装包预计 +47MB（darwin universal），在 release note 里写明。
- 验收：`node apps/desktop/scripts/fetch-cua-driver.mjs --version <pin>` 出产物且 sha256 全绿；手动 `serve` 后 `cua-driver status --json` 显示 running；杀掉父进程 daemon 自动退出。

## WP2 传输客户端（0.5 天，M1 后半）

文件（新）：`apps/desktop/src/main/computer/cua-driver-daemon-client.ts`、`cua-driver-error-map.ts`。

协议：daemon socket 上**一行一个 JSON 对象**，无请求 id，按顺序应答。

```jsonc
// 请求
{ "method": "call", "name": "<tool>", "args": { /* tool 参数 */ },
  "session_id": "kepcup-computer", "client_kind": "cli" }
// 同时也是：{ "method": "sessions_list", "client_kind": "cli" }
//           { "method": "session_end", "session_id": "...", "client_kind": "cli" }
```

- [x] 单连接、请求串行（一期不做并发）；行缓冲 + 上限（树可达 MB 级，取 32MB）；读超时 5s、`get_window_state` 单独 30s（AX 走查官方上限 20s）。
- [x] **错误码映射表**：driver 用小写下划线，KepCup 用大写枚举。**必须精确落到 `computer-tools.ts:computerErrorHint` 认识的这几个码上**，否则模型拿不到引导文案（落到 `default` 就等于没提示）：

| driver（小写） | KepCup `ComputerErrorCode` | 模型看到的引导 |
|---|---|---|
| `permission_denied` / `accessibility` 相关 | `PERMISSION_DENIED` | 去设置授权 |
| `app_not_found` | `APP_NOT_FOUND` | 先 `list_apps` 拿准确名字 |
| `window_id_not_found` / `window_owner_pid_mismatch` | `WINDOW_NOT_FOUND` | 重新选窗；message 里带上真实 `owner_pid` |
| 快照被替换 / 索引过期 / `screenshot_context_missing` | `ELEMENT_NOT_FOUND` | 重新 `get_app_state` 拿新索引 |
| 后台投递被拒（`background_unavailable`） | `BACKGROUND_UNAVAILABLE` | 后台输入不可用 |
| 二进制缺失 / 版本不符 / socket 不可用 | `COMPUTER_UNAVAILABLE` | 宿主不可用 |
| 其余未知码 | `accessibility_error` + 原始码进 message | 不透传原始小写码给模型 |

  **不重犯现役的坑**：`packages/shared/src/rpc/channel.ts` 只保留 `AppError` 的 code，`RuntimeClientError` 一律被压成 `INTERNAL`（`computer-tools.ts:90` 的 `default` 分支印证了这一点）。适配器必须自己抛带正确 code 的错误，并且有一条单测专门盯「未知码不会变成 INTERNAL 的白板」。不要静默降级，也不要把原始小写码透给模型。
- 验收：伪 daemon 单测覆盖正常应答、超时、断连、超长行、未知错误码。

## WP3 归一化层（1.5 天，M2）

文件（新）：`apps/desktop/src/main/computer/cua-driver-observer.ts`、`cua-driver-coordinates.ts` + 单测。

`snapshot()` 要造出 `ComputerSnapshotResult{ snapshot, screenshot, screenshotStatus }`：

- [x] `snapshot.id` / `app` / `window` / `coordinateSpace:'window'` / `treeText`（取 `tree_markdown`）/ `elementCount` / `focusedElementId`（无对应则 `null`，需在 findings 里确认）/ `truncation`（映射 `truncated`、`element_count`、`filtered_element_count`、`max_elements`、`max_depth`）。
- [x] `screenshot`：`data`（base64 PNG）、`width`、`height`、`scale`（= `screenshot_scale`）。`screenshotStatus` 三态对齐：没传 `screenshot:true` → `skipped(no_screenshot_flag)`；`degraded_reason` 存在或抓图失败 → `failed(code,message)`；其余 `captured`。
- [x] **坐标换算**（本期最容易出错的一处）：KepCup 契约是窗口点，cua 的 `x,y` 是窗口局部截图像素。适配器在 `action()` 入口做 `px = pt * scale`，出口不反向换算。单测必须覆盖 scale=1 / 2（Retina）/ 降尺度三种。
- [x] **索引直通**（实现走 element_token 索引表：快照后保存 index→token，动作查表换 token——0.40 契约只收 token，findings Q3）：把 cua 的 `tree_markdown` 和 `element_index` 原样给模型，动作时带上同一 `snapshot_id`；快照被替换后旧索引报 `ELEMENT_NOT_FOUND`，正好对应 `ADDRESS_RULE` 已声明的「观察会重排索引，旧索引失效」。**不需要改工具描述，也不需要维护跨快照索引映射**——这是本方案能保持低维护的关键，别在这里加东西。
- [x] `treeBaselines.apply` 的差分仍由 sidecar 在适配器之上做，适配器不要自己再算 diff（避免两层各算一遍）。
- 验收：录制的真实应答（fixtures）过 zod 全绿；三种 scale 的坐标换算单测全绿。

## WP4 方法映射（1 天，M2，可与 WP3 并行）

文件（新）：`apps/desktop/src/main/computer/cua-driver-actions.ts` + 单测。映射表见附录 A。

- [x] 9 个 `NativeActionMethod` → cua 工具。**只有 `pasteText` 不是 1:1**：拆成 `clipboard_write` + `hotkey(["cmd","v"])`，且必须保留 `unverified / clipboard_paste` 的验证语义（不得报 verified）。
- [x] `click` 分派：`click_count > 1` 走 `double_click`（cua 的 `count` 仅像素路径有效）；`mouse_button: 'right'` → `right_click` 或 `click{button:'right'}`；带 `element_index` 时优先 AX 路径，坐标路径仅在显式给 `x,y` 时使用。
- [x] `performSecondaryAction` → `click{ action }`，把 AX 动作名（`AXShowMenu` / `AXConfirm` / `AXOpen`…）归一化到 `show_menu` / `confirm` / `open` / `press` / `pick` / `cancel`；无法归一化返回 `ACTION_UNAVAILABLE`，不要猜。
- [x] `delivery_mode`：默认 background；参数里没有前台升级入口（P-B2 再加），保持与现役行为一致。带 modifiers 的点击显式拒绝（0.40 要求前台投递修饰键，不静默丢失）。
- [x] 动作后的观测：cua 的动作工具自带结果/截图则直接归一化；不带则按需补一次 `get_window_state{ include_accessibility_tree:false }`（便宜路径），避免模型多跑一轮。
- 验收：每个方法一条单测（参数映射 + 结果归一化）；`pasteText` 的组合路径单独一条，断言不会产出 `verified`。

## WP5 能力握手与权限（0.5 天，M3 前半）

文件（改）：`computer-provider-lifecycle.ts` 邻近新增 `cua-driver-capabilities.ts`、`cua-driver-permissions.ts`。

- [x] **能力合成**：cua 没有 `capabilities` 工具，需按「平台 + 版本」静态合成 `ComputerProviderCapabilities`。注意 core 会用它 gate 工具（`ensureCapability`），漏报会让工具被拒。本期按现役等价上报；`windows.focus` / `moveResize` / `surfaces.menus` 虽然 cua 支持，但**本期不要标 true**——对应工具还没暴露，虚报会让模型去用不存在的能力（P-B2 暴露工具时一起打开）。
- [x] **权限检测**：socket 上的 `check_permissions` 工具（CLI `permissions status` 只认 CuaDriver.app 身份的 daemon，embedded 恒 unknown——不用，findings Q6）→ `computer.permissionsStatus` 的既有返回结构。TCC 归属从独立 helper 变为 KepCup.app 本身，**这是用户可见行为变化**：老用户需要重新授权，且「重置权限」的目标 bundle 变了（`macos-tcc-reset.ts` 要改）。
- [x] **文案中性化**：`computer-tools.ts` 的 `SCOPE_RULE` 与 `PERMISSION_DENIED` 提示现在写死「KepCup Computer Use」和「设置 › 浏览器 › 计算机操控」（后者还是已迁移的旧路径，设置已独立为「计算机操控」段）。改成与 provider 无关的措辞（「KepCup」+ 实际锚点），原生 provider 与 cua 共用一份。改的是常量文本，core 测试不断言这些字符串（已核实），不影响硬验收。
- [x] **禁止**使用 `cua-driver permissions grant`：它经 LaunchServices 启动 CuaDriver.app，会把授权记到 `com.trycua.driver` 而不是 KepCup。只能自己打开系统设置对应面板（沿用 `computer.permissionsOpen` 现有实现）。
- 验收：授权/未授权两态的状态读取正确（真机手验）；未授权时工具报 `PERMISSION_DENIED` + 正确引导文案。

## WP6 装配、开关与 UI（1 天，M3 后半）

> **历史记录**：P-B2 已删除 `KEPCUP_COMPUTER_PROVIDER` 开关与 native / script 分支，
> 本节仅保留 P-B1 实施记录；当前语义以顶部「P-B2 全面切换」为准。

文件（改）：`computer-provider-lifecycle.ts`、`computer-host.ts`、`computer-sidecar.ts`（如需要）、`electron-builder.yml`、`apps/desktop/scripts/pack-hooks.cjs`（产物检查）。

- [x] `computer-provider-lifecycle.ts` 加 `CuaDriverProviderClient` 分支；选择顺序由开关决定：`KEPCUP_COMPUTER_PROVIDER=cua|native|script`（默认 `native`，本期不发版默认）。**原生 provider 代码保留在树里**。
- [x] 启动前置检查：二进制存在 + 版本匹配 pin + socket 可用，任一不满足 → provider 不可用（`computerProviderUnavailableMessage` 给可行动的原因），**不得**回落到原生 provider 而不告知（避免两套 provider 混用导致索引/快照状态错乱）。
- [x] `computer.stop` → session 结束 + SIGTERM daemon；tray 的「停止计算机操控」沿用。
- [x] 设置页：本期**不加** provider 切换 UI，只走环境变量（避免 settings 目录与卡片改动）。若确定要 UI，按 AGENTS.md 设置五层补目录条目 + 适配器 + 卡片 + `data-settings-anchor`，并跑 settings 四件套。
- 验收：`KEPCUP_COMPUTER_PROVIDER=cua` 启动后 `computer.capabilities` 返回非空；`=native` 行为与改动前一致；两组都不影响设置页。

## WP7 测试与 macOS 验收（1 天，M4）

### 分层

| 层 | 位置 | 跑在哪 | 依赖 |
|---|---|---|---|
| A 单元 | `cua-driver-*.test.ts` | 全部 CI | 伪 daemon（`node:net` 监听 tmpdir 路径；Windows 下等价为命名管道），按脚本应答 |
| B 契约 | 同上 + `fixtures/` | 全部 CI | 真实应答录制，过 zod |
| C 集成 | `cua-driver-provider.live.test.ts`（`describe.skipIf(!bin)`） | **仅 macOS 真机** | `KEPCUP_CUA_DRIVER_BIN` 存在；否则 skip |
| D 冒烟 | `apps/desktop/scripts/computer-use-smoke.mjs`（改造） | 发布前手跑 | 真实二进制 + TCC 授权 |

### 具体任务

- [x] A：伪 daemon 覆盖 5 个 provider 方法 + 9 个 action 方法 + 错误码映射 + 坐标换算 + 索引过期（cua-driver-provider.test.ts，42 用例）。
- [x] B：录制 0.40.1 真实 `get_window_state` / `click` / `type_text` 应答存 fixtures，断言 zod 通过且关键字段不丢（`screenshot_scale`、`element_count`、`degraded_reason`）。
- [x] C：用 TextEdit（系统必有，无需预装）跑闭环：`listApps` → `listWindows` → `getAppState`（含截图）→ `typeText` → `setValue` → `click`（按索引，**不使用固定坐标**）→ 再观测确认。断言不依赖窗口位置与语言。无 `KEPCUP_CUA_DRIVER_BIN` 时 `test.skip`，不让 CI 变红。
- [x] D：把编排冒烟 `computer-orchestration-smoke.mjs` 加 `--provider=cua` 分支（sidecar 全链路 + 截图可读性人眼复核；本机 5/6，截图项因 macOS 26+ direct-capture 二段同意未授而如实 failed，见 findings），对真实 App 跑一遍，产出「点击是否命中 / 截图是否可读」的人眼可判结果。
- [x] **硬验收（本方案成败判据）**：下面两条命令零改动通过——
      `node scripts/run-tests.mjs run packages/core/test/unit/computer-tools.test.ts`
      `node scripts/run-tests.mjs run packages/core/test/integration/computer-use.test.ts`
      通过 = 审批、掩码、`uncertain` 语义确实没有被 provider 替换影响。任何一条需要改测试，说明动到了接缝以上的东西，回头查。
- [x] 收口：`node scripts/run-tests.mjs run apps/desktop/src/main/computer/`；`pnpm --filter @kepcup/desktop typecheck`；最后跑一次全量 `pnpm test`。

### macOS 上怎么跑（可直接照抄）

```bash
# 1. 取二进制（首次）
node apps/desktop/scripts/fetch-cua-driver.mjs

# 2. 纯逻辑（不需要授权、不需要真机桌面）
node scripts/run-tests.mjs run apps/desktop/src/main/computer/cua-driver-provider.test.ts

# 3. 真机集成（需辅助功能 + 屏幕录制授予当前终端 / KepCup；缺二进制时自动 skip）
KEPCUP_CUA_DRIVER_BIN="$PWD/apps/desktop/resources/cua-driver/darwin-arm64/cua-driver" \
  node scripts/run-tests.mjs run apps/desktop/src/main/computer/cua-driver-provider.live.test.ts

# 4. 接缝回归（关键）
node scripts/run-tests.mjs run packages/core/test/unit/computer-tools.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/computer-use.test.ts

# 5. 手动冒烟（P-B2：CuaDriver 是默认且唯一 provider）
pnpm --filter @kepcup/desktop dev
```

> CI 注意：GitHub 的 macOS runner 无 GUI 会话与 TCC 授权，C 层必须 `skip`；真正的人工验收只能在真机上做，写进 `todo/computer-use.md` 的验收清单，不要假装 CI 覆盖了它。

## 风险与止损

| 风险 | 触发信号 | 止损动作 |
|---|---|---|
| 翻译层远超预期 | WP0 预估 >4,000 行，或 Q3/Q4 无法无损映射 | 停在 WP0，回到方案 A，沉没 1 天 |
| 上游破坏性变更 | 吸收新版本时参数/返回结构变化 | 变更被隔离在 `cua-driver-*.ts`；回退到上一版 lock pin + 重新 fetch 产物 |
| 上游停更 | 6 个月无发布 | 已在树里的原生 provider 即退路；不追加投入 |
| 安装包膨胀 | +47MB 不可接受 | 改为首次使用时下载（需签名校验 + 离线可用性设计），或仅 Windows/Linux 打包驱动 |
| TCC 行为变化 | 老用户升级后需重新授权 | release note 写明；`macos-tcc-reset.ts` 同步改目标 bundle |
| 无 GUI 的 CI 覆盖不到真实行为 | C 层长期 skip | 建立发布前真机冒烟清单，D 层必跑 |

## 附录 A：13 个 invoke 方法 → cua 工具

| invoke | provider 方法 | cua 工具 | 备注 |
|---|---|---|---|
| `capabilities` | `capabilities()` | 无 | 静态合成，见 WP5 |
| `listApps` | `listApps()` | `list_apps` | cua 含已安装未运行 |
| `listWindows` | `listWindows()` | `list_windows` | 需 `on_screen_only` 语义确认 |
| `getAppState` | `snapshot()` | `get_window_state` | 树 + 截图一起返回 |
| `click` | `action('click')` | `click` / `double_click` / `right_click` | 按 button + count 分派 |
| `performSecondaryAction` | `action('performSecondaryAction')` | `click{action}` | AX 动作名归一化，失败即 `ACTION_UNAVAILABLE` |
| `scroll` | `action('scroll')` | `scroll` | |
| `drag` | `action('drag')` | `drag` | 坐标为截图像素，需换算 |
| `typeText` | `action('typeText')` | `type_text` | AX `kAXSelectedText` |
| `pressKey` | `action('pressKey')` | `press_key` | |
| `hotkey` | `action('hotkey')` | `hotkey` | |
| `pasteText` | `action('pasteText')` | `clipboard_write` + `hotkey` | **非 1:1**，保留 `unverified/clipboard_paste` |
| `setValue` | `action('setValue')` | `set_value` | |

## 附录 B：daemon 协议要点

- socket 上一行一个 JSON 对象；请求无 id，应答按顺序匹配。
- `{"method":"call","name":"<tool>","args":{…},"session_id":"…","client_kind":"cli"}` 执行任意工具。
- 另有 `sessions_list` / `session_end`。
- 应答含工具结构化负载（`structuredContent`）与内容项（文本/图片）。截图优先用 `screenshot_out_file` 落盘，避免在 JSON 行里搬 base64。
- 快照是 `(pid, window_id)` 作用域，下一次同窗快照替换索引表——**动作前必须用同一 `snapshot_id`**。
