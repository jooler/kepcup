# P08 Skills

## 目标

每个 Bot 挂载自己的技能：可以从 git 仓库导入 Claude Code / Codex 生态的技能（Agent Skills 标准），也可以由 Bot 在后台自行生成。技能以渐进式加载进入上下文，脚本只在沙箱中执行，依赖通过环境管理器解决。

## 依赖

P06、P07。

## 设计依据

- [design/05-wiki-and-skills.md](../../design/05-wiki-and-skills.md#skillsbot-的工具)（格式、来源、自建流程、修改规则、加载方式、兼容性、依赖、安全）
- [design/13-permissions.md](../../design/13-permissions.md)（导入确认、无人值守模式）
- [03-data-model.md](../03-data-model.md)（skill_library、bot_skills）

## 范围

包含：

- 技能库 `~/.kepcup/skills-library/{name}@{hash}/`（只读）；各 Bot 的自建技能 `bots/{id}/skills/`（es-git 管理版本），草稿目录 `bots/{id}/skills/_drafts/`。
- 导入：输入 git 仓库地址（可指定子目录与分支 / 标签），核心服务在沙箱外克隆（es-git，HTTPS），锁定 commit，扫描，`skill_import` 审批，写入技能库，为指定 Bot 安装。
- 扫描：`SKILL.md` frontmatter 校验、脚本清单、权限与依赖声明、兼容性检测、风险提示。
- 安装、停用、卸载（每个 Bot 独立）；同一库版本被多个 Bot 引用；无引用的版本回收。
- 加载：系统提示词 `<skills>` 段（`formatSkillsForPrompt`，只含名字与描述）；技能目录在沙箱中只读；模型需要时用 read 工具读取 `SKILL.md` 全文。
- 依赖：扫描出的运行时依赖（例如需要 Python）在安装时检测，缺失则提示并可发起环境申请。
- 自建：消费 P07 反思产生的 `skill_suggestion` 任务，以及用户在对话中的要求（Bot 调用 `create_skill` 工具登记任务）；技能生成 loop；验证；自动启用；对话中告知；停用。
- 修改规则：导入的技能不可修改；Bot 要改进时复制为自建技能。
- 界面：右栏“Skills”标签页；导入对话框；导入审批卡片（扫描结果）。
- 生命周期：删除 Bot 时的处理。

不包含：

- 增强沙箱级别的技能执行（P12；本阶段声明需要增强沙箱的技能标记为 `incompatible`，原因“需要增强沙箱”）。
- 技能市场的搜索界面（只支持 git 地址导入）。

## 任务

1. **格式与解析**（`skills/parse.ts`）：按 Agent Skills 规范解析 `SKILL.md`（frontmatter 中 `name`、`description` 必填）；优先使用 pi 的 `loadSkills` 解析，与其保持一致。
2. **扫描**（`skills/scan.ts`），输出 `scan_json`：
   - `files`：脚本文件列表（按扩展名与 shebang 识别）。
   - `declaredPermissions`：frontmatter 中声明的网络、凭据需求（未声明视为“无”）。
   - `runtimeDeps`：从脚本 shebang、`requirements.txt`、`package.json` 等推断（python / node / 其他）。
   - `compatibility`：`compatible` / `partial` / `incompatible`，依据：正文引用了宿主专有能力（例如 `mcp__` 前缀的工具、`Task` 子代理工具、特定 IDE 命令）→ `partial`；声明需要增强沙箱 → `incompatible`（本阶段）。
   - `risks`：例如“包含网络访问的脚本”“包含二进制文件”。
3. **导入**（`skills/import.ts`）：克隆到临时目录 → 定位技能目录（仓库中可能有多个技能，列出供选择）→ 计算内容哈希 → 扫描 → 发起 `skill_import` 审批（卡片显示来源、commit、兼容性、依赖、风险）→ 批准后移动到技能库并为目标 Bot 写 `bot_skills`。
4. **安装与引用**（`skills/registry.ts`）：`bot_skills` 的状态管理；同名冲突（Bot 已有同名技能）时拒绝并提示；回收：没有 `bot_skills` 引用的库版本在删除 Bot 或卸载时删除目录与记录。
5. **加载**：每次响应执行时，列出该 Bot `status = 'active'` 的技能（内置 + 导入 + 自建），用 `formatSkillsForPrompt` 生成 `<skills>` 段；技能目录路径加入沙箱策略的 `readOnly`，也加入文件工具的可读范围。
6. **自建流程**（`skills/authoring.ts`）
   - 任务来源：`skill_suggestion` 任务（反思产生，要求同类任务成功次数 ≥ `SKILL_AUTHOR_REPEAT_THRESHOLD`，由反思根据该 Bot 的执行摘要判断）；`create_skill(name, description, reason)` 工具（用户在对话中说“以后都这样做”时由 Bot 调用）。
   - 技能生成 loop：主模型；可访问 `_drafts/{name}/`（读写）、相关执行记录摘要（只读，通过输入提供）；产出 `SKILL.md` 与可选脚本、可选 `tests/` 目录。
   - 验证：frontmatter 校验；脚本语法检查（Python：`python -m py_compile`；Node：`node --check`；shell：`bash -n`）；存在 `tests/` 时在沙箱中运行其中声明的测试命令（frontmatter 字段 `test`），必须通过。
   - 通过后：移动到 `bots/{id}/skills/{name}/`，es-git 提交，`status = 'active'`；在触发它的对话中（没有则在该 Bot 的单聊中）发送消息“我整理了一个新技能：{name}——{description}”。
   - 不通过：保留草稿，记录原因，不打扰用户。
   - 改进已有自建技能：同样经过草稿与验证，提交为新版本。
7. **界面**：右栏“Skills”：列表（名称、来源、状态、兼容性），启用 / 停用 / 卸载，查看 `SKILL.md`，自建技能的版本历史与回滚；“导入技能”对话框（git 地址、子目录、分支 / 标签）。
8. **生命周期**：删除 Bot → 删除 `bot_skills` 行与自建技能目录（随 `bots/{id}/`），回收无引用的库版本。

## 接口与数据

- 新增表：`skill_library`、`bot_skills`。
- 新工具：`create_skill`（R）。
- 审批类型启用 `skill_import`。
- RPC：`skills.list(botId)`、`skills.import`、`skills.enable`、`skills.disable`、`skills.uninstall`、`skills.history`、`skills.rollback`、`skills.read`。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| pi 的 `loadSkills` / `formatSkillsForPrompt` 能否指定任意目录列表 | 传入库目录与自建目录，输出正确 |
| 从 Anthropic 官方技能仓库与 OpenAI 官方技能仓库各导入 2 个技能并运行 | 记录兼容性结果 |

## 测试要求

- 单元：frontmatter 校验；兼容性检测规则；依赖推断。
- 集成：
  - 从本地 git 仓库（测试夹具）导入 → 审批 → 安装 → 下一次执行的系统提示词中出现技能描述 → 模型读取 `SKILL.md` 并执行脚本（沙箱中）。
  - 拒绝导入 → 技能库中无记录。
  - 两个 Bot 安装同一版本 → 库中一份；卸载一个后仍在；两个都卸载后被回收。
  - 沙箱内写技能目录失败。
  - 自建：模拟模型产出草稿 → 验证通过 → 启用并发送通知消息；验证失败 → 不启用、无通知。
  - 删除 Bot → 自建技能目录不存在，无引用的库版本被回收。
- 端到端：导入流程与审批卡片；Skills 标签页的启用 / 停用。

## 后续迭代：技能市场与预置技能（已落地）

P08 曾把「技能市场的搜索界面」排除在本阶段外（只支持 git 地址导入）。市场已作为
P08 的增量落地，形态刻意克制：**不是开放商店，而是随应用分发的预置目录 + 添加入口**。

- **分发**：预置技能随应用打包（`apps/desktop/resources/preset-skills/`，三平台
  `extraResources` → `Resources/preset-skills`，core-host 注入
  `KEPCUP_PRESET_SKILLS`；开发态由 `resolvePresetSkillsDir` 向上查找）。
  内容以 Kepcup 原创为主——上游 anthropics/skills 的 document skills 是
  source-available、不可再分发（见该目录 NOTICE.md）。
- **vendored 条目**（设计 17，2026-10-04 起）：`mineru/` 逐字引入 opendatalab/MinerU
  官方 Agent Skill（AGPL-3.0，明确允许原样再分发）。正文不得手改，经
  `scripts/sync-mineru-skill.mjs` 跟随上游（`--check` 只比对可挂 CI），同步后递增
  catalog version 并更新 NOTICE 锚点；catalog 条目带 `vendored: true`，目录守护
  测试对其放宽 description 上限（沿用上游触发文本）并额外断言 compatibility 必须
  为 compatible。
- **数据源**：`catalog.json`（id / 目录 / 中文名 / 一句话 / 图标 / 场景分区 / 版本 /
  试用语），由 core 的 `SkillPresetsService` 读取并经 `skills.presets.list` 下发；
  安装态（installed / upToDate / foreign）按公共作用域实时推导。
- **安装语义**：市场点「添加」即装为**公共技能**（`skills.presets.install` →
  `public_skills` 表）：**一次安装，所有 Bot 都能发现并调用**，无审批卡片——
  预置内容随应用分发、发布前经同一静态扫描，可信；任意 git 导入的私有审批
  流程不变。落库复用 P08 管线（parse → scan → 内容哈希 → `installPublic`，
  kind=imported，`source_url = preset://{id}`）。应用升级带来新版本时按钮显示
  「更新」，原位替换（卸旧公共行 → 引用计数 GC → 装新）；同名非预置来源的
  公共条目一律不覆盖。Bot 的同名**私有**技能不是冲突——按遮蔽规则对该 Bot
  隐藏公共版本（design/05）。
- **启停与卸载**：公共技能全局生效，从任意 Bot 的技能面板操作（enable /
  disable / uninstall 在无私有行时路由到 public_skills，`skills.changed` 以
  `botId: ''` 广播全局刷新）。
- **入口**：左栏底部「技能市场」胶囊按钮（无目标 Bot 选择——安装即全体可用）；
  右栏 Skills 面板提供「浏览技能市场」入口。搜索与分区过滤在渲染层。
- **RPC**：`skills.presets.list()`（目录与全局安装态，无入参）、
  `skills.presets.install(presetId)`（返回刷新后的完整目录）。
- **许可红线**：不得把 source-available / 许可不明的技能内容拷入 preset-skills
  （详见该目录 README 与 NOTICE）。

## 验收标准

- [ ] 可以通过 git 地址导入 Claude Code / Codex 生态的技能，导入前显示扫描结果并需确认。
- [ ] 导入的技能锁定到具体 commit，内容不可被修改。
- [ ] 技能只以名字与描述进入系统提示词，需要时由模型读取全文。
- [ ] 技能脚本只在沙箱中执行，技能目录在沙箱中只读。
- [ ] 缺少运行时依赖的技能在安装时提示，并可发起环境申请。
- [ ] Bot 能够自建技能：验证通过后自动启用，并在对话中告知；用户可以停用。
- [ ] 每个 Bot 的技能相互独立；删除 Bot 时技能被清理。
- [ ] 本阶段测试全部通过。

## 注意事项

- 克隆仓库在沙箱外进行，但只做文件下载，不执行仓库中的任何代码（不运行 hooks、不安装依赖）。
- 技能的描述会进入系统提示词，扫描时对描述长度做限制（超过 1024 字符截断）。
