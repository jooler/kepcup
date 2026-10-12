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

- [ ] 在当前 Electron 版本、`sandbox="allow-scripts"` + 组件 CSP 下实测：`confirm()` 返回值与是否弹窗；`<form>` 的 submit 事件是否触发；`localStorage` 是否抛错；`target=_blank` / `window.open`；`a[download]`；`navigator.clipboard`。写成一个最小 HTML + 主进程脚本，结论按行记录。
- [ ] 隐藏窗口（`show:false`）里的 iframe：`window.onerror` 是否能捕获后续 `<script>` 的解析错误；`securitypolicyviolation` 是否触发；`capturePage()` 在三平台是否出图（Linux 先测，macOS / Windows 记为手工验收项）。
- [ ] 死循环组件：主进程能否在时限后 `forcefullyCrashRenderer` 并重建窗口，外壳页是否一起被冻住。
- [ ] 结论决定 §11.9 用「探针」还是「CDP」作主方案（默认探针）。

### P3a 制作 loop 骨架 + 静态检查 + 工具面切换

shared：
- [ ] `domain/widget-craft.ts`：常量、`WidgetCheckStatus`、`checkReportSchema`、`acceptanceSchema`（§11.8.4）、`reviewResultSchema`（§11.10）、`craftManifestSchema`；包入口导出。
- [ ] `loopTypeSchema` 加 `'widget_authoring'`；错误码登记 `WIDGET_CRAFT_FAILED` / `WIDGET_CRAFT_UNAVAILABLE`（errors.ts + zh-CN `chats.errorCode.*`）。
- [ ] `widgetCardSchema` 加 `checkStatus`（default `'legacy'`）与 `knownIssues`（default `[]`）。

core：检查器（`widgets/check/`）：
- [ ] `rules.ts`：规则注册表（`{id, level:'error'|'warning', stage:'S0'|'S1'|'S2', title, hint}`）+ `sandboxPitfallsPrompt()`（从注册表生成提示词段落）。
- [ ] `static-check.ts`（S0）：parse5 带位置解析；设计 32 §11.8.1 全部规则；`query.invalid` 复用 `WidgetService` 的查询校验（把 `#cleanQueries` 的纯校验部分抽成可导出的函数，`service.ts` 与检查器共用，行为不变）。
- [ ] `js-check.ts`（S1）：acorn 解析内联脚本与 `on*` 属性；位置映射回文件；全局作用域收集（经典脚本共享、module 隔离）；`globals` 的 browser 集合 + `kepcup`；设计 32 §11.8.2 全部规则。
- [ ] `report.ts`：合并 S0/S1/S2 结果 → JSON 报告 + 给模型的文本（按级别排序、截断到 `WIDGET_CHECK_REPORT_MAX_CHARS`）+ 评分（设计 32 §11.6）+ 阻断项判定。
- [ ] `run-check.ts`：`runWidgetCheck({draftDir, preview?})` → 报告；`preview` 缺省时 S2 记 skipped。

core：制作 loop（`widgets/craft/`）：
- [ ] `infra/paths.ts`：`botWidgetDraftsDir` / `botWidgetDraftDir`。
- [ ] `draft.ts`：草稿目录的创建 / 读写 manifest（宿主独占）/ 快照 / 回滚 / 过期清理（启动时 + 新建制作时）；修改模式下用组件最新版初始化 `index.html` 与 `queries.json`。
- [ ] `tools.ts`：阶段工具集——基于 `skills/authoring-tools.ts` 的守卫写法实现 read / ls / write / edit（pi 的 `createEditToolDefinition` 等），守卫：只能访问本草稿目录、拒写 `manifest.json`、FIX 阶段拒绝覆盖已存在的 `index.html`；`widget_check`（自查，调 `runWidgetCheck`）、`widget_template`（P3a 先只有 `blank`）、`stage_done`（终止型）。
- [ ] `prompts.ts`（设计 32 §11.7）：平台事实（`WIDGET_HTML_GUIDE` 原文迁来，扩写成 API 参考）+ `sandboxPitfallsPrompt()` + 文件约定 + 各阶段的输入拼装函数。
- [ ] `service.ts`（`WidgetCraftService`）：状态机、阶段 run 的创建（`runs.create({loopType:'widget_authoring', parentRunId})` + `routeFor(…,'widget_authoring')` + `persistEngineSteps` + `publishRunStatus`，照抄 subagent）、整体时限与 token 轮询封顶、父 signal 级联、评分 / 最佳快照 / 回滚 / 问题签名去重与收缩模式、回执关卡、交付判定、调 `WidgetService.create/update` 交付、回执文本。P3a 的 GATE = S0 + S1；没有 REVIEW（直接按 GATE 结果交付）。
- [ ] `llm-router.ts`：`LlmPurpose` 加 `'widget_authoring'`（P3c 再加 `'widget_review'`）；路由规则与 `skill_authoring` 同。
- [ ] `WidgetService.create/update` 增入参 `check?: {status, summary}`，落 `widget_versions.check_status` / `check_summary_json` 并带进卡片描述符；`listForBot` 输出带上 `checkStatus`。
- [ ] 迁移 `migrations/main/0035_widget_check.sql`（合并时重编号）：两列，默认 `'legacy'` / `''`。

core：工具面切换：
- [ ] `tools/widget-tools.ts`：新增 `widget_craft`（参数与回执见设计 32 §11.4 / §11.6），保留 `widget_publish`；`widget_create` / `widget_update` 不再注册（删掉工具定义，`WidgetToolFacade` 改为 `{craft, publish}`）；工具描述瘦身。
- [ ] orchestrator / `start.ts` 装配 `WidgetCraftService`（依赖：engine、router、runs、usage、secrets、widgets、paths、logger、clock、预览宿主 facade〔P3b 前为未绑定〕）。
- [ ] `system-prompt.ts:187` 规则改写：何时用 `widget_craft`、brief 要包含什么、不要自己写 HTML、未交付时如实告知。
- [ ] 文档回写：dev `04-agent-runtime.md`（工具目录与 loop 表）、`03-data-model.md`（两列）、`02-architecture.md`（若列有 loop 类型）。

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
- 状态机：一次写对 → 直接交付 `passed`（P3a 无审查时）；GATE 失败 → FIX → 通过；FIX 引入回归 → 回滚到最佳快照且下一轮输入带回归说明；同一问题签名连续两次 → 收缩模式输入；修复轮数用尽：无阻断项 → `issues` 交付并列已知问题，有阻断项 → 不交付、回执带原因与 craftId、草稿保留；时限与 token 预算中止；父 signal 中止 → 阶段 run `cancelled`、草稿保留。
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
