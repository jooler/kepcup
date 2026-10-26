# preset-skills：预置技能目录（扩展中心 Skills 分组的数据源）

本目录是「扩展中心」Skills 分组（原「技能市场」，主界面左下角入口）的随应用分发数据源。每个子目录是一个符合
Agent Skills 规范的技能（SKILL.md 必含 name/description）；`catalog.json` 是市场
展示清单（中文名、一句话、图标、场景分区、版本、试用语）。

## 运行时解析

- 开发/仓库检出：core 的 `resolvePresetSkillsDir(env)` 自包位置向上查找
  `apps/desktop/resources/preset-skills`。
- 打包后：electron-builder `extraResources` 把本目录拷到 `Resources/preset-skills`，
  主进程（core-host）通过 `KEPCUP_PRESET_SKILLS` 注入绝对路径。
- 找不到目录时市场显示为空，不影响其余功能。

## 安装链路

用户在市场点「添加」→ RPC `skills.presets.install` → core 复用 P08 管线
（`parseSkillDir` → `scanSkillDir` → `hashDirectory` → `installImported`）把内容
复制进只读技能库（`~/.kepcup/skills-library/{name}@{hash}/`）并为目标 Bot 建立
`bot_skills` 引用。预置来源的库条目 `source_url` 为 `preset://{id}`，升级时允许
原位替换；同名非预置来源的技能不覆盖，提示先卸载。

## 如何新增 / 更新一个预置技能

1. 新建子目录，写 `SKILL.md`（frontmatter 必含 name/description；description 用
   中文并写清触发词，≤1024 字符）；需要 Python 依赖的加 `requirements.txt`（扫描器
   由此推断 runtimeDeps，用于「需环境安装」标签）。**注意**：指令文本不要出现
   `WebSearch` / `Task 工具` / `mcp__` 等本宿主不提供的能力词（会被静态扫描判为
   partial 兼容）。
2. 在 `catalog.json` 增加条目（section 目前只有 `starter`；`icon` 是 lucide 图标名）。
3. 更新已有技能：改 SKILL.md 后**必须递增 catalog 中该条目的 version**——市场靠
   内容哈希对比给出「更新」按钮；应用发版即技能发版。
4. 运行 `packages/core` 的 `preset-skills-catalog` 单测（校验 catalog schema 与
   每个技能可被 parse/scan）。

## vendored 技能（mineru，例外规则）

`mineru/` 是逐字引入的官方上游技能（AGPL-3.0，锚点与来源见 NOTICE.md），与原创
条目规则不同：

- **正文不得手改**——任何编辑都会破坏与上游的字节一致性；发现问题修上游，或另立
  原创条目。
- 同步：`node scripts/sync-mineru-skill.mjs`（默认 master；`--check` 只比对不写，
  可挂 CI）。同步后**必须递增 catalog version** 并更新 NOTICE 锚点 commit。
- catalog 条目带 `"vendored": true` 标记：目录守护测试对其放宽 description 上限
  （官方描述不删节），并额外断言 compatibility 必须为 compatible。

## 许可

全部内容为 Kepcup 原创，见 NOTICE.md。**不要**把 anthropics/skills 的
document skills（source-available）或其他未明确可再分发的技能内容拷进本目录。
