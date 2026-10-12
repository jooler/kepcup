# 组件制作流程与交付形态分层：实施方案

> 状态：**已定稿，待实施**（2026-10-12）。用户拍板：选「独立制作 loop」方案（设计 32 §11 的方案 B）；编码在自己的 loop 里跑完，发起它的任务**只拿最终产品**、不被 HTML 与制作过程污染；配套工具（检查器、预览、审查、模板）照样补齐；交付形态分层（P4）按建议纳入。
> 决策编号 **D87**；设计事实见 [docs/design/32-bot-widgets.md](../docs/design/32-bot-widgets.md) §11（制作流程）、§12（交付形态分层）。本文只写**怎么做**，设计取舍以设计 32 为准，实施中的新决定回写设计 32 并记在 §8。
> 前置：D81 P0–P2 已在 main（[todo/bot-widgets.md](bot-widgets.md)）。
> **分支与并发**：本仓库有多个会话并行推进（见项目记忆「Concurrent sessions on one tree」），开工前从 main 拉自己的 worktree 分支（建议 `t/widget-craft`），不碰别人的未提交改动。**迁移编号**：当前 main 最新是 `0034_mail_uid_validity.sql`，本方案的迁移暂记 `0035_widget_check.sql`，**合并时按 main 的下一个空闲编号重命名**。
> **测试纪律**（AGENTS.md）：迭代中只跑定向测试（`node scripts/run-tests.mjs run <文件>`）；本方案改了 shared 契约与 main 迁移，每个阶段收口时全量跑一次；Docker 测试环境与既有失败基线见项目记忆「Docker test runner」。

## 1. 目标与验收

1. 任务面只有 `widget_craft`（+ `widget_publish`）；Bot 无法绕过制作流程直接塞 HTML。
2. 制作在独立的 loop 里完成：任务 run 的上下文里只出现 `widget_craft` 的调用参数与 ≤1500 字的回执，**没有 HTML、diff、检查报告**（以 `run_steps` 抽查为验收证据）。
3. 交付前必经确定性检查：S0 静态 + S1 JS（P3a）、S2 真实预览（P3b）；交付凭回执，回执与文件摘要不一致时宿主拒绝。
4. 独立审查（P3c）：全新上下文、只读、结构化结论；只修 P0/P1；轮数、时限、token 预算封顶；有回滚与防震荡。
5. 做不到时如实交代：有阻断项不交付，回执给原因与 `craftId`；能跑但有问题的，卡片列出已知问题。
6. **效果验收（P3c 基准）**：用一个非一线模型（实施时选定，记录型号）跑 §5.4 的 10 条基准需求，最终「无阻断项」的交付 ≥ 8/10，且明显高于同模型一次写成（只 BUILD、不修）的基线；记录每条需求的轮数、token、耗时。
7. P4：`present` 展示卡、`ask_user` 多选与表单、`kepcup.reply` 回传与 `widget_read_state` 可用。

## 2. 现状（2026-10-12 读取，以代码为准）

| 位置 | 现状 / 用途 |
|---|---|
| `packages/core/src/tools/widget-tools.ts` | `widget_create` / `widget_update` / `widget_publish`；`WIDGET_HTML_GUIDE`（约 2KB）在 create 与 update 的描述里各出现一次；`WidgetToolFacade` |
| `packages/core/src/widgets/service.ts` | `create` / `update`（:195 / :271 起）落库发卡；`#cleanHtml`（:981）只校验非空与体积；`#cleanQueries` 交付侧查询校验（:912 起）；`#acquireRunSlot` 每 run 8 张卡 |
| `packages/core/src/widgets/sdk-injection.ts` | 垫片 `WIDGET_SDK_SHIM` 与注入点逻辑（head → doctype 后 → 开头），幂等指纹 `kepcup-widget-sdk-v1`；不注入任何 CSS |
| `packages/core/src/widgets/query-gate.ts` | 查询名字闸与 `WIDGET_QUERY_SCOPE_GUIDE`（S0 的 `query.invalid` 复用） |
| `packages/core/src/tools/index.ts:1000` | 任务面挂 `buildWidgetTools`；`:984` 挂 `buildDelegateTools` |
| `packages/core/src/agent/context/system-prompt.ts:187` | 任务平台规则里的 widget 一条（要改写成 `widget_craft`） |
| `packages/core/src/skills/authoring.ts` + `authoring-tools.ts` | **最近的先例**：后台技能生成 loop——`routeFor(…,'skill_authoring')`、`runs.create({loopType})`、`engine.startRun(backgroundRunSpec(…))`、草稿目录守卫的 read / write / ls 工具、`validateDraft` |
| `packages/core/src/agent/subagent.ts` | 嵌套子 run 先例：`parentRunId`、父 run abort 级联、时限 `setTimeout` + `tokensSoFar()` 轮询封顶、`persistEngineSteps`、`publishRunStatus` |
| `packages/core/src/agent/llm-router.ts:42` | `LlmPurpose` 联合类型（加 `widget_authoring` / `widget_review`）；`routeFor` / `routeStillCurrent` / `backgroundRunSpec` / `engineKeyOf` |
| `packages/core/src/agent/structured.ts` | `submit` 工具式结构化输出（REVIEW 的 `submit_review` 可参照其校验写法） |
| `packages/shared/src/domain/types.ts:1036` | `loopTypeSchema`（加 `widget_authoring`）；runs.db 的 `loop_type` 无 CHECK（`migrations/runs/0006_tasks.sql` 注释），无需 runs 迁移 |
| `packages/core/src/infra/paths.ts:141` 起 | `botSkillDraftDir` 等路径助手（新增 `botWidgetDraftsDir` / `botWidgetDraftDir`） |
| `packages/core/src/apps/shell-facade.ts`、`browser/facade.ts`；`process-entry.ts:120` | core → 主进程平台调用的延迟绑定模式（`bind(platformServer)` / `bindFacade`）；预览宿主照抄 |
| `apps/desktop/src/main/index.ts:21-22` + `browser-methods.ts` / `shell-methods.ts` | 主进程平台方法注册（`browserMethodSpecs` / `shellMethodSpecs`）；新增 `widgetPreviewMethodSpecs` |
| `apps/desktop/src/main/browser-host.ts:999` | 隐藏窗口（`show:false`、离屏绘制）先例；也有 CDP 先例（备选方案用） |
| `apps/desktop/src/main/apps-ui.ts:42` | `kepcup-app` 协议处理器（`targetSession.protocol.handle`）；预览分区上注册同形处理器 |
| `apps/desktop/src/renderer/src/lib/features/widgets/BotWidgetCard.svelte` | 审查态 / 加载；`:114` 建桥时读 `mode.current` 作主题；P3c 加自检徽标、P3b 加主题推送 |
| `packages/core/src/tools/task-tools.ts:131` | `ask_user`（任务面，单选；`ASK_USER_OPTIONS_MAX`=6 定义在该文件 :118，`ASK_USER_OPTION_MAX_CHARS`=200 在 shared `constants.ts`）；P4 扩展 |
| 依赖 | `acorn@8`、`parse5@7`、`htmlparser2@10`、`globals@16` 已在 pnpm store（传递依赖），**需在 `packages/core/package.json` 显式声明**后再用 |
| testkit | `packages/testkit/src/mock-llm.ts`（脚本化模型，制作 loop 状态机测试用）、`browser-fake.ts`（预览宿主 fake 参照） |

## 3. 设计要点（全文见设计 32 §11–§12）

- **WidgetCraftService**（`core/widgets/craft/service.ts`）：宿主状态机 SPEC → BUILD → GATE ⇄ FIX → REVIEW ⇄ FIX → DELIVER；每阶段一个 pi run（`loop_type='widget_authoring'`，`parent_run_id` = 任务 run），阶段之间以草稿目录文件为记忆。
- **对外只有一个工具**：`widget_craft{brief, widget_id?, title?, scope?, acceptance?, resume_craft_id?}`，前台阻塞，`ctx.progress` 报阶段；回执 ≤ `WIDGET_CRAFT_RESULT_MAX_CHARS`。
- **检查器**（`core/widgets/check/`）：规则注册表（id、级别、说明、怎么改、所属级 S0/S1/S2），同一份注册表生成制作 loop 系统提示里的「沙箱雷区清单」。
- **回执关卡**：GATE 产出 `{htmlSha256, queriesSha256, verdict, round}`；DELIVER 复算摘要，必须对上。
- **预览宿主**（desktop main）：隐藏窗口 + 内存分区 + 外壳页 + 同沙箱 iframe + 预览探针；平台方法 `widgetPreview.run`。
- **shared 常量**（新文件 `packages/shared/src/domain/widget-craft.ts`，从包入口导出）：

```ts
export const WIDGET_CRAFT_FIX_ROUNDS_MAX = 4;
export const WIDGET_CRAFT_REVIEW_ROUNDS_MAX = 2;
export const WIDGET_CRAFT_TIMEOUT_MS = 900_000;
export const WIDGET_CRAFT_TOKEN_BUDGET = 400_000;
export const WIDGET_CRAFT_TOKEN_POLL_MS = 1_000;
export const WIDGET_CRAFTS_PER_RUN_MAX = 3;
export const WIDGET_CRAFT_RESULT_MAX_CHARS = 1_500;
export const WIDGET_CRAFT_DRAFT_TTL_DAYS = 7;
export const WIDGET_CRAFT_PHASE_MAX_TURNS = { spec: 6, build: 30, fix: 15, review: 10 } as const;
export const WIDGET_CHECK_REPORT_MAX_CHARS = 3_000;
export const WIDGET_CHECK_TIMEOUT_MS = 20_000;
export const WIDGET_PREVIEW_VIEWPORTS = [
  { width: 360, theme: 'light' },
  { width: 720, theme: 'dark' },
] as const;
export const WIDGET_PREVIEW_MONKEY_MAX_ELEMENTS = 30;
export const WIDGET_KNOWN_ISSUES_MAX = 5;
export type WidgetCheckStatus = 'legacy' | 'passed' | 'issues' | 'unverified';
// + 检查报告 / 验收点 / 审查结论 / 预览 RPC 的 zod schema（设计 32 §11.8.4、§11.10、§11.9）
```

## 4. 实施顺序与清单

每个子阶段都能单独合入、单独验收。P3a 完成后系统就已经比现在稳（静态检查能拦住大部分沙箱雷区和截断），P3b、P3c 是增量。

### P3-0 Spike（先做，结论记 §8，必要时修订设计 32 §11.8.1 的规则级别）

- [x] 在当前 Electron 版本、`sandbox="allow-scripts"` + 组件 CSP 下实测：`confirm()` 返回值与是否弹窗；`<form>` 的 submit 事件是否触发；`localStorage` 是否抛错；`target=_blank` / `window.open`；`a[download]`；`navigator.clipboard`。写成一个最小 HTML + 主进程脚本，结论按行记录。
- [x] 隐藏窗口（`show:false`）里的 iframe：`window.onerror` 是否能捕获后续 `<script>` 的解析错误；`securitypolicyviolation` 是否触发；`capturePage()` 在三平台是否出图（Linux 先测，macOS / Windows 记为手工验收项）。
- [x] 死循环组件：主进程能否在时限后 `forcefullyCrashRenderer` 并重建窗口，外壳页是否一起被冻住。
- [x] 结论决定 §11.9 用「探针」还是「CDP」作主方案（默认探针）。→ 探针 + 主进程 `console-message` 兜底，不用 CDP（§8.1）。

### P3a 制作 loop 骨架 + 静态检查 + 工具面切换

shared：
- [x] `domain/widget-craft.ts`：常量、`WidgetCheckStatus`、`checkReportSchema`、`acceptanceSchema`（§11.8.4）、`reviewResultSchema`（§11.10）、`craftManifestSchema`；包入口导出。
- [x] `loopTypeSchema` 加 `'widget_authoring'`；错误码登记 `WIDGET_CRAFT_FAILED` / `WIDGET_CRAFT_UNAVAILABLE`（errors.ts + zh-CN `chats.errorCode.*`）。
- [x] `widgetCardSchema` 加 `checkStatus`（default `'legacy'`）与 `knownIssues`（default `[]`）。

core：检查器（`widgets/check/`）：
- [x] `rules.ts`：规则注册表（`{id, level:'error'|'warning', stage:'S0'|'S1'|'S2', title, hint}`）+ `sandboxPitfallsPrompt()`（从注册表生成提示词段落）。
- [x] `static-check.ts`（S0）：parse5 带位置解析；设计 32 §11.8.1 全部规则；`query.invalid` 复用 `WidgetService` 的查询校验（把 `#cleanQueries` 的纯校验部分抽成可导出的函数，`service.ts` 与检查器共用，行为不变）。
- [x] `js-check.ts`（S1）：acorn 解析内联脚本与 `on*` 属性；位置映射回文件；全局作用域收集（经典脚本共享、module 隔离）；`globals` 的 browser 集合 + `kepcup`；设计 32 §11.8.2 全部规则。
- [x] `report.ts`：合并 S0/S1/S2 结果 → JSON 报告 + 给模型的文本（按级别排序、截断到 `WIDGET_CHECK_REPORT_MAX_CHARS`）+ 评分（设计 32 §11.6）+ 阻断项判定。
- [x] `run-check.ts`：`runWidgetCheck({draftDir, preview?})` → 报告；`preview` 缺省时 S2 记 skipped。

core：制作 loop（`widgets/craft/`）：
- [x] `infra/paths.ts`：`botWidgetDraftsDir` / `botWidgetDraftDir`。
- [x] `draft.ts`：草稿目录的创建 / 读写 manifest（宿主独占）/ 快照 / 回滚 / 过期清理（启动时 + 新建制作时）；修改模式下用组件最新版初始化 `index.html` 与 `queries.json`。
- [x] `tools.ts`：阶段工具集——基于 `skills/authoring-tools.ts` 的守卫写法实现 read / ls / write / edit（pi 的 `createEditToolDefinition` 等），守卫：只能访问本草稿目录、拒写 `manifest.json`、FIX 阶段拒绝覆盖已存在的 `index.html`；`widget_check`（自查，调 `runWidgetCheck`）、`widget_template`（P3a 先只有 `blank`）、`stage_done`（终止型）。
- [x] `prompts.ts`（设计 32 §11.7）：平台事实（`WIDGET_HTML_GUIDE` 原文迁来，扩写成 API 参考）+ `sandboxPitfallsPrompt()` + 文件约定 + 各阶段的输入拼装函数。
- [x] `service.ts`（`WidgetCraftService`）：状态机、阶段 run 的创建（`runs.create({loopType:'widget_authoring', parentRunId})` + `routeFor(…,'widget_authoring')` + `persistEngineSteps` + `publishRunStatus`，照抄 subagent）、整体时限与 token 轮询封顶、父 signal 级联、评分 / 最佳快照 / 回滚 / 问题签名去重与收缩模式、回执关卡、交付判定、调 `WidgetService.create/update` 交付、回执文本。P3a 的 GATE = S0 + S1；没有 REVIEW（直接按 GATE 结果交付）。
- [x] `llm-router.ts`：`LlmPurpose` 加 `'widget_authoring'`（P3c 再加 `'widget_review'`）；路由规则与 `skill_authoring` 同。
- [x] `WidgetService.create/update` 增入参 `check?: {status, summary}`，落 `widget_versions.check_status` / `check_summary_json` 并带进卡片描述符；`listForBot` 输出带上 `checkStatus`。
- [x] 迁移 `migrations/main/0035_widget_check.sql`（合并时重编号）：两列，默认 `'legacy'` / `''`。

core：工具面切换：
- [x] `tools/widget-tools.ts`：新增 `widget_craft`（参数与回执见设计 32 §11.4 / §11.6），保留 `widget_publish`；`widget_create` / `widget_update` 不再注册（删掉工具定义，`WidgetToolFacade` 改为 `{craft, publish}`）；工具描述瘦身。
- [x] orchestrator / `start.ts` 装配 `WidgetCraftService`（依赖：engine、router、runs、usage、secrets、widgets、paths、logger、clock、预览宿主 facade〔P3b 前为未绑定〕）。
- [x] `system-prompt.ts:187` 规则改写：何时用 `widget_craft`、brief 要包含什么、不要自己写 HTML、未交付时如实告知。
- [x] 文档回写：dev `04-agent-runtime.md`（工具目录与 loop 表）、`03-data-model.md`（两列）、`02-architecture.md`（若列有 loop 类型）。

P3a 测试：见 §5.1–§5.2。

### P3b 预览宿主（S2）+ 主题变量 + 模板

core：
- [ ] `sdk-injection.ts`：`injectPreviewProbe(html)`（垫片之后、组件脚本之前；只用于预览资源）；探针脚本：错误 / 拒绝 / CSP 违规 / console 收集、DOM 静默等待、渲染体检、乱点冒烟、验收步骤执行、大纲生成，经 `parent.postMessage({source:'kepcup-probe', …})` 回报。
- [ ] `widgets/preview-facade.ts`：`DeferredWidgetPreviewRpc`（照抄 `apps/shell-facade.ts` 的 `createShellHostRpc` / `DeferredShellHostRpc`），`process-entry.ts` 在 platform-port 绑定时 `bind`。
- [ ] `run-check.ts` 接入 S2：两视口；结果并入报告；截图在制作模型支持图片时作为 `ToolResult.images` 交给 BUILD / FIX 阶段的 `widget_check`（GATE 报告本身只存文本）。
- [ ] 主题：`widgets.ui.open` 增可选 `theme`；垫片注入 `data-theme` / `color-scheme` / `--kc-*` 变量；监听 `{source:'kepcup-host', event:'theme'}` 并派发 `kepcup:theme`。
- [ ] `kepcup-kit`：带 `<meta name="kepcup-kit" content="1">` 时注入基础样式（`:where()`）与 `kepcup.ui`（SVG 柱 / 折 / 饼 + 数字格式化）；更新 `WIDGET_SDK_SHIM` 指纹版本（`-v2`）并保持注入幂等。
- [ ] 模板：`widgets/templates/` 下 `blank`、`form-calculator`、`list-tracker`、`dashboard`，每个模板都必须过 S0/S1/S2 全绿（单测锁住）。

desktop main：
- [ ] `widget-preview.ts`：隐藏窗口（`show:false`）+ `session.fromPartition('widget-preview')`（不带 `persist:`）+ 外壳页（preload 只暴露上报通道）+ 该分区上的协议处理器（只服务内存里的预览资源，CSP 同 `buildAppCspHeader` 空域）+ 导航 / 新窗口 / 权限全部拒绝 + 串行队列 + 视口时限与 `forcefullyCrashRenderer` 重建 + `capturePage`。
- [ ] 外壳页里的模拟能力桥：按现有桥协议（`widget-bridge-guard.ts` 的方法白名单与回执形状）回执 storage（内存 KV、fixtures 初值）/ query（fixtures）/ openLink 与 setHeight（记录）/ theme（视口）。协议常量从 shared 取，不另写一份。
- [ ] `widget-preview-methods.ts`（`widgetPreviewMethodSpecs`）注册到 `index.ts` 的平台方法表。

renderer：
- [ ] `BotWidgetCard.svelte`：open 时传 `theme`；`mode` 变化时向 iframe 推送 theme 事件。

### P3c 独立审查 + 自检状态上卡 + 基准

- [ ] `craft/review.ts`：REVIEW 阶段 run（read / ls / `submit_review`），结论 zod 校验，无场景的条目丢弃，未提交记 skipped；接入状态机（GATE 合格才审查、只修 P0/P1、第二轮审查的输入带上一轮结论）。
- [ ] `LlmPurpose` 加 `'widget_review'`；设置项「组件审查模型」（`settings` schema 加可空字段，缺省跟随 Bot 主模型；设置页「后台任务」分组加一个选择器）。
- [ ] renderer：`BotWidgetCard` 审查态徽标（已通过自检 / 有已知问题〔可展开〕/ 未经运行验证；`legacy` 不显示）+ 固定说明「自检只说明它能运行，不代表安全；加载前仍需你确认」+ i18n；`WidgetsTab` 列表显示状态。
- [ ] 基准（§5.4）：跑一次，结果写进 §8 与 `docs/dev/PROGRESS.md`。
- [ ] 文档：设计 32 §11 按实施结果修订（规则级别、参数值）；dev 文档同步。

### P4 交付形态分层（设计 32 §12；P3c 后开始，可拆给另一个会话）

- [ ] L1 `present`：shared 每种 kind 的 zod schema 与 `PRESENT_DATA_MAX_BYTES` / `PRESENT_CONTEXT_MAX_CHARS`；core 工具（对话轮 + 任务）与卡片消息 `content.present`、上下文紧凑回放；renderer 每种 kind 一个组件（图表库选型记 §8，约束见设计 32 §12.1）；系统提示加「展示类结果优先 `present`，要交互才 `widget_craft`」。
- [ ] L2 `ask_user` 加 `mode: single | multi | form`（缺省 single，现有行为不变）；问题卡渲染多选与表单；回答以结构化 JSON（`<untrusted>`）回到任务。
- [ ] L3 回传：垫片 `kepcup.reply(text)`（仅用户手势内有效）→ 卡内确认条（单例 + 冷却，复用 `LinkConfirmBar` 模式）→ 作为用户消息发出、带 `origin:{kind:'widget', widgetId, version}`，上下文渲染 `<untrusted source="widget">`；任务面 `widget_read_state{widget_id, keys?}`（只读本 Bot 组件、≤64KB、`<untrusted>`）。桥白名单、垫片、错误码、i18n 同步。

## 5. 测试

### 5.1 检查器单元（P3a / P3b）
- 每条规则一对正 / 反例 fixture（`packages/core/test/fixtures/widgets/`）：命中位置（行:列）准确、反例不误报；`dom.id-missing` 的动态生成排除、`js.handler-undefined` 的 DOMContentLoaded / module 两种成因、`js.redeclare` 跨脚本、`html.truncated`（把一份正常 HTML 从中间截断）。
- 报告：排序、截断、评分、阻断项判定；`sandboxPitfallsPrompt()` 覆盖注册表全部规则（防提示与规则漂移）。
- **已知坏组件语料**：收集 10–20 份典型的 LLM 坏组件（用 CDN、localStorage、confirm、form submit、onclick 指向闭包内函数、截断、NaN 显示……），断言每份都被至少一条 error 拦下——这是检查器召回率的回归锁。

### 5.2 制作 loop（P3a 起，mock-llm 脚本化）
- 状态机：一次写对 → 直接交付（P3a 没有 S2 → `unverified`；P3b 接上预览后为 `passed`）；GATE 失败 → FIX → 通过；FIX 引入回归 → 回滚到最佳快照且下一轮输入带回归说明；同一问题签名连续两次 → 收缩模式输入；修复轮数用尽：无阻断项 → `issues` 交付并列已知问题，有阻断项 → 不交付、回执带原因与 craftId、草稿保留；时限与 token 预算中止；父 signal 中止 → 阶段 run `cancelled`、草稿保留。
- 回执关卡：GATE 之后改动文件（模拟）→ DELIVER 拒绝；`resume_craft_id` 续做。
- 上下文隔离：任务 run 的 `run_steps` 里只有工具参数与回执（断言回执不含 `<html`、`<script`、报告片段，长度 ≤ 上限）。
- 守卫：越界路径、写 manifest、FIX 阶段覆盖 index.html 都被拒。
- 落库：每阶段一条 `runs` 行（`loop_type`、`parent_run_id`）、用量入账、不产生对话消息；交付版本的 `check_status` / `check_summary_json` 与卡片字段一致。
- 工具面：任务面有 `widget_craft` / `widget_publish`，没有 `widget_create` / `widget_update`；对话轮都没有。既有测试（`widget-tools.test.ts`、`supervisor-turn`、`context-assembly`、`app-prompt-capabilities` 等提示词波及面）按新工具面更新。
- 迁移：`create-core.test.ts`（user_version、两列）；`public-skills-migration` 的回拨重放如需处理新增列，按其既有写法补。

### 5.3 预览宿主（P3b）
- desktop 单测：外壳页模拟桥的回执形状（与 `widget-bridge-host.test.ts` 同协议）、方法规格的入参校验。
- 主进程集成（能起 Electron 的环境）：正常组件出报告；抛错 / CSP 违规 / 空白 / 坏文本 / 乱点触发的错误各一例；死循环组件超时并重建、下一次预览正常；预览分区不落盘。
- core：preview facade 未绑定 → S2 skipped → `unverified`。

### 5.4 效果基准（P3c，真实模型，手工触发）
- `packages/core/test/fixtures/widget-briefs/` 放 10 条需求：费用分摊计算器、待办 / 习惯追踪（storage）、单位换算、番茄钟、记账月度汇总（queries + 图表）、问卷投票、倒计时、简易看板、成绩统计（表格 + 排序）、小游戏（贪吃蛇或 2048）。
- 脚本（或带环境变量开关的集成测试）对同一模型跑两组：基线 = 只 SPEC + BUILD 后直接 GATE 计分；完整流程 = `widget_craft`。记录：最终状态、阻断项、轮数、token、耗时。结果写 §8 与 PROGRESS。
- 手工验收：在应用里让 Bot 做一个记账组件 → 任务卡看到阶段进度 → 卡片带「已通过自检」→ 加载可用 → 对话里提修改 → 新版本仍走流程 → 抽查任务 run 的步骤里没有 HTML。

## 6. 风险

| 风险 | 应对 |
|---|---|
| 制作耗时长（多轮 × 多阶段），用户等待 | 前台进度可见；参数可调；P3c 基准后按数据收紧轮数（预期多数需求 1–2 轮修复）；SPEC 可在简单需求时合并进 BUILD（实施时按基准决定） |
| 检查器误报逼模型改对的代码 | 只有 error 阻断；`dom.id-missing` 等启发式规则带排除条件；误报语料进单测；警告不进 FIX 清单，除非没有 error |
| 预览与正式环境行为不一致 | 外壳页使用与正式卡片相同的 iframe sandbox 属性、CSP 构造函数与垫片；spike 实测沙箱行为；差异记 §8 |
| 审查者吹毛求疵，导致修复震荡 | 只修 P0/P1；条目必须带失败场景；第二轮审查只核对上轮问题 + 新 P0；问题签名去重 |
| 弱模型不调 `stage_done`、在阶段内打转 | 各阶段 `maxTurns` 兜底；自然结束视为完成；GATE 永远由宿主执行 |
| token 成本 | 阶段上下文从文件重建（不累积）；报告截断；整体预算封顶；用量按 `widget_authoring` 单独入账，可观测 |
| 移除 `widget_create` / `widget_update` 后外部 Agent（强模型）也被迫走流程 | 有意为之（流程同样防住强模型的沙箱雷区）；耗时问题由参数解决，不开捷径 |

## 7. 不做

见设计 32 §11.14、§10。补充：本期不做制作过程的对话内实时预览（用户只看到最终卡片与任务进度），也不做「用户在卡片上一键让 Bot 修」（可在 P4 之后评估，走 `kepcup.reply` 或卡片按钮触发 `widget_craft`）。

## 8. 实施记录

（实施会话在此追加：spike 结论、规则级别调整、参数调整、基准结果、全量测试甄别。）

### 8.1 P3-0 沙箱行为实测（2026-10-12，kepcup-9f，分支 `t/widget-craft`）

**环境**：Electron 44.4.5（Chromium 152.0.7977.130），Linux / Xvfb（`kepcup-test:trixie-xvfb`）。脚本 `apps/desktop/scripts/spikes/widget-sandbox/`（`main.cjs` + `preload.cjs` + `shell.html`），可在三平台复跑：`xvfb-run -a node_modules/electron/dist/electron apps/desktop/scripts/spikes/widget-sandbox/main.cjs`（每条结论一行 JSON，截图写 `$SPIKE_OUT`）。条件与正式卡片一致：特权协议 `kepcup-app`（standard + secure）注册在窗口自己的 session 上、响应头 = `buildAppCspHeader` 空域 + `appUiResponseHeaders`、`<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer">`、外壳页是 `file://`（CSP `frame-ancestors file: http://localhost:*` 要求）。容器里没有配置好的 SUID 沙箱助手，所以带 `--no-sandbox` 跑——这只关掉 OS 级进程沙箱，不影响 iframe sandbox 标志、CSP 与进程模型；打包产物（带 OS 沙箱）上的复核记为手工验收项。动作分别以「有用户手势」（`WebFrameMain.executeJavaScript(code, true)`）与「无手势」各跑一遍，**除 `execCommand('copy')` 外两组结果完全一致**——预览探针用合成事件做乱点冒烟有代表性。

**沙箱行为（逐条）**：

| 行为 | 实测 | 规则级别 |
|---|---|---|
| `confirm()` | 不弹窗，0ms 返回 `false`——`if (confirm(…))` 的分支永远不执行 | `sandbox.modals` error（不变） |
| `prompt()` | 不弹窗，0ms 返回 `null` | 同上 |
| `alert()` | 不弹窗，0ms 返回，控制流照常继续（只丢了提示） | **拆出 `sandbox.alert`，降为 warning** |
| `<button type=submit>` 点击 / `requestSubmit()` / 文本框里按 Enter（隐式提交，经真实输入事件） | **submit 事件不触发**（`onsubmit` 属性与 `addEventListener('submit')` 都是 0 次），也没有导航 | `sandbox.form-submit` error：有 submit 处理函数（`onsubmit` 属性 / `addEventListener('submit')` / `.onsubmit =`）或调用 `requestSubmit()` / `.submit()` |
| submit 按钮自身的 `onclick`、表单里不写 type 的 `<button>` 的 `onclick` | **照常执行**（1 次），只是默认的提交动作被拦 | **拆出 `sandbox.submit-button`，warning**：只有 `type=submit` / 表单内无 type 按钮、没有 submit 处理函数时不阻断 |
| `form.submit()` | 无事件、无导航（静默无效） | 计入 `sandbox.form-submit` |
| `localStorage` / `sessionStorage` | 连读属性（`typeof localStorage`）都抛 `SecurityError` | `sandbox.storage` error（不变） |
| `indexedDB.open` / `document.cookie =` | 抛 `SecurityError` | 同上 |
| `window.open(…)` | 返回 `null`（`w.document` 随即 TypeError），主进程 `setWindowOpenHandler` 收不到任何请求 | `sandbox.popup` error（不变） |
| `<a target=_blank>` 点击 | 静默无效：无新窗口、无导航、主进程无事件 | 同上 |
| `top.location.href =` | 抛 `SecurityError`（无权导航目标框架） | `sandbox.top-nav` error（不变） |
| `<a href="#x">` 页内锚点 | 正常 | — |
| `a[download]` 点击 | 静默无效：session 的 `will-download` 不触发 | `sandbox.download` warning（不变） |
| `navigator.clipboard.writeText/readText` | reject `NotAllowedError`（且响应头 Permissions-Policy 本就禁用剪贴板） | `sandbox.clipboard` warning（不变） |
| `document.execCommand('copy')` | 有手势时返回 `true`、无手势 `false`；系统剪贴板是否真的收到在 Xvfb 下无法确认 | 不设规则（记为已知差异） |
| `fetch(…)` | reject `TypeError: Failed to fetch`，同时触发 `securitypolicyviolation`（`connect-src`） | `sandbox.network` error（不变） |
| 外链 `<script src>` / `<link rel=stylesheet>` / `<img>` / `@import` | 被 CSP 拦，**既**触发 `securitypolicyviolation`（`script-src-elem` / `style-src-elem` / `img-src`）**又**在元素上触发 `error` 事件 | `sandbox.external-resource` error（不变） |
| `<style>` 里 `background:url(https://…)` | **没有任何事件**（CSP 事件与 console 都没有）——只有 S0 静态规则能发现 | 同上（S0 必须覆盖 CSS `url()`） |
| 权限 | 加载期间只出现一次 `background-sync` 权限查询（被拒） | — |

**S2 可观测性**：
- 探针（第一个 `<script>`，挂 `error`〔捕获阶段，可拿到资源加载失败〕/ `unhandledrejection` / `securitypolicyviolation`、包装 `console.error/warn`）收到全部错误类型：外链资源失败、**后续 `<script>` 的 SyntaxError**（带行列）、ReferenceError、经典脚本之间 `let` 重复声明（`Identifier 'dup' has already been declared`）、异步 TypeError、promise 拒绝、console 输出、CSP 违规（指令 + 被拦 URI + 行号）。
- **主进程 `webContents` 的 `console-message` 事件同样收到 iframe 里的所有未捕获异常、promise 拒绝（`Uncaught (in promise) …`）、CSP 违规与 console 输出**，并带 `frame`（可按 URL 过滤）。这一路组件代码碰不到，可作探针的防篡改对照通道。
- **结论：主方案用探针（结构化、能执行乱点与验收步骤），主进程 `console-message` 作并行的错误兜底通道；不需要 CDP**（设计 32 §11.9 的备选不启用）。
- 行号：探针报的是**预览资源**里的行号。预览注入（垫片 + 探针）必须写成**不含换行的一行**、插在原有 `<head>` 之后，行号才与草稿 `index.html` 一致（只有注入所在那一行的列号偏移）；S2 报告据此直接引用行号。

**进程模型与死循环**（关键差异，修订设计 32 §11.9）：
- Chromium 152 把 opaque-origin 的 sandbox iframe 放进**独立的渲染进程**（`frame.osProcessId` ≠ 外壳页），即使外壳与组件都在 `widget-preview` 分区里。
- 组件死循环（加载期间的同步 `for(;;)`，或加载后 `setTimeout` 里的循环）只冻住组件进程：外壳页的 100ms 心跳在 1.5s 内照常 15–25 次，主进程对组件框架的 `executeJavaScript` 得不到回应；加载期间就死循环时 iframe 的 `load` 事件不触发。
- 恢复手段实测：
  - **外壳页移除 iframe**：组件进程 3s 内被 Chromium 回收；下一个组件（新 host）分到新进程、正常运行。→ **主方案**。
  - 主进程 `process.kill(frame.osProcessId)`：外壳不受影响，下一个组件正常。→ 移除 iframe 后 3s 仍存活时的补刀。
  - 销毁窗口并重建：2.6s 内恢复，残留进程被回收。→ 外壳页本身无响应时的兜底。
  - `webContents.forcefullyCrashRenderer()`：只会杀掉**外壳页**（它并没有卡住），之后在同一个 webContents 上 `loadFile` 外壳得 `ERR_FAILED`。→ **不采用**（设计原文的做法作废）。
- 每次预览给组件一个新的 host（`widget-preview-{随机}`），避免下一个组件被分进还没回收的进程。

**截图**：隐藏窗口（`show:false`）的 `capturePage()` 在 Linux / Xvfb 下能出图，**包含跨进程 iframe 的内容**，单次 30–50ms。但 `load` 之后的第一张往往还是空白（iframe 进程还没合成首帧）：137–185ms 后的第二次截图才有内容。→ 截图放在探针报告「DOM 静默」之后，若整幅与底色一致就每 50ms 重试，最多 1s；截取 iframe 的矩形而不是整个窗口。macOS / Windows 上能否出图记为手工验收项（用同一脚本复跑）。

**分区**：`session.fromPartition('widget-preview')`（无 `persist:`）`isPersistent()` 为 false、`storagePath` 为 null——预览不落盘。

**对设计 32 的修订**（已回写 §11.8.1、§11.8.3、§11.9）：`alert` 降为 warning（`sandbox.alert`）；`sandbox.form-submit` 收窄到 submit 处理函数与 `requestSubmit()` / `.submit()`，`type=submit` 本身拆为 warning（`sandbox.submit-button`）；CSS `url()` 只有静态规则能发现；死循环处理改为「外壳移除 iframe → 杀组件进程 → 重建窗口」，不用 `forcefullyCrashRenderer`；错误收集 = 探针 + 主进程 `console-message`，不用 CDP；预览注入保持单行以保留行号；截图要等首帧。

### 8.2 P3a 实施记录（2026-10-12，kepcup-9f，分支 `t/widget-craft`）

**落地**（与 §4 清单一一对应，清单已勾）：shared `domain/widget-craft.ts`（常量、检查报告 / 验收点 / 审查结论 / 制作清单 / fixtures schema）、`loopTypeSchema` + core `LoopType` 加 `widget_authoring`、错误码 `WIDGET_CRAFT_FAILED` / `WIDGET_CRAFT_UNAVAILABLE`、id 前缀 `wcf`、卡片 `checkStatus` / `knownIssues` 与列表 `checkStatus`；迁移 `0035_widget_check.sql`（**合并时按 main 下一个空闲编号重命名**，同步 `create-core.test.ts` 的 user_version；`public-skills-migration` 按 `mainVersionsAfter` 动态取，无需改）；检查器 `widgets/check/`（规则注册表 41 条 + S0 / S1 + 报告 + `runWidgetCheck`，S0 / S1 共用 `source.ts` 的 parse5 + acorn 模型）；查询校验抽成 `widgets/query-validate.ts`（交付与检查器同一份代码）；制作 loop `widgets/craft/`（`draft.ts` / `tools.ts` / `prompts.ts` / `service.ts`）+ `widgets/templates/`（P3a 只有 `blank`）；任务面切换为 `widget_craft` + `widget_publish`；`system-prompt.ts` 规则改写；effects 分类表登记 widget 工具（`widget-tools.ts` 原先不在覆盖扫描里，一并补上）；orchestrator `cancelRun` 的 `widget_authoring` 分支；start.ts 装配 + 启动清理过期草稿；dev 文档 02 / 03 / 04 同步。

**实施中的新决定**（已回写设计 32 §11）：
- 写入按阶段白名单：SPEC 只写 spec.md / acceptance.json，BUILD / FIX 只写交付文件；规格与验收点在 SPEC 之后只读（编码阶段不能靠删验收点「通过」）。新建组件 `title` 必填。
- 合格 = 没有错误（含必需验收点失败）；只剩警告最多修一轮，那一轮反而修出错误就停、交付只剩警告的版本。
- GATE 先快照再检查；GATE 有制作的 signal 与 `WIDGET_CHECK_TIMEOUT_MS` 时限，预览被取消 / 超时退回只跑 S0 / S1（超时另记 `preview.timeout` 阻断项）。
- 最佳版本与交付同口径：可交付的回执优先、分数最低、同分取新；回滚也按这个口径（不会从可交付版本退回阻断版本）。
- 交付只读一次文件、按读到的字节复算摘要，取同一摘要的**最后一次**回执及其报告；修改模式下制作期间组件已有新版本（基于的 `baseVersion` 过时）→ 不覆盖、如实失败。
- 检查器自身异常（S0 / S1 skipped 且原因带 `检查器内部错误：` 前缀）合成阻断项 `checker.failed`，不当作合格；`缺少 index.html` 走 `html.missing` 的正常 FIX。没有源码的草稿续做回到 BUILD。
- 卡片说明 / 改动说明取 spec.md 第一条 `>` 引用行（SPEC 按约定写）。修改已有组件时 BUILD 不提供 `widget_template`。
- 草稿写入不重建草稿目录本身（Bot 删除后进行中的制作不会把 `bots/{id}` 写回来）。
- 规则补充：`html.missing`、`sandbox.link-navigation`（warning）、`acceptance.invalid` / `fixtures.invalid`（warning）；`js.undefined-name` 只读取时降为不阻断的 warning；`location.href = '#x'` 视为同文档跳转不报。

**评审**：独立评审一轮（只读），无 P0；P1 一条（缺 index.html 被当作检查器故障、续做死循环）与 P2 十一条全部修复并补回归测试（见上「新决定」与 `widget-craft-loop.test.ts` 的 review fixes、`widget-check-js/static.test.ts`）。

**测试**：定向——检查器 6 文件（规则正反例与行列、注释 / 字符串不误报、20 份坏组件语料每份至少一条阻断项、3 份好组件零错误、报告排序截断评分、提示与注册表同源）、`widget-craft-loop.test.ts`（假引擎驱动状态机：一次写对、GATE → FIX、回归回滚、收缩模式、轮数用尽不交付 + 续做、只剩警告、修改模式、父取消 / cancelStageRun、时限、预算、回执关卡拒绝、交付失败、验收点重写、入参与每 run 上限 / 无模型、守卫，及评审修复 6 例）、`integration/widget-craft.test.ts`（真实 core + 脚本化模型：阶段 run 挂在任务下、**任务 run_steps 里没有 HTML**、卡片与版本行的自检状态、任务 / 对话轮 / 阶段 run 的工具面）、`widget-tools` / `widgets-service` / `tool-effects` / `create-core` / `subagent`，Docker 全绿。**全量一次**（评审修复前，Docker `kepcup-test:trixie`）：4168 例，4140 通过 / 26 失败，26 例全部在环境基线文件内（`sandbox-isolation` 10、`skills-authoring` 4、`skills` 3、`workspace-tools` 3、`toolchain-sandbox` 2、`wiki-url` 2、`projects` OS 沙箱 1、`environment` checksum 1），与 D73 记录的 26 例基线集合一致，无新增失败。core / shared / desktop typecheck（svelte-check 0 错误）、改动文件 eslint 通过。

**留给后续**：P3a 没有 S2，交付状态是 `unverified`（卡片徽标与说明在 P3c）；`blank` 之外的模板与主题变量在 P3b。

