# Bot 微应用运行时（Micro-App Platform）实施编排 · 总览

> 状态：**P0–P3 全部完成（2026-11-05）**——各阶段实现 + 独立子代理审查 + 全部问题修复（P0/P1 双轮）；最终全量测试与 §15 十七条核对见 P3 文件收口段。P4（分发与共享）本期不做，市场只评估。设计依据：[docs/design/55-bot-micro-app-runtime.md](../../docs/design/55-bot-micro-app-runtime.md)（决策 **D112**，已登记 README 决策表）；上游 [32-bot-widgets.md](../../docs/design/32-bot-widgets.md)（55 号接管其 §5–§8 运行时结论）。
> 分支：`feat/micro-app-platform`（worktree `../kepcup-micro-app-platform`，自 `v0.5.7` 拉出）。**不推远端、不开 PR**；历史分支 `feat/micro-app-runtime` 不再使用。
> 执行代理纪律：P0 → P1 → P2 → P3 连续推进，阶段之间不停顿；每阶段完成后拉独立子代理审查（P0/P1 双轮），修完全部问题才进下一阶段；P4（分发与共享）本期不做，市场只评估不实施。

| 阶段 | 文件 | 交付 | 依赖 |
|---|---|---|---|
| P0 | [P0-contracts.md](P0-contracts.md) | 清单契约、能力闭合枚举、能力面指纹、桥协议 v2、版本双指针、SDK spec 单一事实来源 + 生成物 + 守卫测试、确认卡（能力清单 + 网络行 + 预检）、错误契约、`app.net-open-default` 规则 | 无 |
| P1 | [P1-voice-models.md](P1-voice-models.md) | `ai.chat` / `ai.session`（隔离 / 流式 / 三级预算 / 记账归 Bot）、`media.listen`（宿主代理 + VAD + ASR）、`media.speak`（TTS 队列 + 打断）、MicroAppChrome、能力撤销与降级 | P0 |
| P2 | [P2-packages-lifecycle.md](P2-packages-lifecycle.md) | 多文件包 `micro_app_files`、`collections`、会话恢复 / 前后台 / 崩溃恢复、`context.update`、`query` 分页、运行时诊断回流、微应用管理页 | P1 |
| P3 | [P3-craft.md](P3-craft.md) | craft loop 多文件 + 清单检查 + 能力最小性、S2 能力 mock、写作知识分层（`sdk.md` / `references/` / `templates/` + 守卫）、`micro_app_sdk_inspect`、SPEC 读诊断、§11 全部检查器规则、基准 13 条 | P2 |

## 0. 一句话目标

把「组件」（单文件 HTML + 六个窄接口）升级为「微应用平台」：清单声明能力、宿主按版本强制、模型与音频由平台代理（`ai.chat` / `media.listen` / `media.speak`）、桥升级为 call/stream/event/cancel、多文件包与会话恢复、制作流程与运行时诊断接成闭环。存量组件按「无清单」退化微应用继续工作，**行为零变化**（P0 硬验收）。

## 1. 固定契约（55 号 §13.2，所有阶段不得偏离）

- 命名：用户可见「微应用」；代码 `MicroApp*` 前缀；RPC `microApps.*`；清单 `micro-app.json`；SDK 路径 `packages/shared/src/micro-app-sdk/`；SDK 命名空间 `kepcup.app`（实例）与 `kepcup.*`（能力）。
- 数据库：新增表 `micro_app_*` 前缀（`micro_app_files` / `micro_app_usage` / `micro_app_diagnostics` / `micro_app_audit`）；存量 `widget_*` 不改名（`widgets.bot_id` 仍是计费归属锚点）；迁移在 `packages/core/migrations/main/` 递增编号。
  - ⚠️ 编号冲突已按约定处置（2026-11-05 合并时）：主工作区 `0067_bot_direct_exchange.sql`（bot 直聊）已先提交，微应用侧四份迁移顺延为 `0068_micro_app_manifest` / `0069_micro_app_usage` / `0070_micro_app_p2` / `0071_micro_app_diag_pushes`。
- 红线（55 §16 永久不做，任何决策不得突破）：生成代码进宿主进程 / `nodeIntegration` / core 执行生成 JS；任意 SQL / 文件系统 / 子进程 / 读 `secrets`；发音评分；后台常驻 / 定时唤醒；全双工实时语音；微应用互访；微应用市场（P4 只评估）。
- 沙箱：iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-modals"` + `allow=""` 不变；能力只经宿主桥；原始音频不出宿主。
- 默认联网 `open`（Q10 已拍板），四个提示面缺一不可：确认卡网络行（最前、单独一行）、外壳常驻徽标（P1）、SPEC 必答联网用途（P3）、`app.net-open-default` 检查规则（P0）。
- 微应用不能指定模型厂商 / id；`ai.chat` 无工具面；用量与费用计入**编写该微应用的 Bot**（`widgets.bot_id`）。
- 新增用户设置走设置目录流程（AGENTS.md：`settings-catalog` 登记 → core 适配器 → 渲染卡片 → `settings-adapters-coverage` 守卫）。

## 2. 执行规则

- 测试（AGENTS.md）：迭代只跑定向（`node scripts/run-tests.mjs run <文件>` / `pnpm --filter @kepcup/<包> test`）；改 shared 先 `pnpm --filter @kepcup/shared build`；全量 `pnpm test` 只在阶段收口跑一次。
- 提交：conventional commits 中文描述（`feat(micro-apps): …` / `fix(widgets): …` / `test(micro-apps): …` / `docs(design): …`）；每阶段至少一个提交，提交可构建。
- 阶段审查：独立 general-purpose 子代理，输入 = 阶段 diff + 设计章节 + 验收清单，输出 P0–P3 分级问题；全部修完并复跑定向测试才收口（P0/P1 加第二轮复审）。
- 自主决策：能归入 55 §16「仍待决策」的 Q5–Q9 就更新该表（已拍板 + 日期 + 理由）；新取舍新增 Q 项。代码现状与文档锚点漂移时以代码为准并回填文档。
- 文档同步：55 号（状态修订）、`docs/dev/03-data-model.md`（新表）、`docs/dev/PROGRESS.md`（最终一行）、32 号（如需）。

## 3. 总验收（55 §15 十七条，最终交接逐条给证据）

1. `widget_craft` 交付，任务上下文只收回执；2. 卡片显示能力清单 / 网络范围 / 预计成本与计费 Bot；3. 权限面扩大重新确认、纯代码更新沿用确认；4. 打开即 TTS 问候 + 字幕；5. 说话→转写→模型回复→播报；6. 插话打断；7. 关闭重开续进度；8. 拒绝麦克风降级键盘；9. 用量展示 + 管理页累计；10. 断网 / 模型失败可读错误不白屏；11. S2 离线整轮 mock；12. 检查器无阻断 + 自检如实上卡；13. 崩溃 / 反复被拒 → 作者收一条 ≤300 字诊断、同 `(version, code)` 当天不重复；14. 诊断表无内容只有 code / 阶段 / 位置 / 次数；15. 缺配置卡片打开前标「当前不可用」+ 设置深链；16. 网络行在能力清单前 + 外壳徽标 + open 档写明「未限制域名」；17. `context.update` 结构化摘要进下一轮、无气泡、可清除、自由文本与循环刷写被拒。

## 4. 决策记录（执行中拍板，同步回 55 §16）

| # | 问题 | 决策 | 日期 | 理由 |
|---|---|---|---|---|
| Q5 | 多文件 vs 单文件 | **多文件**（清单 + 资源），单文件作为退化形态保留 | 2026-11-04 | P2 落地 `micro_app_files`；P0 清单微应用先只有 `index.html`，`micro-app.json` 的 `entry` 指向它 |
| Q8 | 重复确认粒度 | **按能力面指纹**（`permissions` + `net.mode` + `net.allowlist`） | 2026-11-04 | 采纳 55 §5.2 建议；只对带清单微应用生效，存量组件沿用 `(sha256\|queriesSha256)` 逐版本确认（零变化硬验收） |
| Q9 | 诊断默认推送 | 默认首次落系统消息到来源会话，同 `(version, code)` 每天 ≤1 条 | 2026-11-04 | 采纳 55 §9.4 建议；P2 落地 |

新决策（不在 55 §16 表内的）记入各阶段文件「实施记录」并在此登记。

## 5. 完成定义

P0–P3 全部实现并通过阶段审查；§15 十七条逐条核对给证据（测试名 / 手动步骤）；55 号文档与 todo 状态同步；全量 `pnpm test` 最后跑一次全绿；产出交接报告（改动、决策位置、遗留）。
