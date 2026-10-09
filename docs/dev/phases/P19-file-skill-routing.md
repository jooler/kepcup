# P19 文件技能路由（install_skill 与推荐技能注入）

## 目标

模型面对处理不了的文件有明确的升级阶梯：已装技能 → 内置推荐技能（经用户授权安装）→ 全网检索技能仓库（经扫描审批安装）→ 如实告知不支持。安装动作在 run 内完成、当次即可用。

## 依赖

P08（技能库/导入审批）、P17（上下文附件行含 mime）、P18（web_search）。

## 设计依据

- [design/22-file-skill-routing.md](../../design/22-file-skill-routing.md)（全文，决策 D63）
- [design/05-wiki-and-skills.md](../../design/05-wiki-and-skills.md)（技能来源与作用域、遮蔽）
- [design/13-permissions.md](../../design/13-permissions.md)（审批框架、无人值守自动批准类）
- todo/conversation-rich-media.md（规划与验收口径）

## 背景（现状，实现前必读）

- 预置技能市场（`skills/presets.ts`）：`list()`（catalog 解析+扫描+安装态三元组）、`install(presetId)`（幂等、原位升级、装公共技能、发布 `skills.changed`）——**模型不可见、无工具入口**。
- 技能注入：`SkillsService.promptSection(botId)` 只列已安装（active）技能；`buildSystemPrompt` 第 12 段 `<skills>`；`prepareRequest` 每次请求前刷新系统提示（安装后立即可用的关键）。
- 导入流：`SkillImporter.import` = clone + scan + `submitNonBlocking('skill_import')` + 回调 `installImported`（按 Bot 安装）；审批基类已有阻塞 `request(identity, kind, payload, {signal})`（waiter + `waiting_approval` + 取消联动）。
- `ApprovalKind` 目前无 `skill_preset`；`describe/renderContextLine/ApprovalCard` 按 kind 分支；无人值守 `#autoDecideSync` 只对 command/unsandboxed/git_remote 做数据目录地板，其余自动批准。
- `scan.ts` 的 `HOST_CAPABILITY_PATTERNS` 含 WebSearch/WebFetch（P18 已移出）。

## 任务（全部完成）

- [x] shared：`approvalKindSchema` 增 `skill_preset`；`skillPresetApprovalPayloadSchema {presetId,name,displayName,summary,version,missingDeps}`
- [x] core/presets：`promptSection(botId)`（未安装条目：id/名称/displayName/summary 截断/安装指引）；`describePreset(presetId)`（审批 payload 组装）
- [x] core/library：`SkillImporter` 拆分 prepare（clone+scan，产出 payload）/ commit（installImported），保留既有 RPC 入口行为
- [x] core/tools：`skill-tools.ts` `install_skill {preset_id?|source_url?,ref?,reason?}`——preset 路径走阻塞 `skill_preset` 审批后 `presets.install`；URL 路径 prepare → 阻塞 `skill_import` 审批 → commit；已安装幂等返回位置；拒绝返回 `APPROVAL_DENIED`
- [x] core/orchestrator：`ResponseToolDeps` 增 `skillInstall` facade；system prompt 增 `<recommended_skills>` 段与附件阶梯纪律段
- [x] core/approvals：`skill_preset` 的 describe / renderContextLine（确认已装时注明「已入技能库并启用」）
- [x] desktop：`ApprovalCard` 增 `skill_preset` 分支（技能名/摘要/版本/缺失依赖/来源「应用内置推荐」）；折叠态与审批 Dock 自动生效
- [x] desktop/i18n：审批与折叠行文案
- [x] 测试：工具两条路径（审批批准/拒绝/幂等/参数校验）、`promptSection` 遮蔽规则、审批文案与无人值守自动批准；e2e 推荐→批准→继续

## 验收（2026-10-04 全部通过）

1. `install_skill` 两条路径（单测 `skill-tools.test.ts` 6 例）：preset 批准→装公共技能并返回 SKILL.md 位置、拒绝→`APPROVAL_DENIED` 不安装、已安装幂等；source_url 批准→commit 落位、拒绝→丢弃 staging、prepare 失败错误文本回模型。
2. `<recommended_skills>` 只列未安装预置（`presets.promptSection`，遮蔽已装项）；系统提示 `<file_handling>` 注入四级阶梯与「不假装处理过附件」纪律。
3. 阻塞审批复用 `approvals.request`：run 置 `waiting_approval`、取消联动取消审批；无人值守下 `skill_preset`/`skill_import` 同属自动批准类（`#autoDecideSync` 既有地板只拦数据目录）。
4. `skill_preset` 审批卡（ApprovalCard 新分支：名称/摘要/版本/缺失依赖/来源标注）与折叠行、`describe`/`renderContextLine` 同步。
5. `pnpm test` 全绿；真实端到端（未装 mineru 上传 PDF → 推荐卡 → 批准 → 继续处理）待配置真实模型后人工验收（自动化由单测与既有 skill_import 集成覆盖）。

## 备注

1. 上传 MinerU 支持的文档且该技能未安装 → 模型调 `install_skill(preset_id)` → 审批卡出现、run 停在 `waiting_approval`；批准后技能装为公共技能、模型继续读取 SKILL.md 并处理文件；拒绝后模型降级或如实答复。
2. 推荐目录无匹配时，模型用 `web_search` 找到技能仓库 → `install_skill(source_url)` → `skill_import` 卡（含扫描结果）→ 批准后按 Bot 安装并继续。
3. 已安装的预置技能不出现在 `<recommended_skills>`；安装成功后当次 run 内模型可 `read` 到技能文件。
4. 无人值守模式下两类安装自动批准（审计可见）；普通模式一律等待用户。
5. `pnpm test` 全绿（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）。

## 备注

- 不做自动安装；`skill_import` 既有 RPC 入口（UI 导入）行为不变。
- 推荐段是策展小集合直接整段注入；不引入向量检索。
