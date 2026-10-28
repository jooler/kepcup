# P5 · 插件开发文档、官方批次、设计文稿修正

> 状态：待实施。依赖：P4。分支：`feat/plugins-platform/p5-docs-market`。
> 必读：[README.md](README.md) §1/§2；`docs/guides/write-a-plugin.md`（将被重写）、
> `docs/design/51-plugin-system.md`（将被修正）、`plugins/README.md`、`packages/app-validator/src/plugin/`。

## 1. 目标

交付后：一个**未读过 KepCup 源码**的开发者或编程 Agent，仅凭插件开发文档即可写出、校验、打包、
本地安装一个含配置与实例的新插件（盲测验收）；官方市场批次与代码现状一致；设计文稿改写为
现状事实，本迭代的模型成为正式设计记录。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| 插件开发文档全面重写（含给编程 Agent 的指南） | developer-portal 提交审核（P3 原方案，另行设计） |
| `app-validator`：`config` / `instances` 校验、`init` 模板更新 | 新能力类型（短信 / 电话 / 传感器）的真实实现 |
| 官方批次更新（邮件四插件 + 按需 custom-mcp；签名发布） | 多市场、插件依赖 |
| 设计文稿修正（51 重写现状 + 受影响设计补记） | — |

## 3. 步骤

### 3.1 插件开发文档（`docs/guides/write-a-plugin.md` 重写，必要时拆 `docs/guides/plugin-dev/`）

章节清单（全部以最终代码为准，写完后逐条对照实现核验）：

1. **概念**：插件 = 声明式贡献包（零宿主代码）；能力类型（技能 / 连接 / 工具 / 邮件 + 未来的注册菜谱）；
   贡献 vs 实例 vs 插件配置三分；信任分级与来源定级；安装 = 校验 → 同意 → 落盘 → 登记 → 投影。
2. **`plugin.json` 参考**：逐字段表格（类型 / 约束 / 必填性）；`config.fields` 与 `instances`；
   字段 schema（`PluginField`）全字段说明与渲染效果对照（开发者据此预期宿主自动生成的 UI）。
3. **各能力类型接口契约**（开发者视角的「应用提供的接口」）：
   - 技能：SKILL.md 文件夹规范、依赖与沙箱约束、`<skills>` 注入与「按 Bot 启用」语义；
   - 连接：开放平台 `server.json` 子集 + `_meta`、OAuth 范围声明、端点安全规则、多账号语义；
   - 工具（MCP）：内嵌 MCPB（manifest/compatibility/user_config）与远端 http 两种形态、
     server id 稳定性、工具审批与锁定如何对待插件贡献；
   - 邮件：实例字段模型、内置字段与 `instanceFields`、锁定端点 vs 自填端点、全局 60 秒下限、
     （若 M2 已落地）OAuth 子 schema；
   - 各类型一节「用户看到什么」：卡片 / 同意卡 / 管理 UI 的自动生成效果。
4. **本地开发循环**：`kepcup-app init plugin` → 编辑 → `validate` → `pack` → 扩展中心「从文件夹安装」→
   迭代（重装即更新）；调试建议（最小贡献起步、失败码速查表）。
5. **版本与兼容**：semver、`engines.kepcup`、`platforms`、**可加性契约**（新增 kind / 字段不 bump
   `format_version`；`PLUGIN_UPGRADE_REQUIRED` 的含义）、更新权限差异再同意。
6. **安全规则**：包内不允许的东西（代码执行、密钥、裸 stdio 命令）、路径防护、权限从贡献推导、
   文案清洗；开发者如何写「好的同意卡描述」。
7. **发布到官方市场**：策展流程（`plugins/` 目录 PR → 签名索引 → R2），社区自托管市场简述
   （公钥登记、封顶 community）。
8. **给编程 Agent 的操作指南**：一步一命令的最短路径、自检清单（validate 零 error、同意卡字段
   齐全、README/icon 可选件）、常见错误与修复。

### 3.2 `app-validator` 与脚手架

1. `validate` 插件模式补：`config.fields` / `instances` / `instanceFields` 校验、字段 key 查重、
   `capabilitySummary` 可生成性检查；JSON 报告相应字段。
2. `init plugin` 模板更新：生成含 `config` + `instances` 注释骨架的 `plugin.json`、
   README 模板指向新文档。

### 3.3 官方批次

1. 核对 `plugins/` 与线上索引一致（P3 的四个邮件插件、P4-M2 的 custom-mcp 若已做）；
   catalog `tier` 全部重审（邮件插件建议 verified：主机锁定 + 文案审查后）。
2. 走 `plugins/README.md` 的打包 → 签名 → R2 → 索引部署流程；`--verify` 本地验签留档。

### 3.4 设计文稿修正（开发完成后的现状记录）

1. **`docs/design/51-plugin-system.md`**：保留第一期历史结构与「审查修订记录」，追加
   「§15 现状（D105 插件平台迭代）」大节：能力类型注册表、贡献 / 实例 / 配置模型、注入模型
   （`plugin_ids` / `project_plugins` / 有效启用集表）、可加性契约、邮件插件化、安装引导、
   已删除面（presets RPC / install_skill / MAIL_PROVIDER_PRESETS / 预置目录 / 推荐技能段）、
   后续路标（custom-connector 实例化、短信 / 电话 / 传感器、插件依赖）。
2. 受影响设计补记（各加一节「D105 修订」或现状注记，一两段即可，不重写）：
   `22-file-skill-routing`（技能阶梯改插件阶梯）、`29-connected-apps`（§16 扩展中心两页签、
   连接目录通道已删、注入按插件）、`35-mail-channel`（账号 = 插件实例、预设删除、OAuth 若落地）、
   `40-capability-mounting`（能力目录按启用集过滤）、`41-project-team`（项目组「插件」分区）、
   `23`（自定义 MCP 归属，若 M2 落地）。
3. `docs/dev/PROGRESS.md` 加行；`todo/plugin-platform/` 各阶段实施记录收尾；
   `todo/plugin-system/README.md` 已在迭代开始时标注被取代（核对无需再动）。

### 3.5 盲测验收（本迭代的最终门槛）

1. 起草一份任务书：「仅依据 `docs/guides/write-a-plugin.md`（与 `kepcup-app --help`），
   开发一个『GitHub 仓库摘要』插件：1 个技能贡献 + `config.fields`（默认仓库列表），
   打包为 `.kepcup`」——交给一个未接触本仓库的编码 Agent 执行。
2. 通过标准：其产物 `kepcup-app validate` 零 error；扩展中心本地安装成功；
   同意卡展示 config 字段；安装后可在 Bot「插件」区块启用并在会话中生效。
3. 未通过 → 修文档（不改代码迁就），重测。

## 4. 验收

- [ ] 盲测验收通过（产物与证据留档实施记录）。
- [ ] 文档章节清单全覆盖，且与代码逐条核对无漂移（字段名 / RPC 名 / 行为描述抽查）。
- [ ] 线上索引与仓库批次一致（18 + 新增），验签通过。
- [ ] 设计文稿修正完成：51 §15 在位；六个受影响设计各有 D105 注记；PROGRESS.md 已加行。

## 5. 实施记录

（执行后填写。）
