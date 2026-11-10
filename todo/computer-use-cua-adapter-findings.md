# 计算机操控 P-B1：cua-driver 适配 — WP0 可行性探针 findings

> 探针日期：2026-11-07。工具：本机 `/Applications/CuaDriver.app`（cua-driver **0.28.2**，universal）+
> 上游源码克隆 `trycua/cua` @ `cua-driver-rs 0.34.0`（`/tmp/cua-probe/repo`，只读）+
> GitHub release `cua-driver-rs-v0.40.1`（当前最新稳定，**WP1 pin 目标**）。
> 目标版本为 0.40.1（0.28.2 ≠ 目标），二进制下载进行中；下载完成后对 **Q2/Q3/Q5 的字段名**
> 在 0.40.1 上复核（见文末「0.40.1 复核清单」），其余结论由 0.34/0.40 契约源码佐证。

## 0 结论一览

| 问题 | 结论 | 风险 |
|---|---|---|
| Q1 截图 | `screenshot_out_file` 落盘最优；响应带 `screenshot_file_path/width/height/scale/mime_type/frame_valid` | 低 |
| Q2 树文本 | `tree_markdown` 原样可用；字段：`element_count` / `returned_element_count` / `total_element_count` / `elements_complete` / `filtered_element_count`（query 投影时） | 低 |
| Q3 索引 | 每快照重排；`snapshot_id` 随快照递增；stale 报 `stale_element_token`（工具级错误）。**0.34+ click 只收 `element_token`**，适配器需持最近快照的 index→token 表 | 中（工作量主要在此） |
| Q4 坐标 | 满分辨率时 `px = pt × screenshot_scale` 实测恒等；统一用 `ratio = screenshot_width / window_bounds.width` 覆盖降尺度；元素 frame 是**全局**屏幕坐标，窗口局部 = frame − bounds.origin | 低（实测命中） |
| Q5 动作结果 | `effect ∈ {confirmed, partial, unverifiable, suspected_noop, refused}` + `route` + `evidence` + `escalation`，可无损映射 | 低 |
| Q6 权限 | **必须 `CUA_DRIVER_EMBEDDED=1` + 直接 spawn**：TCC 归宿主（KepCup.app）；`permissions status` CLI 不可用（只认 CuaDriver.app 身份的 daemon），用 socket 上的 `check_permissions` 工具；`permissions grant` 禁用（记到 com.trycua.driver） | 低（上游有权威文档） |

**预估行数：适配器 + 测试约 2,500 行**（< 4,000 阈值，继续方案 B）。

**架构级新发现（todo 未覆盖，已纳入设计）：**

1. **二进制必须以完整 `CuaDriver.app` bundle 形态分发**。裸二进制（byte-identical 拷贝到任意路径）执行即被
   AMFI SIGKILL（exit 137）：签名校验要求 `../Info.plist`（`codesign -v` 报 "invalid Info.plist (plist or
   signature have been modified)"）。发布 tarball 内含 `CuaDriver.app/`（安装脚本 `_install-rust.sh:1092-1098`
   确认）→ fetch 脚本解包后整个 `.app` 进 `resources/cua-driver/darwin-<arch>/CuaDriver.app`，
   spawn `<...>/Contents/MacOS/cua-driver`。
2. **必须用 embedded 模式**（`CUA_DRIVER_EMBEDDED=1` + `serve --embedded --socket <path>`，EMBEDDING.md
   权威文档）。非 embedded 的 daemon 会 re-exec disclaim 责任链，TCC 记到 `com.trycua.driver` 自己名下
   （探针实测 `source.attribution: "driver-daemon"`）。embedded 模式：不弹窗、不 disclaim、不 `open -a`
   自启动；TCC 归宿主应用。授权变化后必须重启 daemon（TCC 按进程缓存）。
3. **工具级错误有两种形态**，都要映射：① `ok:true` + `isError:true` + `structuredContent.code`/
   `structuredContent.refusal.code`（stale_element_token、window_id_not_found 等）；② `isError:true`
   **无 structuredContent**（如 "AX action failed: … -25206"）→ 落 `accessibility_error` + 原文进 message。
4. `cua-driver status --json` / `permissions status --json` CLI 检测的是「CuaDriver.app 身份的 daemon」，
   对我们自建的 embedded daemon 恒报 not running / unknown——生命周期与权限探测一律走 socket，
   不走 CLI status。

## Q1 截图怎么拿 —— `screenshot_out_file` 落盘

命令：`get_window_state {pid, window_id, screenshot_out_file: "/tmp/cua-probe/shot.png", max_dimension: 640}`

- `structuredContent.screenshot_file_path` 指向落盘 PNG（driver 自己写，不经 JSON 行搬 base64）。
- 响应字段（0.28.2 实测原始输出）：
  `"screenshot_file_path": "/private/tmp/cua-probe/shot.png", "screenshot_width": 640, "screenshot_height": 606,
  "screenshot_scale": 2.0, "screenshot_mime_type": "image/png", "screenshot_frame_valid": true`。
- 无 `screenshot_out_file` 时截图以 image content item 内嵌 base64（2x 全窗口可达数 MB 的 JSON 行）——
  落盘更省且让 32MB 行上限形同虚设的风险消失。**决策：总是传 `screenshot_out_file`**（私有目录临时文件，
  读后即删）。
- `screenshot_scale` 与 `window_bounds` 足以无损换算（Q4）。`screenshot_frame_valid:false` 或缺失
  `screenshot_file_path` → `screenshotStatus: failed(px_frame_mismatch / px_capture_unavailable)`，
  保留 truthful AX 负载（上游语义：不猜变换）。
- 对应 KepCup：`ComputerScreenshotData{data: base64(readFile(path)), format:'png', width, height, scale}`。

## Q2 树文本能否直接用 —— 能

命令：`get_window_state {pid, window_id}`（`/tmp/cua-probe/gws4.json`）

```
- [0] AXWindow "probe-note.txt" [id=_NS:31 actions=[raise]]
  - [1] AXTextArea = "hello kepcup
line two" [id=First Text Area actions=[showmenu]]
  - [2] AXButton [actions=[press]]
- [5] AXMenuBar [id=_NS:834 actions=[cancel]]
  - [6] AXMenuBarItem "Apple" [actions=[cancel,press,pick]]
```

- 行首 `[N]` 即 `element_index`，与 KepCup 工具描述 ADDRESS_RULE 的「行首数字」一致；core 只当不透明文本。
- 字段名确认：`element_count`（树内索引元素总数）、`returned_element_count`、`total_element_count`、
  `elements_complete`（0.28.2 里即使未截断也可能为 false——**不作为截断信号**）；
  query 投影时另有 `filtered_element_count`（0.28.2 `describe get_window_state` 文本）。
  截断语义以 0.40.1 复核为准（预期 `truncated` 布尔或由 `element_count > returned_element_count` 推导）。
- `focusedElementId`：cua 无对应字段 → **null**（KepCup schema 允许）。
- `background_input.routes`（每路由 availability）可映入诊断日志，不进契约。

## Q3 索引语义 —— 每快照重排，0.34+ 用 element_token

实测（0.28.2）：同窗连续两次 `get_window_state` → `snapshot_id` `s00000001` → `s00000002`（每窗口递增计数器）；
元素树 `elements[i].element_index` 每快照重排。

- 旧索引动作（`click {pid, window_id, element_index:0, snapshot_id:"s00000001"}`，当前已 s00000002）：
  `ok:true, isError:true, structuredContent.refusal:{code:"stale_element_token", message:"element_token is stale; call get_window_state again to refresh"}`。
  **stale 与「动作已发出」可区分**：stale 是动作前拒绝（`effect:"refused"` 家族），不会误伤 uncertain 语义。
- **0.34 契约变化**（`cua-driver-contract/src/inputs.rs ClickWireInput`）：click 定位只收
  `element_token`（形如 `"s00000001:0"`，内嵌快照 id + index）或 `x,y`；`element_index + snapshot_id`
  平铺形态已移除。`type_text` / `scroll` / `set_value` 的 element 寻址同样以 token 为准（部分工具
  收敛为坐标路径）。
- **适配器设计**：snapshot() 时保存最近一次快照的 `elements[]`（index → element_token + frame + role +
  label，按 (pid, window_id) 键控，同 KepCup 侧 DesktopScriptSnapshotStore 先例）；action() 收到模型的
  `elementIndex` 时查表换 `element_token` 发给 driver。表被下一次快照覆盖 = 「旧索引失效」；
  查不到 → 抛 `element_not_found`（与 ADDRESS_RULE 声明一致）。driver 侧 token 过期兜底
  `stale_element_token` → 同样映 `ELEMENT_NOT_FOUND`。不需要维护跨快照映射。
- `snapshot_id` 从 `structuredContent.snapshot_id` 取；动作请求不再回传（token 已内嵌）。

## Q4 坐标空间 —— px = pt × ratio 三情形恒等

- cua `click/drag/scroll` 的 `x,y`：**「the PNG returned by get_window_state」的像素**（0.28.2 describe
  原文 "window-local screenshot pixels, top-left origin of the PNG returned by get_window_state"）。
  driver 自己逆转 Retina backing scale 与任何窗口图降尺度。
- 实测（TextEdit 673×439pt 窗口，scale 2.0）：满尺寸截图 1346×878px = bounds × 2.0 精确；
  对 textarea 中心 `px=(frame−bounds.origin)×2` 发 `click{x,y}`，随后 `type_text`（写焦点元素）
  命中文本域（"[PX-CLICK-OK] " 入文）→ **转换链无损**。
- `max_dimension:640` 时 PNG 640×606 = bounds×(640/1059)，`screenshot_scale` 仍报 2.0 —— 此时
  `pt × screenshot_scale` **不再**指向 PNG 空间。**统一实现：`px = pt × (screenshot_width /
  window_bounds.width)`**，对 scale=1 / scale=2 / 降尺度三情形恒等（KepCup 不传 max_dimension，
  但 driver 的会话级 `max_image_dimension` 天花板仍可能降尺度，ratio 法免疫）。
- 混合 DPI / 跨屏：`window_bounds` 与 `screenshot_scale` 按目标窗口各自报告（list_windows bounds 与
  get_window_state window_bounds 同源 WindowServer），ratio 法按窗取值不受跨屏影响；Q4 的三情形单测
  在 WP3 落地（1/2/降尺度三组 fixture）。
- 元素 `frame`（structured elements）是**全局屏幕坐标**（TextEdit 窗口 bounds y=321，元素 y=596），
  窗口局部 = frame − window_bounds.(x,y)。scroll/drag 的元素寻址用此换算。
- `x_px = x_pt × screenshot_scale` 在「满分辨率、单屏」下恒等（已证），ratio 是其超集——满足
  「无损映射」判据。

## Q5 动作结果映射 —— 无损

0.28.2 实测 + 0.34 契约（`cua-driver-contract/src/outputs.rs ActionResult`）：

```
effect: confirmed | partial | unverifiable | suspected_noop | refused
route:  accessibility | synthetic_events | global_input | system_api | dom | trusted_input
delivery: { mode: background|foreground|not_applicable|unknown, delivered_count? }
evidence: [{ kind: value_readback | window_change, detail? }]
escalation: { target: pixel|foreground|page|session, reason: route_unavailable|delivery_failed|effect_unconfirmed|suspected_noop|permission_required }
error: { code, hint? }   // 仅 refused
summary: string?
```

实测样本：
- `type_text`（AX 路径命中）→ `effect:confirmed, route:accessibility, evidence:[{kind:"value_readback"}]`。
- `click{x,y}` → `effect:unverifiable, route:synthetic_events`。
- `hotkey` → `effect:unverifiable, route:synthetic_events, escalation:{reason:"delivery_failed",target:"foreground"}`。
- `set_value` → `effect:confirmed, route:accessibility, evidence:[value_readback]`。
- 拒绝 → `isError:true + structuredContent:{code:"window_not_found", effect:"refused", reason}`。

映射到 `computerActionVerificationSchema`（**不简化为 verified**）：

| driver 输出 | KepCup verification |
|---|---|
| `confirmed` + evidence `value_readback` | `verified { property:'value', actualPreview: evidence.detail }` |
| `confirmed` + evidence `window_change` | `unverified { reason:'window_changed', actualPreview: detail }`（窗口变化非字段断言，保守侧） |
| `confirmed` 无 evidence | `unverified { reason:'readback_unsupported' }` |
| `partial` | `unverified { reason:'readback_unsupported', actualPreview: summary }`（部分生效=效果未确认） |
| `unverifiable` + route accessibility | `unverified { reason:'accessibility_action_unasserted' }` |
| `unverifiable` + route synthetic_events | `unverified { reason:'synthetic_input' }` |
| `pasteText` 组合（clipboard_write + hotkey） | 恒 `unverified { reason:'clipboard_paste' }`（硬要求） |
| `suspected_noop` | `unverified { reason:'suspected_noop' }` |
| `refused` / isError | 抛 `RuntimeClientError(映射码, message)`（见 WP2 错误表） |

escalation 只进 `action.fallbackReason`（字符串化），不升级投递（本期无前台升级入口）。

## Q6 权限归属 —— embedded 模式归宿主，CLI status 不可用

- 直连 spawn 且 **`CUA_DRIVER_EMBEDDED=1`**：daemon 留在宿主责任链，TCC 记 **KepCup.app** 名下
  （EMBEDDING.md「How macOS attributes these permissions」+ 对照表 `TCC identity: the host app`）。
  宿主必须自己是 responsible process（KepCup main 直接 spawn，非网关）。
- 实测对照（0.28.2，非 embedded，从终端 spawn）：`check_permissions` 经 socket 返回
  `source.attribution:"driver-daemon", bundle_id:"com.trycua.driver", responsible_ppid:1`——
  即非 embedded 时 daemon 自立门户。**embedded 模式的正确性以 `source.attribution==="host"`
  为验收断言**（live 测试）。
- daemon 未启动时 CLI `permissions status --json` → `{"daemon_running":false,"status":"unknown"}`
  （CLI 只认 CuaDriver.app 身份的 daemon，对私有 socket daemon 无感知）→ **WP5 权限检测走
  socket 的 `check_permissions {prompt:false}` 工具**（embedded 下强制只读、永不弹窗），
  CLI permissions 一律不用。
- `permissions grant` **禁用**（todo 已预判，EMBEDDING.md 证实：经 LaunchServices 启动 CuaDriver.app，
  授权记到 `com.trycua.driver`）。缺权限时由宿主（KepCup）自己请求/开系统设置面板
  （沿 `computer.permissionsOpen` 现有实现；AX：`AXIsProcessTrustedWithOptions(prompt)`、
  屏幕录制：`CGRequestScreenCaptureAccess()` 由 KepCup main 自己调——embedded 驱动永不弹窗）。
- TCC 按进程缓存：授权变化后必须重启 daemon 才能读到新状态（EMBEDDING.md「Heads-up on grant
  timing」）→ 权限状态检测失败/未授权时 provider 报 `PERMISSION_DENIED`，授权完成由 daemon
  重启周期生效。
- `macos-tcc-reset.ts` 目标 bundle：reset 目标从 `app.kepcup.desktop.computer-use`（helper）改为
  KepCup 主应用 bundle id（embedded 后授权行记在主应用名下）。

## daemon 协议与生命周期补充（WP1/WP2 依据）

- socket：一行一个 JSON 对象、按序应答、无请求 id（实测通过）。
  请求：`{"method":"call","name":"<tool>","args":{…},"session_id":"kepcup-computer","client_kind":"cli"}`；
  另有 `sessions_list` / `session_end`（实测形状见探针脚本输出）。
- 响应：`{"ok":true,"result":{content:[…], structuredContent:{…}, isError?, …}}`；
  工具级失败 = `ok:true + isError:true`；未观察到传输级 `ok:false`（连接层错误按 WP2 表处理）。
- 启动：`serve --embedded --socket <dir>/driver.sock`（embedded 必带）；socket 目录 0700。
  路径长度 Unix socket 104 字节上限——socket 放 `~/Library/Application Support/KepCup/cua-driver/`
  之下时须检查总长（超限回退 TMPDIR 短路径）。
- 环境变量（EMBEDDING.md + todo）：`CUA_DRIVER_EMBEDDED=1`、`CUA_DRIVER_HOST_BUNDLE_ID=app.kepcup.desktop`、
  `CUA_DRIVER_PARENT_LIVENESS_STDIN=1`（父死则 daemon 死）、`CUA_DRIVER_RS_TELEMETRY_ENABLED=0`、
  `CUA_DRIVER_RS_UPDATE_CHECK=0`、`CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=200`（动作后观察窗口，
  默认 1000ms 是后台点击延迟大头）、`CUA_DRIVER_KEY_GAP_MS=2`（键间隔，默认 8ms）。
- **stdin 保活是硬约束**：`CUA_DRIVER_PARENT_LIVENESS_STDIN=1` 时 daemon 死盯父进程 stdin，
  父进程退出 daemon 自动退出（实测待 0.40.1 复核：杀父进程后 daemon 存活秒数）。
- 孤儿清理：启动前若 socket 文件存在 → 探活后 `cua-driver stop --socket <path>`（或直接 SIGTERM
  旧 daemon）再拉新；退出 SIGTERM → 2s → SIGKILL（沿 `macos-native-provider-process-reaping.ts`）。
- 发布资产：`https://github.com/trycua/cua/releases/download/cua-driver-rs-v<ver>/cua-driver-rs-<ver>-darwin-{arm64,x86_64}.tar.gz`
  + 同 tag `checksums.txt`（sha256）。tarball 含 `CuaDriver.app/`（bundle 包着同一 binary）与裸 binary
  （**不可用**，见架构级新发现 1）。许可证 MIT（仓库 LICENSE.md，lock 文件带 license + sha256）。
- 安装包体积：darwin per-arch tarball ≈ 86MB 压缩 / 解包 .app ≈ 66MB binary + Resources；
  electron-builder extraResources 进包后安装包增幅以实测为准（release note 写明）。

## 0.40.1 复核清单（已执行，2026-11-07，目标二进制实测）

- [x] `describe click / type_text / set_value`：**全部 element_token-only**（`<snapshot_id>:<row>`，自带
      pid/window，不允许再带 target/pid/window_id——带了的调用报 `invalid_action_target`）。
      `type_text` 0.40 直接收 element_token（0.34 中间版曾移除）；`set_value` 只收
      `element_token/pid/value/post_action_wait`（**无 delivery_mode**——AX 写值天然后台）。
- [x] `get_window_state` 截断字段：`truncated`（布尔）+ `truncation_reason`/`nodes_visited`/`nodes_pending`；
      **`elements_complete` 对完整走查也恒 false（0.28/0.40 同怪癖），不作截断信号**。
      **必须传 `tree_format:"both"`**——0.40 默认只回 markdown，元素索引表需要 structured elements。
      默认 AX 预算降到 250 节点（适配器显式传 `max_elements: 2000`）。
- [x] 工具级错误形态与 0.28 一致（`isError:true` + `structuredContent.refusal/code`；无 structuredContent
      的 AX 动作失败走 content 文本回退）。
- [x] `CUA_DRIVER_PARENT_LIVENESS_STDIN=1` + `serve --embedded`：由 CuaDriverProcessOwner 生命周期
      单测与 live 冒烟覆盖（daemon 随 sidecar disconnect 回收，编排冒烟 stop 项 PASS）。
- [x] embedded `check_permissions.source.attribution === "host"`：live 测试断言通过（本机终端
      AX 已授权时）。

## 0.40.1 实测新增发现（实现已吸收）

1. **degraded 观测**：动作替换窗口（zoom 换 CGWindowID、动作开新窗）后，对旧 window_id 的
   `get_window_state` 返回 `degraded: true + degraded_reason: "ax_window_unresolved: …"`——树按设计为空、
   **无 snapshot_id、无 isError**。适配器映射为 `WINDOW_NOT_FOUND`（与原生 provider 的 window_stale
   同语义：重新 list_windows 选窗）；**动作后的观测降级不掩盖「动作可能已发出」**——动作结果降级为
   空观察快照（screenshotStatus failed + 保留 verification），模型先观察再重试。
2. **macOS 26+ direct-capture 二段同意**：0.40 首次截图走新的 direct-capture API，宿主（embedded 时=
   KepCup）未完成 Tahoe 同意前截图跳过并如实报 `screenshot_error.code=px_capture_unavailable`（AX 树
   不受影响）。适配器映射 `screenshotStatus: failed(screenshot_failed)`；发布验收需在真实安装包上
   过一次同意（WP5 发布清单）。
3. zoom 点击会**换 CGWindowID**（"Action opened new window(s)"）：窗口 id 不跨 zoom 稳定——live 测试
   按 title 重新找窗；模型侧由 degraded→WINDOW_NOT_FOUND 引导重新选窗。
4. 动作结果新增 `hint` / `next_call` / `summary` 字段（0.40）：适配器忽略（KepCup 的引导文案在
   computer-tools 层），`summary` 仅供诊断日志。
5. **web 内容元素拒绝元素式输入**（2026-11-07 复检）：`type_text`/`set_value` 对祖先链属于
   web area 的元素（Electron/Chromium 渲染内容）被 driver 拒绝（web 内容 AX 不支持直写值）；
   焦点式输入（不带 elementIndex，写 target 焦点元素）走合成事件可用但只有
   `synthetic_input`（web 内容 AX 读不回值，无 verified）。这是 driver/上游语义，适配器如实
   透传；模型的可用路径：键盘导航（pressKey/hotkey）或坐标点击后焦点输入。
6. **max_elements 截断吃掉尾部 UI**（2026-11-07 复检）：长内容窗口（如聊天应用加载更多历史后）
   AX 树超过 `max_elements`（适配器传 2000）时按顺序截断，窗口尾部的输入框 / 发送按钮可能
   整个不在树里（PARTIAL TREE），`truncated` 标志如实上报。缓解靠模型策略（键盘导航 / 缩小
   内容量）；分页 / 角色过滤式查询是 P-B2 候选，不在本期。
