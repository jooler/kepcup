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

**状态：已收口**（2026-10-29；分支 `feat/plugins-platform/p5-docs-market`，基线 `0768ae34` = P4 收口）。

**按提交**：

1. `f1a884f3` feat(plugins): **P4 遗留决策①落地**——`plugins.enableForBots { pluginId, botIds }`
   合并语义 RPC（P4 审查 P2-2 处置）：shared 契约 + `domain.bots.addPluginIds`（读-并-写单次
   同步完成、已启用幂等 no-op、新 id 追加保序）+ binding（整批 Bot 先校验后写，任一失败整体
   拒绝；`bot.updated` 按实际写入广播、`plugins.changed` 一次）+ 渲染端两处合并写收编
   （`PluginInstallHintDialog`「立即添加到 Bot」、`MailAccountAddForm` 保存时合并启用）；
   `setBotPlugins` 保留整集替换语义给编辑器（`BotPluginsSection`）与初始化
   （`OnboardingWizard`）。集成测试 3 例（并集保序/幂等、事件广播、整批拒绝不落一半）。
2. `f0ec7fb0` feat(app-validator): **P5 §3.2**——`plugin.field-default`（warn：default 与
   类型 / min-max 不符、sensitive 字段声明 default）与 `plugin.capabilities`（info：
   capabilitySummary 预览 + config 字段数 / 实例 kind 数，进 JSON 报告 details）；
   config.fields 与 mail instanceFields 同一套检查；`init plugin` 骨架带示例 config 字段。
   app-validator README 检查项清单同步。测试 4 例新增。
3. `3958867f` docs(plugins): **P5 §3.1**——`docs/guides/write-a-plugin.md` 全面重写
   （八章节：概念三分/信任分级/安装管线、plugin.json 逐字段参考、PluginField 全字段与
   自动表单渲染对照、**default 不物化语义框注与 directory/file 校验责任**（P4 遗留③）、
   四类能力接口契约与「用户看到什么」、本地开发循环、可加性契约与更新再同意、安全规则、
   官方市场策展流程、编程 Agent 指南、宿主侧新增能力类型菜谱（四个 per-kind 手工点）；
   `docs/guides/README.md` 索引行同步。
4. `97053c87` fix(plugins): **官方批次 + 签名脚本修复（P5 §3.3）**——见下「官方批次」。
5. `3c66e2a0` docs(design): **P5 §3.4**——51 头部现状注 + §15「现状（D105 插件平台迭代）」
   七小节；29 / 35 / 40 / 41 / 23 各加 D105 头部补记（22 的补记 P4 已写）。
6. `368a88d5` feat(plugins): 同意面板新增「插件配置」小节（渲染 inspect 的
   `configFields` 安全投影：title + 必填/敏感徽标 + 描述）——**P5 §3.5 通过标准「同意卡展示
   config 字段」的宿主面缺口补齐**（此前该字段只出现在已装卡「设置」表单）；i18n 一键
   两语言；`blind-acceptance.spec.ts` 验收 e2e（env 门控 `KEPCUP_BLIND_*`，缺省跳过）。
7. `08a2a03f` docs(plugins): 按盲测反馈修文档（六条，见下「盲测验收」）。

**P4 遗留决策②（capabilitySummary 多语言）**：维持 core / 签名侧派生的**单一中文句子**——
与 core 派生的实例字段标题同一姿态（P1 审查 P1-6、DEV-074 先例）；「结构化事实 + 渲染端
i18n 重建 / 索引多语言字段」登记为路标（51 §15.2），英文市场上线时再兑现。

**官方批次（§3.3）**：22 个插件全部重打包到 `/tmp/kepcup-p5-market`；catalog 全部 `verified`
（邮件四插件按阶段建议定 verified：主机锁定 + 文案已随 P3 审查）；`sign-plugins.sh` 签名
（keyId `kepcup-plugins-2026-1`）+ `--verify` 本地验签通过（22 entries / 0 revoked）。
**线上一致性核对**：`dl.kepcup.com/plugins/v1/index.json` 拉取验签通过，线上 18 条的
id@version / tier / sha256 与本地重打包**逐字节一致**（打包可复现性得到实证）；线上缺的
正是本迭代新增的 4 个邮件插件。**待维护者执行生产部署**（R2 上传 22 包 + `wrangler deploy`
索引——直接署名会顶掉线上索引，须先全部上传；命令见 plugins/README.md，本代理不执行生产
发布）。**顺带修复 P4 引入的真 bug**：`sign-plugin-index.mjs` 把原始 JSON 清单传给
`capabilityFactsOf`，而真实清单省略空的 per-kind 数组（邮件插件只带 `contributions.mail`）→
首个 `.skills.length` 即崩——P4 的 capabilitySummary 索引路径此前只被全字段清单的单测跑过；
修复为按 schema 解析后的清单构造条目，shared dist 缺失时 fail closed（此前静默省略字段）。

**盲测验收（§3.5，真实执行）**：

- **任务书**：交给一个 fresh-context 编码 Agent（未读仓库），唯一读物 =
  `docs/guides/write-a-plugin.md`（拷贝到 /tmp/blind-test）+ CLI `--help`；明令禁止读取
  仓库其他文件。任务：「GitHub 仓库摘要」插件：1 个技能贡献 + `config.fields`（默认仓库
  列表，多值）→ 打包 `.kepcup`。
- **产物**：`/tmp/blind-test/work/github-repo-summary.kepcup`
  （io.github.blind.agent/github-repo-summary@1.0.0，sha256 `09f2d1e4…`）。**validate 对
  目录与产物均零 error、零 warning**（2 条 info 为能力概述与权限推导说明）；Agent 自行
  验证了两次打包 sha256 一致（文档可复现性声明属实）；对 `default` 语义的复述准确。
- **宿主侧验收（`blind-acceptance.spec.ts`，全绿）**：扩展中心本地安装 UI 全流程（路径输入
  → 检视 → 同意面板）→ 同意卡「插件配置」小节展示「默认仓库列表」→ 安装成功引导弹框 →
  Bot「插件」区块启用 → 会话请求 `<skills>` 含 `github-repo-summary` → `bots.get` 确认
  `plugin_ids` 落点。**通过标准四条全过。**
- **文档反馈 → 修文档（不改代码迁就）**：六条全部成立并落地（`08a2a03f`）：①技能贡献
  没有 config 运行时消费路径的预期管理（§2.3 新框注）；②`id` 形式化正则（§2.2）；③
  SKILL.md frontmatter 规格（name 字符规则 / 1024 截断 / 额外键，§3.1）；④协议词汇封闭
  清单 + 技能正文豁免（§6）；⑤`plugin.*` 检查项全集附录（解除对 app-validator README 的
  阅读依赖）；⑥engines 版本锚点（当前 0.4.0）。修订后文档副本留档
  /tmp/blind-test/write-a-plugin.post-fix.md。

**验收对照（§4）**：

- [x] 盲测验收通过——产物与证据见上（validate 零 error + 验收 e2e 四条全过）。
- [x] 文档章节清单全覆盖、与代码逐条核对无漂移——八章节对照 §3.1 清单逐条写就；字段名
      （pluginFieldSchema 九字段、清单字段表）、RPC 名（plugins.* 全表）、错误码
      （PLUGIN_UPGRADE_REQUIRED 等）、上限（50/20/10/10、32/16/4、64KB/512MB/500MB/
      200MB/20000）、localStorage 键、secrets 键形、server id 推导、60 秒下限等均经源码
      复核；盲测 Agent 的独立试读是第二重核对（其「猜错处」即 id 规则与 frontmatter 规格
      已按反馈补全）。
- [x] 线上索引与仓库批次一致——18 条既有包 sha256/tier 逐字节一致；新增 4 条已签名留档、
      待维护者部署（生产操作，见 plugins/README.md 的待办注记）；`--verify` 通过。
- [x] 设计文稿修正完成——51 §15 在位（七小节）；29/35/40/41/23 各有 D105 补记（22 已于
      P4）；PROGRESS.md 已加行（本迭代整体收尾行）。

**DEVIATIONS**：DEV-076——§3.2 要求 init 模板「生成含 config + instances **注释**骨架的
plugin.json」，而 JSON 不支持注释；处置：plugin.json 生成**真实可校验的示例 config 字段**
（宿主自动出「设置」表单，删改即学），`instances` 骨架（邮件配对示例）放 init 生成的
README 模板并指向开发文档。下一编号 **DEV-077**。

**自由度判断点**：①验收标准「同意卡展示 config 字段」此前无宿主面（P4 只建了已装卡设置
表单）——按验收字面补齐同意面板小节，而非修改文档措辞迁就现状；②`plugins.enableForBots`
按 P4 审查建议直接实现（HANDOFF 将其列为「是否登记」的决策点，判断为：竞态是真实缺陷、
契约登记即实现，渲染端收编两处后 `setBotPlugins` 的余下调用点全部是合法整集语义）；
③验收 e2e 以 env 门控常驻仓库（`KEPCUP_BLIND_*` 缺失即跳过），验收可重放；④官方批次
catalog 以脚本从各插件清单现读生成（summary.name/description/author 与包一致，避免手抄漂移）。

**遗留问题（转后续路标，均为任务书既有路标非本阶段新增）**：①市场生产部署（R2 + 索引
deploy）待维护者执行；②M2 custom-mcp 实例化 + 邮件 OAuth（P3/P4 顺延不变）；③
capabilitySummary 多语言重建（51 §15.2 路标）；④`plugins.enableForBots` 尚无 e2e 直接
断言（引导弹框旅程经它写入，e2e 断言的是落点而非 RPC 本身；core 集成测试 3 例覆盖契约）。

**测试证据汇总**：定向——core 插件面 7 文件 71 例全绿（injection / capability-mounting-p2 /
instances / plugins / plugins-bot / registry / migration）+ `plugins-enable-for-bots` 3 例 +
app-validator plugin-validate / plugin-init-pack / readme-anchors / cli 全绿 + sign-plugin-index
4 例；renderer plugins / extension-center / mail 36 例全绿；locales 两语言键序测试过。
e2e——`plugins` 14 + `plugins-market` 11 + `plugins-manage` + `bot-plugins` + `blind-acceptance`
1（新增）+ `extension-center` + `local-connectors` + `mail-plugins` 全绿。typecheck：shared /
core / app-validator / desktop（svelte-check 0 error 0 warning）全过。全量一次见 PROGRESS.md
本迭代收尾行。
