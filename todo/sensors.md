# 传感器统一管理 — 执行方案（D76）

> 状态：**P1–P4 代码已完成（2026-10-08），待跨平台实机验收**（设计见 `docs/design/31-sensors.md`；实机项见 `todo/cross-platform-acceptance.md` 末节）。分 P1→P4 四个阶段，每阶段有**门禁**（不通过不进入下一阶段）。本文是给编码 Agent 的**自包含交接**。
>
> **硬约束**：
>
> - 只改本地工作树；**不要** `git commit` / `push` / 开 PR（除非用户另行明确要求）。
> - 本期**零 core 改动、零 RPC 改动**；摄像头**只**做硬件走通（枚举 / 授权 / 设置页预览），不做任何 Bot 侧能力。
> - 麦克风现有行为（语音键、授权门、60s / 500ms 限制、WAV 管道、设备选择）**零回归**。
> - 开工前先看 `git status` 与本文勾选情况，避免与其他会话在同一工作树撞车；不要 `git checkout` / reset 不是自己写的文件。
> - 测试一律在 Docker 镜像 `kepcup-test:trixie` 中按 `node scripts/run-tests.mjs run [files]` 运行（e2e 用 `kepcup-test:trixie-xvfb`）；容器内**不要** `pnpm test` / `pnpm install`。基线：单元 / 集成 33 项环境失败，e2e 3 项失败（均与本任务无关）。

## 0. 先读什么

1. `docs/design/31-sensors.md` — **产品契约**（全文）。
2. `docs/design/26-voice-input.md` — 现有麦克风行为（TCC 授权门、采集管道、设备选择），本期要收编而不能破坏。
3. 现有代码：
   - `apps/desktop/src/renderer/src/lib/features/chats/mic-access.ts`、`voice-recorder.ts`、`Composer.svelte`（约 285–400 行语音段）
   - `apps/desktop/src/renderer/src/lib/features/settings/HardwareSection.svelte`、`SettingsDialog.svelte`
   - `apps/desktop/src/main/index.ts`（`mic:*` IPC，约 180–196 行）、`apps/desktop/src/preload/index.ts`
   - `packages/shared/src/domain/host-capabilities.ts`（注册表写法范式）
   - `apps/desktop/electron-builder.yml`（`mac.extendInfo`）
4. `docs/dev/01-conventions.md`、`05-testing.md`。

## P1 契约 + 主进程 / preload 泛化

- [x] `packages/shared/src/domain/sensors.ts`：`sensorKindSchema`（zod enum：`microphone`、`camera`）、`SensorKindDescriptor`、`SENSOR_KINDS`（本期两项，`transport` 均 `webmedia`）；从 shared 入口导出。
- [x] shared 单测：描述表每项字段合法、`id` 唯一、`osMediaType` 与 `dataShape` 组合合法。
- [x] 主进程：`mic:status|request|openSettings` → `sensor:permission:status|request|openSettings`（参数 `kind`，zod 校验，未知 kind 拒绝）；TCC 映射走描述表的 `osMediaType`；系统设置深链 `Privacy_Microphone` / `Privacy_Camera`；非 macOS 或 `osMediaType === null` 恒 `granted`。将映射逻辑抽成可注入 `systemPreferences` 的纯函数以便单测。
- [x] preload：三个 `mic*` 替换为 `sensorPermissionStatus(kind)` / `sensorPermissionRequest(kind)` / `sensorOpenSettings(kind)`；`PreloadApi` 类型随之更新。
- [x] 渲染层调用点临时适配新 preload 名（`mic-access.ts` 内部改调，对外签名不变），保证本阶段结束时麦克风行为不变。
- [x] `electron-builder.yml`：`mac.extendInfo` 增 `NSCameraUsageDescription`（文案：用于在设置中预览摄像头及将来的监看功能）；核对 hardened runtime 的 entitlements 文件是否含 `device.audio-input`，同步补 `com.apple.security.device.camera`（若项目当前无 entitlements 文件，在 todo 末尾「发现的问题」记录，不自行引入签名体系）。
- 实现备注：主进程逻辑在 `apps/desktop/src/main/sensor-permission.ts`（纯函数，注入 `systemPreferences`）；渲染层 `mic-access.ts` 仅改调用 preload 新名。项目当前**没有** entitlements 文件（`mac.identity: null`，未签名构建），故 camera entitlement 记入「发现的问题」，分发签名时随 `device.audio-input` 一并补。
- **门禁（已通过：typecheck / lint / 新单测 + voice-recorder 单测，Docker 内 12 项全绿）**：typecheck / lint 通过；shared 与主进程单测通过；现有 `voice-recorder.test.ts` 等不变地通过；手动：dev 下语音键仍能录音转写。

## P2 渲染层 sensors 层 + 迁移麦克风

- [x] 新建 `apps/desktop/src/renderer/src/lib/sensors/`：
  - [x] `types.ts`：`SensorDriver`、`SensorDevice`、`SensorAccess`、`OpenedSensor`（含 `resolvedDeviceId`、`fellBack`）。
  - [x] `webmedia.ts`：枚举（按 kind 过滤 `audioinput` / `videoinput`）、授权门（调 P1 的 IPC，无桥环境放行）、`open`（`exact` → `OverconstrainedError` → 裸设备回退并 `fellBack: true`；错误信息透传沿用 `describeMicError` 风格）。
  - [x] `microphone.ts` / `camera.ts`：仅约束；麦克风沿用现有 `CAPTURE_CONSTRAINTS`。
  - [x] `registry.ts`：`getDriver(kind)`，未实现 transport 抛错。
  - [x] `sensors.svelte.ts`：store（`enabled` / `deviceId` / `devices` / `access` / `lastError`）、`devicechange` 监听与卸载清理、偏好读写 `kepcup.sensors.v1`、旧键 `kepcup.micDeviceId` 迁移（只读导入，不删旧键）、`enabled` 默认值取描述表 `defaultEnabled`。
- [x] `voice-recorder.ts`：`startVoiceRecording` 取流改走 store 的 `open('microphone')`；删除其内部 `openMicStream`；WAV / worklet / 电平逻辑不动。回退发生时通过返回值或回调让 `Composer` 能 toast 提示「所选设备不可用，已使用系统默认」。
- [x] `Composer.svelte`：授权门与设备读取改用 sensors 层；`enabled === false` 时点语音键 toast 提示去「设置 → 硬件」启用（不静默失败）；不改 UI 结构。
- [x] `mic-access.ts`：保留为薄兼容层或删除并改所有引用（二选一，倾向删除，引用点仅 Composer 与 HardwareSection）。
- [x] 单测（伪造 `navigator.mediaDevices`、`window.kepcup`）：枚举过滤、exact→回退并报告、`devicechange` 刷新、偏好迁移（旧→新、旧键保留）、localStorage 抛错降级、`enabled=false` 时 `open` 拒绝、`getDriver` 未实现 transport 抛错。
- **门禁**：新旧单测全绿；`voice-recorder.test.ts` 不变地通过；手动：语音键录音转写正常，设置页选的设备仍被使用。

## P3 设置页数据驱动 + 麦克风增强

- [x] `SensorCard.svelte`：头部（名称 + 启用开关）、设备下拉 + 刷新、权限区（徽标 + 授权 / 打开系统设置）、测试区插槽。
- [x] `MicrophoneTest.svelte`：点击「测试」才开设备，电平条复用 `levelToHeight`，再点或离开分区 / 卸载时释放轨道。
- [x] `HardwareSection.svelte` 改为遍历 `SENSOR_KINDS` 渲染 `SensorCard`（P3 阶段摄像头卡可先只带头部 + 设备 + 权限，测试区在 P4 接）。
- [x] 设备丢失 / 回退的显式提示（卡片内告警文案）；权限被拒时的引导。
- [x] i18n：`zh-CN.ts` 增传感器名称 / 说明（`sensors.microphone.*`、`sensors.camera.*`）、权限状态、测试、回退提示等文案；保留现有 `settings.mic*` 键直到无引用再清理。
- [x] e2e `apps/desktop/test/e2e/sensors.spec.ts`（Playwright，伪设备参数 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` 由 spec 自己传给 `_electron.launch`，不进应用代码）：设置页麦克风默认启用 → 点测试 → 电平条 > 0 → 停止。**语音键 → 录音胶囊的 e2e 未做**：需先给 Bot 对话配好 asr 能力才会出录音 UI（否则是设置卡），留待 asr 配置夹具就绪后补。
- **门禁**：单测 + 新 e2e 全绿（e2e 基线失败项不增加）；手动：拔插麦克风，列表自动更新；选中设备拔掉后出现回退提示。

## P4 摄像头走通 + default session 权限收紧 + 跨平台验收

- [x] `CameraPreview.svelte`：点击「预览」才开设备，`<video autoplay muted playsinline>` + `srcObject`；离开分区 / 关闭弹框 / 卸载 / 关闭启用开关时 `track.stop()` 并清 `srcObject`。
- [x] 摄像头卡接入测试区；默认 `enabled=false` 验证（首次进入硬件页摄像头为关，预览按钮禁用并提示先启用）。
- [x] e2e：启用摄像头 → 预览 `<video>` 出现且 `videoWidth > 0`；关闭后 `MediaStream` 轨道 `readyState === 'ended'`。
- [x] **default session 权限审计**（静态审计：渲染层只用 `getUserMedia`、`navigator.clipboard.writeText`、`<video controls>` 全屏键；通知走主进程 `Notification`；处理器对被拒请求记 `[permissions] denied request` warn 供运行时发现遗漏）。原计划：先在 `session.defaultSession.setPermissionRequestHandler` / `setPermissionCheckHandler` 里临时只做日志（dev 下跑一遍：对话、设置、语音、通知、剪贴板、拖拽上传等主要流程），列出实际出现的权限种类与来源，**写入本文「发现的问题」**。
- [x] 据审计结果落地处理器：仅放行来源为本应用窗口的 `media`（及审计发现确实需要的其他权限），其余拒绝；dev（localhost）与打包版（实际加载协议）的来源判定都要覆盖。单测处理器纯函数。审计出现意外依赖时**停手上报**，不要硬收紧。
- [ ] 跨平台实机验收（用户待办 / 配合）：macOS 打包版首次预览弹出授权框、拒绝后「打开系统设置」深链有效；Windows 摄像头隐私开关关闭时的报错可读；Linux 无设备 / 无 `/dev/video*` 权限时的提示。结果记录到 `todo/cross-platform-acceptance.md`。
- [x] 文档同步（README 的「未实现」标记待实机验收后去掉）：`docs/design/README.md`（已加索引与 D76 行，实现后把「未实现」标记去掉）、`docs/design/26-voice-input.md` 硬件分区一段指向 31、`docs/dev/PROGRESS.md` 增本期小节。
- **门禁**：全量 typecheck / lint / 单测通过（已达成）；e2e 抽样 11 例通过（sensors / skeleton / attachments / direct-chat / diagnostics；全量 e2e 未重跑）；macOS 实机验收通过（至少 dev 下预览可见）——**待用户**。

## 发现的问题 / 偏差

- P1：`electron-builder.yml` 无 entitlements 文件，分发签名（见 `todo/cross-platform-acceptance.md` P13）时需同时补 `com.apple.security.device.audio-input` 与 `com.apple.security.device.camera`。
- 本机 PATH 的 node 是 v12，需 `export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH` 后才能跑 tsc / eslint / pnpm；`packages/shared/dist` 被 gitignore 且会过期，改 shared 后需 `cd packages/shared && npx tsc -p tsconfig.json` 重建，否则 desktop typecheck 报找不到新导出。
- P2：设计 31 的 `SensorDriver` 在实现中增加了 `permissionStatus()` 与 `openSettings()`（设置页常驻显示权限、授权按钮需要）；`startVoiceRecording` 签名改为接收已打开的 `MediaStream`（`startVoiceRecording(stream, onLevel)`），取流统一走 `sensors.open('microphone')`。已同步设计 31。
- P2：渲染层不依赖 zod（desktop 未声明该依赖），`preferences.ts` 手写校验；vitest 无 svelte 插件，逻辑放纯 TS 的 `SensorHub`，`sensors.svelte.ts` 只做 $state 镜像。
- P2：`open` 的降级序列比设计多一步——软约束+指定设备 → 仅指定设备 → 系统默认，只有最后一步置 `fellBack`（避免「只是软约束不满足」被误报成设备丢失）。
- 评审修复（2026-10-08）：见 `docs/dev/PROGRESS.md` D76 小节；e2e 不再传 `--use-fake-ui-for-media-stream`（它会绕过 Electron 权限处理器），只保留 `--use-fake-device-for-media-stream`，权限白名单回归会让用例失败。
- P4：e2e 在 `kepcup-test:trixie-xvfb` 中直接 `xvfb-run node ../../node_modules/@playwright/test/cli.js test …`（工作目录 `apps/desktop`，需先 `npx electron-vite build` 产出 `apps/desktop/out`，该目录已 gitignore）。

（执行中记录。若与设计 31 有出入，同步修订设计并在 `docs/dev/DEVIATIONS.md` 登记。）
