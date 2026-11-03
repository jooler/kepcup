# 52 计算机操控（Computer Use）

Bot 通过**无障碍树优先、截屏与键鼠兜底**读取并操作本机原生桌面应用的 UI：语义寻址（元素索引）、精确、可作用于后台应用、不抢焦点；树读不到的（canvas / 游戏 / Electron 内容区）退到截屏坐标与键盘。能力整体拆自 [stablyai/orca](https://github.com/stablyai/orca)（MIT，快照 commit `55507b87` / v1.4.214，本机只读镜像 `~/www/orca-mirror/orca`）的 computer-use 模块：**原生 helper 层照搬（vendored）、TS 编排层移植进 main 进程、集成层（工具 / 审批 / 设置 / RPC）按 KepCup 自有体系重建**。P0 仅 macOS；Windows / Linux 分期。

**状态：设计定稿（2026-10-31），待实施**；执行方案与工作包见 [todo/computer-use.md](../../todo/computer-use.md)。无 DB 迁移。

相关：D75 任务分治（[30](30-supervisor-and-tasks.md)，工具只在任务面注册）、D89 设置目录（[38](38-conversational-settings.md)，开关条目）、D58 失败续跑与审批卡（[18](18-inline-setup.md)）、浏览器宿主（main serve `browser.*` 的 B 口先例）、D102 headless 服务端（[49](49-headless-server.md)，能力降级）、D96 host-capabilities（[46](46-remote-control.md)）。

## 决策

- **D105 计算机操控**：
  1. **拆用 orca（MIT），三层对应搬运**：原生层 vendored 照搬（macOS Swift helper / Windows PowerShell / Linux Python，与宿主只有 unix socket / stdio JSON-line 协议边界，是 orca 全仓库里与宿主耦合最少、最可拆的部分）；TS 编排层移植进 `apps/desktop/src/main/computer/`（保持与 orca 相同的相对路径便于后续 diff 上游；解耦点仅 `@orca/process-host` 等少量工具函数）；orca 的 CLI 与 runtime RPC 层**不搬**（KepCup 用自己的 B 口 birpc 与工具体系）。上游以 vendored 快照固定，跟进走人工 diff 不自动同步；vendored 目录携带 `NOTICE.md`（来源、commit、MIT 声明，对齐插件 NOTICE 惯例）。
  2. **独立 helper .app 承载系统权限**（继承 orca 关键设计）：macOS 辅助功能（AX）与屏幕录制的 TCC 授权授给 `KepCup Computer Use.app`（bundle id `app.kepcup.desktop.computer-use`，G0 确认），不污染宿主应用；helper 无特殊 entitlement，经 Unix socket 与 main 通信，单会话互斥（并发第二个会话报 `CONTROLLER_BUSY`）。重命名、重签名，不直接复用 orca 产物。
  3. **能力宿主在 main 进程，core 经 B 口调用 `computer.*`**：镜像 browser 的「平台能力由 main serve 给 core」模式。main 负责 helper / sidecar 生命周期、权限状态检测与引导（仿 `sensor-permission.ts`）；core 不直接 spawn。理由：权限引导是 main 职责、core 保持平台无关；截图经 B 口的量级与 browser_screenshot 相同，可接受。headless（D102）B 口无此能力 → 工具不可用即拒调（对齐 `DeferredBrowserHostRpc`），并进 host-capabilities（desktop-only）。
  4. **工具面与 sidecar 方法一对一，粒度仿 browser 工具**：`computer_list_apps` / `computer_list_windows` / `computer_get_app_state` / `computer_click` / `computer_perform_action` / `computer_scroll` / `computer_drag` / `computer_type` / `computer_key` / `computer_paste` / `computer_set_value` / `computer_stop`（pressKey/hotkey 在工具层合一为 `computer_key`，sidecar 方法面不变；orca 的 selectText sidecar 未实现，P0 不暴露）。截图并入 `computer_get_app_state`（`screenshot` 参数）与各动作的可选返回，走 `ToolResult.images`；树文本复用输出截断。仅当「平台支持 + 设置开启 + helper 可用」时注册；**P0 仅任务 loop 注册**（重副作用能力，对话轮不需要），提示词规则进工具描述、不进常驻提示词、不新增技能。
  5. **审批与安全第一版做全**：新增 `ApprovalKind` `computer_control`，审批时长复用 once / conversation / bot 分档，**不设「永不问」档**；动作防重放对齐 orca / ZCode 验证过的语义——`ComputerActionVerification`（可能已下发）映射到 `ToolResult.outcome: 'uncertain'`，重试前必须先观察；`type` / `paste` / `set_value` 的文本参数标 `sensitiveParams`，不进审批卡明文与日志；粘贴走 orca 的剪贴板校验（防提示注入）；stop 三通道：模型 `computer_stop`、用户 renderer 常驻「停止操控」（main `ipcMain.handle` 直达 sidecar，不经 core）、sidecar 单会话互斥。**已知限制明示**：桌面级「用户正在手动操作」检测 v1 不做（技术上不可靠），靠审批档位与显式 stop 兜底；**权限被拒后绝不切换到 osascript / AppleScript / 系统事件等其他 UI 自动化技术**（写入工具描述与错误文案）。
  6. **设置目录一处开关 + 权限引导走设置页**：条目 `browser.computer-use`（group `browser`，anchor `computer-use`；条目增多再迁独立组），字段 toggle `enabled`，`store: { kind: 'settings', generic: true }`（顶层键 `computerUse.enabled`，默认关）+ `card: 'field-editor'`，`maxMode: 'user-only'`（安全开关，Bot 可出卡但宿主不采用 values，符合 D89 惯例），不进 `DIRECT_ITEM_IDS`。macOS 权限引导不做卡片：设置页 anchor 区块显示 helper 的 AX / 屏幕录制权限状态，一键打开对应系统设置 pane 并首次拉起 helper 注册 TCC（main 新增 `computer:permissions-status` / `computer:permissions-open` IPC，仿 sensor-permission）。
  7. **构建与分发跟随 KepCup mac 现有策略**：SwiftPM 按 arm64 / x64 分架构出包（不做 universal lipo，同 rg「平台私有二进制只打本机架构一份」）；`apps/desktop/scripts/build-computer-use-macos.mjs` 改造自 orca 构建脚本（重命名 / bundle id / icon / 签名）；release 用 Developer ID + runtime + timestamp + **helper 独立公证**（嵌入主包前单独 notarize，验收项），dev 用 Apple Development 身份；无有效签名身份时构建跳过 helper、能力整体不可用并明确报错（不静默降级）。electron-builder：helper 走 `extraResources`，sidecar 入口走 `asarUnpack`（`ELECTRON_RUN_AS_NODE` fork，对齐 stdio-proxy 先例）；pack-hooks 加「mac 包必须含 helper」校验。
  8. **平台分期**：P0 macOS（helper 需 macOS 14+，沿 orca 门控）；P1 Windows（`runtime.ps1` 零第三方依赖，验证 PowerShell 执行策略与 serve 通道）；P2 Linux（依赖 GNOME AT-SPI，KDE / 其他桌面明确报能力不可用）。能力集按平台经 `capabilities` 裁剪，工具描述不承诺跨平台一致。

## 1 调研结论摘要

### 1.1 orca computer-use 的三层构成（拆的就是这些）

| 层 | orca 位置 | 规模 | 与宿主的耦合 |
|---|---|---|---|
| 原生 helper | `native/computer-use-macos`（SwiftPM，18 文件 / ~6.2k 行 Swift；产物 `Orca Computer Use.app`，构建脚本 `config/scripts/build-computer-macos.mjs`，entitlements 为空 dict，release 签名 runtime+timestamp） | macOS | Unix socket + JSON-line；helper 独立 bundle 独立 TCC |
| | `native/computer-use-windows/runtime.ps1`（~1.4k 行，UIAutomation + Win32 P/Invoke，`-Serve` 常驻模式） | Windows | stdio JSON-line；**零第三方依赖** |
| | `native/computer-use-linux/runtime.py`（~1.5k 行，`gi.repository.Atspi`） | Linux | stdio JSON-line；依赖 GNOME |
| TS 编排层 | `src/main/computer/`（生产 ~5-6k 行，含测试 ~12k） | 全平台 | 出口仅 `@orca/process-host` 等 spawn 工具函数；`sidecar-client.ts` fork `computer-sidecar.js`（`COMPUTER_SIDECAR_ENTRY_FILENAME`，构建独立入口、asar.unpacked 解出） |
| 集成层 | `src/main/runtime/rpc/methods/computer.ts`（runtime RPC）+ `src/cli/specs/computer.ts` + `src/cli/handlers/computer.ts`（CLI）+ `skills/computer-use`（agent 技能文档）+ `src/shared/computer-use-runtime-types.ts`（206 行类型契约） | 薄 | 与 orca 自有 RPC / CLI 深绑，**不搬** |

sidecar 方法面（`computer-sidecar.ts` dispatch，树 diff 基线在 sidecar 进程内持有）：`capabilities` / `listApps` / `listWindows` / `getAppState` / `click` / `performSecondaryAction` / `scroll` / `drag` / `typeText` / `pressKey` / `hotkey` / `pasteText` / `setValue`。provider 选择在 `computer-provider-lifecycle.ts`：darwin 且 macOS 14+ 且 helper 可执行 → `MacOSNativeProviderClient`；否则 win/linux → `DesktopScriptProviderClient`（`desktop-script-runtime-host.ts` 按 spawn PowerShell / Python）。

macOS 原生层的关键机制（全部继承，不改语义）：无障碍树快照 + 稳定元素索引（`StableElementIndexes`）、后台输入注入（`BackgroundInputTransport`、`SyntheticMouseClickDelivery`）、键盘安全（`KeyboardInputSafety`）、权限信任静置（`PermissionTrustSettling`）、会话所有权与连接鉴权（`AgentSessionOwnership`、`AuthenticatedConnectionHangupMonitor`）、Unix socket 路径安全、树 diff 与大树按优先级裁剪（祖先保留）。

### 1.2 拆出可行性结论（调研于 2026-10-31）

- **MIT**，允许改名、再签名、商用。
- **先例**：本机 ZCode（ZCode.app）已走过同一条路——`/Applications/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app`（独立 helper .app + 自建 broker + SDK 插件；错误码语义 `CONTROLLER_BUSY` / `actionSent` 防重放等可参照）。
- **KepCup 侧每层都有先例**：B 口 birpc serve 宿主能力（browser.*）、`ToolResult.images`、external agent spawn / utilityProcess.fork / stdio-proxy asarUnpack、`extraResources` + 分架构（rg）、`ApprovalKind` 枚举与审批分档、`ControlLease`（人机接管语义）、settings-catalog 五层接入、sensor-permission IPC、pack-hooks 硬校验。
- 详细对接点核对见执行文档 WP 各节。

## 2 总体架构

```
任务 run（core, pi 引擎）
  └─ computer_* 工具（packages/core/src/tools/computer-tools.ts，新）
       ├─ 审批：gateway ensureControlApproval（ApprovalKind 'computer_control'）
       └─ B 口 birpc（core → main，镜像 browser.* 的 serverMethods）
            └─ main（apps/desktop/src/main/computer/，移植自 orca）
                 ├─ sidecar-client ──fork──► computer-sidecar.js（独立构建入口，
                 │        Node IPC dispatch；asar.unpacked 解出 + ELECTRON_RUN_AS_NODE）
                 │        ├─ 树 diff 基线（ComputerTreeBaselines，sidecar 进程内）
                 │        ├─ darwin: MacOSNativeProviderClient ──unix socket──► KepCup Computer Use.app（helper，独立 TCC）
                 │        └─ win/linux（P1/P2）: DesktopScriptProviderClient ──stdio──► runtime.ps1 / runtime.py
                 └─ 权限状态检测 / 系统设置引导（sensor-permission 式 IPC，供 renderer）
```

数据流要点：

- **观察**：`get_app_state` 返回紧凑树文本（首次全量，之后对基线做增量 diff；大树按优先级裁剪、索引可跳号），可选同帧截屏（base64 PNG）；`elements()` 级全量树按需。
- **动作**：元素索引寻址优先（索引绑定最近一次观察，观察重排索引），坐标兜底（坐标只来自最近一帧截屏栅格，转换由 helper 内部完成）；动作结果带验证元数据（可能已下发与否）。
- **会话**：helper 单会话互斥；main 持有 sidecar 生命周期（空闲回收 / 退出清理，沿 orca 的 reaping 与 shutdown 处理）。

## 3 main 进程集成（WP2）

- **移植清单**（orca `src/main/computer/` → `apps/desktop/src/main/computer/`，保持文件名）：`sidecar-client` / `computer-sidecar` / `computer-provider-lifecycle` / `computer-snapshot-tree-diff` / `computer-action-verification-normalization` / `computer-{clipboard,sidecar}-paste-validation` / `runtime-client-error` / `macos-native-provider-*`（client / socket / transport / paths / availability / contract / line-buffer / process-reaping / startup-cleanup）/ `macos-computer-use-permissions*`（含 permission-status）/ `desktop-script-*`（win/linux，随 P1/P2 激活）。解耦点：`@orca/process-host` 的 `spawnProcess` / `windows-system-binary` 换成 KepCup 等价（`node:child_process` 薄封装）；orca `forked-child-entry-path` 换成 KepCup 的入口解析（asar.unpacked 约定同 stdio-proxy）；诊断日志对接 KepCup main 日志。
- **B 口 serverMethods**（core → main，控制面与数据面分离，main 保持薄）：`computer.invoke { method, params }`（method 白名单 = sidecar 方法面，透传）、`computer.capabilities`、`computer.permissionsStatus`、`computer.permissionsOpen`、`computer.stop`。core 侧由 `packages/core/src/start.ts` 装配（对齐 browser host 的可选注入与 `DeferredComputerHostRpc` 拒调）。
- **用户 kill switch 走 main 直达**：`ipcMain.handle('computer:stop')` + preload `window.kepcup`，不依赖 core（core 卡死也要能停）；托盘 / 输入坞入口见 WP5。
- **打包**：sidecar 入口进 `asarUnpack`，fork 用 `ELECTRON_RUN_AS_NODE=1`（对齐 stdio-proxy.mjs 先例）。

## 4 core 工具面（WP4）

| 工具 | sidecar 方法 | 关键参数 |
|---|---|---|
| `computer_list_apps` | listApps | — |
| `computer_list_windows` | listWindows | `app` |
| `computer_get_app_state` | getAppState | `app`、`window_id?/window_index?`、`query?`、`max_elements?`、`screenshot?`（默认 false） |
| `computer_click` | click | `app` + `element_index` 或 `x,y`、`mouse_button?`、`click_count?`、`modifiers?`、`return_state?` |
| `computer_perform_action` | performSecondaryAction | `app`、`element_index`、`action` |
| `computer_scroll` | scroll | `app` + 目标、`direction`、`pages?` |
| `computer_drag` | drag | `app` + 起止（索引或坐标） |
| `computer_type` | typeText | `app`、`text`（sensitive）、`element_index?` |
| `computer_key` | pressKey / hotkey | `app`、`text`（键或 `+` 弦）、`repeat?`、`hold_seconds?` |
| `computer_paste` | pasteText | `app`、`text`（sensitive）、`format?` |
| `computer_set_value` | setValue | `app`、`element_index`、`value`（sensitive） |
| `computer_stop` | （stop 会话） | `reason?` |

- **结果语义**：树文本进 `content`（超长走 `TOOL_OUTPUT_MAX_CHARS` 截断）；截屏进 `ToolResult.images`（模型不支持图像时按 `SCREENSHOT_OMITTED_NOTE` 惯例降级）；动作的 `ComputerActionVerification` 映射 `outcome`（未下发 → 正常；可能已下发 → `uncertain`，工具结果明示「先观察再决定重试」）。
- **scroll 没有可断言属性**：`computer_scroll` 没有 `focusedText` / `selection` / `value` 这类可读回的目标值，helper 投递后在 150–400ms 内重取一次快照（不带截图），用元素签名（role/title/label，**不含 frame**）配取整的窗口内 y 做指纹，比较滚动前后的布局：移动了也不报 `verified`（仍按 `synthetic_input` / `accessibility_action_unasserted`），位移写进 `actualPreview`；「读回明确说没动」才换像素单位（480pt/页）重试一次，仍没动 → `suspected_noop`；树重排导致可比样本不足 → `readback_unsupported`；AX `AXScroll*ByPage` 被接受但没动时回落到指针路径（`fallbackReason: accessibilityActionNoop`）。后台投递滚轮前必须先发一个带窗口戳的 `mouseMoved`（前台路径一直这么做），否则 pid 投递的滚轮不进目标窗口（`BackgroundInputTransport.scrollEvents`）。
- **注册与门控**：`buildResponseTools` 按条件装配——任务 loop、平台支持（B 口 capabilities）、`computerUse.enabled` 为真；否则整组不出现。工具描述承载用法规则（无障碍优先、观察-动作-再观察、索引寻址、坐标只取当前帧栅格、权限被拒不换技术、验证后才算完成），浓缩自 orca `skills/computer-use`。
- **错误**：`RuntimeClientError` 的 code 原样透传（`PERMISSION_DENIED` / `APP_NOT_FOUND` / `CONTROLLER_BUSY` / `STALE_STATE` …），工具层补人话与引导（如权限被拒 → 指设置页 anchor）。

## 5 审批与安全（WP4）

- 新 `ApprovalKind` `computer_control`（`packages/shared/src/domain/types.ts` 审批枚举扩展 + 审批卡文案 + 无人值守默认不自动批准，对齐 D99 的保守取向：**无人值守期间 computer_control 永不自动批准**，加进 `NEVER_AUTO_DECIDED`）。
- 授权范围：复用 once / conversation / bot 分档，默认 conversation（G0 确认）；同一 run 内首个 computer 动作前出卡。
- 敏感参数：`type` / `paste` / `set_value` 的文本在审批卡与日志脱敏（`sensitiveParams` 机制）；粘贴前过 orca 剪贴板校验。
- 防重放：`uncertain` outcome 的动作禁止引擎盲目重试（提示词规则 + 工具结果明示）；sidecar 单会话互斥兜底并发。
- 边界：web 页面内操作一律走 browser 工具（工具描述写明）；不支持全屏自由坐标操控（能力是「应用窗口级」），多屏 / 负坐标窗口观察沿用 orca 能力。

## 6 设置与权限引导（WP3 + WP5）

- settings-catalog 条目 `browser.computer-use`：fields `[toggle enabled]`、`write: write('user-only')`、`card: 'field-editor'`、`store: { kind: 'settings', generic: true }`（路径 `computerUse.enabled`）、`deepLink: settings/browser/computer-use`；按目录惯例补 contributions 适配器、渲染层卡片分支、`data-settings-anchor`、覆盖率测试（漏登记会挂 `settings-adapters-coverage.test.ts`）。
- 设置页 anchor 区块（browser 分区新增 `computer-use`）：开关 + helper 权限状态（AX / 屏幕录制，各自「已授权 / 未授权 / 未知」）+「打开系统设置」按钮；状态与打开动作走 main 的 `computer:permissions-status` / `computer:permissions-open` IPC（首次拉起 helper 以注册 TCC，沿 orca permission-status 的静置检测）。
- 权限未就绪时工具返回结构化 `PERMISSION_DENIED` + 引导文案，Bot 可用设置工具指路（deepLink）。

## 7 构建与打包（WP1 / WP5）

- vendored 目录（保持 orca 相对布局便于 diff 上游）：`apps/desktop/native/computer-use-macos/`（SwiftPM 原样）+ `NOTICE.md`（来源 URL、commit `55507b87`、MIT、修改说明）。Windows / Linux 原生目录随 P1 / P2 搬。
- 构建脚本 `apps/desktop/scripts/build-computer-use-macos.mjs`（改造自 orca `build-computer-macos.mjs`）：产物 `resources/computer-use/darwin-${arch}/KepCup Computer Use.app`；bundle id `app.kepcup.desktop.computer-use`；图标用 KepCup icns；签名身份解析沿 orca 逻辑（env 显式指定 > Apple Development（dev）> Developer ID（release）> 无身份则跳过并让打包校验报错）；release 加 `--options runtime --timestamp --entitlements`（entitlements 空 dict，随 KepCup 资源放置）。
- electron-builder.yml（mac 块）：`extraResources` 加 `from: resources/computer-use/darwin-${arch}` → `to: KepCup Computer Use.app`；`asarUnpack` 加 sidecar 入口；pack-hooks.cjs 加 mac 包 helper 存在性校验；公证流水线补「helper 先单独公证再嵌入」（验收用真公证构建验证）。
- CI：macOS runner 需 SwiftPM（脚本在非 darwin 直接 exit 0 的语义保留）；打包机无 Xcode 时 fail-fast。

## 8 分期、边界与风险

- **M1** helper + sidecar 独立冒烟（node 脚本直调 fork，不经 core）→ **M2** B 口 + core 工具端到端 → **M3** 审批 / 设置 / 权限引导 / stop UI → **M4** 打包公证 + 真机验收 + 收口。WP ↔ M 映射见执行文档。
- **P0 范围**：macOS arm64 + x64；任务 loop；12 个工具；conversation 默认审批档。
- **不做**（永不做或 P1+）：全屏自由坐标桌面操控；对话轮注册；「永不问」审批档；桌面级用户接管检测；AppleScript / 系统事件兜底路径；自动同步上游。
- **风险**：① 签名 / 公证是最大非代码成本——helper 无有效公证时 TCC 授权在升级后可能反复丢失，体验回退（缓解：CI 公证 + 验收项）；② 上游漂移——orca 每日发版，vendored 快照 + 人工 diff，协议（socket / stdio JSON-line）稳定则跟进成本低；③ 树过大 —— max_elements + 截断 + diff 已是 orca 成熟方案，但真机要测大应用（浏览器 / IDE）；④ Windows / Linux 在 P1 / P2 才验证，工作量估计不含返工；⑤ headless 场景（D102）能力不可用，务必对齐 browser 的降级表现并写进文档。
