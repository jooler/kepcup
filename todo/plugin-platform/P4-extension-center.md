# P4 · 扩展中心收口：卡片配置 / 实例 UI、安装引导、清理

> 状态：**已收口**（2026-10-29；M2 顺延，见 §6 实施记录与 HANDOFF）。依赖：P2、P3。
> 分支：`feat/plugins-platform/p4-extension-center`。
> 必读：[README.md](README.md) §2.2–2.5；[CURRENT-STATE.md](CURRENT-STATE.md) §1/§3；
> 源码 `features/extension-center/ExtensionInstalled.svelte`、`ExtensionMcp.svelte`、
> `ExtensionLocalCollab.svelte`、`features/plugins/{plugins.svelte.ts,PluginConsentPanel.svelte}`、
> `features/settings/McpSection.svelte`（M2）。

## 1. 目标

交付后：扩展中心是唯一且自洽的插件管理中心——插件卡上直接完成配置与实例管理（表单全部由
声明字段自动构建）；安装成功有接入引导弹框（含「不再提醒」与「立即添加到 Bot」）；旧组件缝合点
（McpSection 薄壳、死代码）清理完毕；页签收敛为 `market / installed` 两页签，系统能力（InkCop、
本机自建连接）以「系统卡」进入已安装网格。

## 2. 范围

| 包含 | 不包含 |
|---|---|
| M1：卡片「设置」（config）与实例管理 UI（`PluginFieldForm` 复用） | 邮件账号表单本体（P3 已做） |
| M1：安装成功引导弹框 + 不再提醒 + 立即添加到 Bot | 项目组侧引导（项目组分区已可达，不加弹框） |
| M1：MCP 管理按插件圈定；死代码清理；两页签收敛 + 系统卡 | custom-mcp 实例化（M2，可顺延） |
| M1：e2e 补齐（`plugins-manage-*` / 新弹框 / 两页签） | LocalConnectors 实例化（路标） |
| M2：`app.kepcup/custom-mcp` 纯实例插件收编手动 MCP 与独立 `.mcpb` 安装 | 智能体 / settings 贡献类型 |

## 3. M1 步骤

### 3.1 卡片配置与实例 UI

1. 抽共享组件 `features/plugins/PluginFieldForm.svelte`（P3 已建则复用）：`PluginField[]` + 值 →
   自动表单（boolean→Checkbox、multiple→textarea、sensitive→password、number→min/max、
   directory/file→路径选择器），必填校验与敏感值清理沿 `plugin-install.ts` 既有纯函数。
2. 插件卡（`ExtensionInstalled.svelte`）：清单含 `config.fields` 的插件在 ⋮ 菜单加「设置」→
   卡片就地展开 `PluginFieldForm`（初值 `plugins.config.get`，保存 `plugins.config.set`，
   敏感字段显示「已设置」占位）；`plugins.svelte.ts` 加 `config` / `instances` 状态与动作。
3. 实例管理：「管理」内容视图中 mail / mcp 类渲染实例列表（`plugins.instances.list`）：
   行 = 实例标题 + 状态 + ⚙（编辑表单）+ 删除；「添加 {类别}」→ `PluginFieldForm`（内置字段 +
   插件 `instanceFields`）→ `plugins.instances.create`。
4. 市场卡与详情：`capabilitySummary` 一句话展示；`instanceCounts` 参与筛选计数（纯实例插件
   出现在对应类别筛选）；`mcp` 类别标签显示「工具」。

### 3.2 MCP 按插件圈定

`ExtensionMcp` 内容视图加 `pluginId` prop：`McpSection.svelte` 按其过滤 server 列表
（`server.source?.pluginId === pluginId`），隐藏「新建 server / 安装 .mcpb」入口（那是全局能力，
只在无 pluginId 圈定时显示）；插件卡「管理 · 工具」→ 该插件的 server 列表 + 各自状态。

### 3.3 安装成功引导弹框（目标 5）

1. `PluginInstallDialog` 安装 / 更新成功后（安装路径：市场 + 本地；更新不弹），若
   localStorage `kepcup.plugins.installHint.dismissed !== '1'` → 渲染 `PluginInstallHintDialog`：
   - 标题「{插件名} 已安装」；
   - 正文「插件的能力不会自动生效。需要在 Bot 详情或项目组设置的「插件」里启用它，
     对应 Bot 才能使用。」；
   - 按钮「立即添加到 Bot…」（二级视图：Bot 多选列表 → `plugins.setBotPlugins` 合并写入 →
     toast 确认）/「完成」；
   - 勾选「以后不再提醒」→ 写 localStorage（`kepcup.plugins.installHint.dismissed = '1'`，
     风格沿 `kepcup.apps.acpNoticeAck`）。
2. Bot 发起的 `confirm-plugin-install` 确认卡**不弹**（对话内已有上下文）。
3. i18n 键 `plugins.installHint.*`；testid `plugins-install-hint-*`。

### 3.4 页签收敛与系统卡

1. `EXTENSION_CENTER_TABS` 收敛为 `['market', 'installed']`；`localCollab` 深链别名 →
   `installed` + 滚动到系统卡（`LEGACY_TAB_FILTERS` 同法登记）；`tabs.test.ts`、
   `settings-ui-scan`（单行数组正则）同步。
2. 已安装网格（`filter: 'all'`）末尾渲染两张**系统卡**（`badge「系统」`、无插件菜单）：
   「本机应用协作」（现 `ExtensionLocalCollab` 内容收编为卡片展开）、「本机自建连接」
   （现 `LocalConnectorsSection` 收编）；明确注释：系统能力不是插件，路标见设计文稿修正。

### 3.5 死代码清理

删除：`ExtensionSkills.svelte`、`market.svelte.ts`、`ExtensionCenterBody` 的 skillMarket reset、
`skillMarket.*` i18n、`skills.presets.*` RPC（core + shared + bindings）、`install_skill` 工具
（`skill-tools.ts` + 提示词注册）、`<recommended_skills>` 段与 `promptSection`、
`packages/core/src/skills/presets.ts`（`isBuiltinSkillSource` 迁至 `projectors/skills.ts` 或 shared）。
同步：`docs/design/22`、D63 相关测试改写（技能获取阶梯 = 插件阶梯：`plugin_search` →
`plugin_request_install`）；`skill-market.spec.ts` 删除。注意保留 `plugin://` 前缀与
`0054` 迁移产物的读取兼容（`isBuiltinSkillSource` 语义不变）。

## 4. M2 步骤（可独立顺延；顺延时本节移入后续路标）

1. 官方插件 `plugins/custom-mcp/`：`instances: ['mcp']`、无贡献。
2. mcp kind materializer：实例字段 = `name / transport(stdio|streamable-http|sse) /
   command / args / env / url / headers`（字段集按 transport 条件显隐）；`.mcpb` 文件作为特殊
   创建路径（`source` file 字段 → 内部走 `McpbInstaller`，渲染为「从包安装」按钮）。
   `settings.mcpServers` 条目 `source = { kind:'instance', pluginId:'app.kepcup/custom-mcp', instanceId }`；
   `mcpServerSourceSchema` 加 `instance` 分支。
3. `guards.ts`：`instance` 来源 server 的受保护字段只能经 `plugins.instances.update` 修改
   （直接 `settings.update` 改结构 → `PLUGIN_MANAGED`）；启用开关仍可改。
4. 启动惰性迁移（一次性，core 例程非 SQL）：无 `source` 的手动 server → 生成实例行 + 回写 source。
5. `McpSection` 全局视图退役：自定义 MCP 管理 = 插件卡「自定义工具」；`mcpb.inspect/install`
   独立 RPC 保留（headless / CLI 使用），桌面入口移除。
6. P2 语义对齐：手动 server 的 Bot 级勾选（`mcp_server_ids`）成为该插件展开区的实例细选。

## 5. 验收

- [ ] 插件卡「设置」：改插件 config → 保存 → secrets / `config_json` 落点正确 → 重开回显。
- [ ] 邮件插件卡：实例列表 / 添加 / 编辑 / 删除全通；MCP 插件卡只看到该插件的 server。
- [ ] 安装市场插件 → 引导弹框出现 → 勾「不再提醒」→ 再装一个插件不再弹；清 localStorage 后恢复。
- [ ] 「立即添加到 Bot」：勾选两个 Bot 后，两 Bot 的 `plugin_ids` 均含新插件且各自 UI 同步。
- [ ] 扩展中心两页签；`localCollab` 旧深链落到已安装页系统卡；系统卡无插件操作菜单。
- [ ] 死代码清理后全仓 grep 无 `skillMarket` / `skills.presets` / `install_skill` /
      `recommended_skills` 残留；全量 `pnpm test` 一次不超基线。
- [ ] （M2 若做）手动新建的 MCP server 出现在「自定义工具」插件卡内；绕过实例 RPC 改
      command/args 被 `PLUGIN_MANAGED` 拒绝。

## 6. 实施记录

**按提交**（基线 `0b7f8598` = P3 收口 → 分支 `feat/plugins-platform/p4-extension-center`）：

1. `bd20840e` feat(plugins): 市场条目输出 `capabilitySummary`（README §4.1 收口项）——签名脚本
   由清单推导写入索引条目（可选字段，老索引保持有效），core 对缺省条目按 `categories` 回退
   （`pluginCapabilitySummaryFromCategories`）；`pluginContributionKindSchema` 移入
   plugin-manifest.ts（capability 摘要helpers 在清单域，避免循环导入），plugins.ts re-export。
2. `d0f6d949` feat(plugins): 插件卡「设置」——⋮ 菜单「设置…」（`configFields` 非空才出现）→
   卡内就地展开 `PluginFieldForm`（初值 `plugins.config.get`，保存 `plugins.config.set`）；
   `PluginFieldForm` 补 directory/file 路径选择器与敏感「已保存」占位；`instanceCounts`
   参与筛选计数（纯实例插件可被筛出）；市场卡展示 `capabilitySummary`。
3. `9c946634` feat(plugins): MCP 管理按插件圈定——`ExtensionMcp` 加 `pluginId` 透传
   `McpSection`（按 `server.source.pluginId` 过滤列表与待批准加载；新建 / .mcpb /
   OAuthClientsPanel 只在无圈定视图出现；圈定文案「工具服务器」）。
4. `40fbecc4` feat(plugins): 安装成功接入引导弹框 `PluginInstallHintDialog`——市场与本地两条
   安装路径经 `PluginInstallDialog` 统一触发（更新与 Bot 对话内确认卡不弹）；
   localStorage `kepcup.plugins.installHint.dismissed`（读失败按未勾、写失败不阻塞关闭）；
   「立即添加到 Bot…」二级视图多选活跃 Bot → 逐 Bot 读现有 `plugin_ids` 并集后
   `plugins.setBotPlugins` 写回（Set 去重幂等）。
5. `fcaa8d08` refactor(plugins): **P2 审查遗留收口**——①装配点 `extraPluginIds` 全部必传
   （undefined=不过滤的旧口径删除；skills promptSection/readableDirs/activeSkills、mcp
   `serversForBot` 双处、exposure `forBot`/`availableFor`、catalog、orchestrator 三处；
   UI 清单 `skills.listForBot` 保持可选——无会话语境，注释写明）；②**邮件启用集过滤落地**
   （P2 §3.5 承诺、P3 未竟）：`visibleMailAccounts`（无 pluginId 系统账号恒放行）统一
   `mailBoundFor`（工具注册）、`MailService.contextSection`（`<mail_accounts>` 段）、
   `buildMailTools` 工具内清单三处同源，`#mailSetupFacade` 同口径；③对话内添加邮箱卡保存时
   合并启用属主插件（用户明确把该插件的邮箱交给这个 Bot = README §2.4「快速启用入口」）；
   ④Bot 详情「插件已停用」标记覆盖邮件绑定（P2 遗留②）。
6. `5bb40ca2` feat(plugins): 两页签收敛 + 系统卡——`EXTENSION_CENTER_TABS` 收敛为
   `['market','installed']`（单行字面量保持 settings-ui-scan 正则）；`LEGACY_TAB_FILTERS`
   登记 `localCollab`（resolveExtensionCenterTarget 返回 systemCard 聚焦标记 → shell 置位 →
   ExtensionInstalled 展开并滚动到系统卡）；「本机应用协作 / 本机自建连接」以系统卡
   （badge「系统」、无插件菜单、可展开）进已安装网格末尾（filter all）；设置目录
   `agents.inkcop-local-collab` 深链改指 installed。
7. `54b73db6` refactor(plugins): 死代码清理——删 `ExtensionSkills.svelte`、`market.svelte.ts`、
   `skillMarket.*` i18n 15 键、`skills.presets.*` RPC（bindings + shared methods +
   `skillPresetInfoSchema`）、`install_skill` 工具（skill-tools.ts + 注册 + 门面 + start.ts
   接线）、`<recommended_skills>` 段（提示词两处 section + orchestrator 输入）、
   `skills/presets.ts`；`isBuiltinSkillSource` 迁至 `projectors/skills.ts`（逐字迁移，
   0054 `plugin://` 行语义不变）；设置目录 `skills.install` 条目（viaTool install_skill、
   预置目录恒空已死）与 `skill-presets` 选项源、`skillInstallAdapter` 一并删除；提示词
   附件阶梯收敛为插件阶梯（`plugin_search` → `plugin_request_install`，两版逐字改写）；
   design 22 加 D105 P4 补记。
8. `c064eea4` test(e2e): 新增 `plugins-manage.spec.ts` 三旅程（config 表单落点/回显、引导弹框
   添加 Bot + 不再提醒、两页签 + 系统卡展开）；`plugins` / `plugins-market` /
   `extension-center` / `local-connectors` 按两页签 + 圈定 + 系统卡模型对齐；修复
   ExtensionMcp 误传 embedded（切成设置卡片段形态）；**DEV-075**（见下）。
9. `410a81fc` fix(plugins): 独立审查修复（见「审查」节）。

**DEVIATIONS**：DEV-075——M2（custom-mcp 实例化）顺延后，插件内容视图圈定使手动 MCP server
的新建 / 编辑 / .mcpb / BYO 入口失去全部 UI 落点（任务书未写到的缺口）；处置：「工具」筛选
（`filter === 'mcp'`）网格下方保留无圈定 `McpSection`（`manual-mcp-section`），M2 收编
`app.kepcup/custom-mcp` 后整块退役（§4.5 原计划不变）。下一编号 **DEV-076**。

**自由度判断点**：①实例管理 UI 按 kind 落地——mail 用 P3 的 ExtensionMail 领域视图（绑定 /
收发模式等更全）、mcp 用圈定 McpSection，未再建通用实例行列表（§3.1 第 3 步的字面「实例列表」
由领域视图承载，避免重复 UI）；②`capabilitySummary` 走索引签名写入 + categories 回退双轨；
③邮件过滤在 P4 落地（P2 顺延时承诺「P3 落地 instance_id 后自然生效」，实际 P3 只落了实例
路径，过滤体本阶段补齐）并配套 setup 卡快速启用；④`min`/`max` 进入 `pluginFieldSummary`
安全投影（数值无文案面；§3.1 number→min/max 的阶段具体条目，README §4.1 契约随之扩展）。

**审查**：fresh-context 只读子代理审 `0b7f8598..HEAD` 全 diff，**P0×0 / P1×1 / P2×6 全部
处置**（`410a81fc` + 后续 test 清理）：P1-1 插件更新删改 config 字段后表单死锁（getConfig
按当前清单投影 values，旧键随全量替换清除；回归测试入库）；P2-1 设置面板并发守卫；
P2-3 orchestrator 陈旧注释；P2-4 docs/dev 03/04 加 D105 P4 补记；P2-6 min/max 投影；
P2-2（setBotPlugins 读-改-写丢更新竞态）与 P2-5（capabilitySummary 硬编码中文）不改代码、
登记为下述遗留。已核对无问题：敏感值面（审计 / 日志 / 错误文案 / 输出投影）、注入模型
必传化无漏点、引导弹框不弹路径、MCP 圈定口径与 PLUGIN_MANAGED 一致、死代码全仓无残留、
页签映射与 settings-ui-scan、测试无放宽断言、安全红线。

**遗留问题（转 P5/路标）**：①`plugins.setBotPlugins` 整集替换下，渲染端两处合并写
（引导弹框、setup 卡）存在读-改-写丢更新竞态——合并语义 RPC（如 `plugins.enableForBots`）
待 P5 契约登记（审查 P2-2）；②`capabilitySummary` 为索引签名内字符串，硬编码中文——
多语言方案（索引侧多语言 or 渲染端按 categories 重建）P5 设计修正时决策（审查 P2-5）；
③清单 `default` 不物化（config_json 无值，消费方读不到）写进 P5 开发文档字段语义节；
④M2 custom-mcp 实例化顺延路标不变（本文件 §4 全节移交后续阶段）。

**验收对照**（§5）：

- [x] 插件卡「设置」：改插件 config → 保存 → secrets / `config_json` 落点正确 → 重开回显
      ——e2e `plugins-manage.spec.ts` 第一旅程（非敏感进 config_json、敏感只在 secrets 且
      快照只有键名、重开非敏感回显 / 敏感空占位）+ core `plugins-instances.test.ts`
      （含审查 P1-1 回归：更新删字段后仍可保存）。
- [x] 邮件插件卡：实例列表 / 添加 / 编辑 / 删除全通——P3 的 ExtensionMail 领域视图承载
      （本阶段结论：不另建通用实例列表）；MCP 插件卡只看到该插件的 server——e2e
      `extension-center.spec.ts`（圈定视图无 ro / 无 mcp-add）+ `plugins.spec.ts`
      （受管 server 行 / 徽标 / 无编辑入口）。
- [x] 安装市场插件 → 引导弹框出现 → 勾「不再提醒」→ 再装一个插件不再弹；清 localStorage
      后恢复——e2e `plugins-manage.spec.ts` 第二旅程（本地路径安装弹框、添加两个 Bot、
      勾不再提醒落 localStorage `'1'`、第三插件不弹）；市场路径在 `plugins-market.spec.ts`
      断言弹框出现并收起。「清 localStorage 后恢复」由弹框判定语义覆盖（读失败 / 键缺失
      即弹），未做单独 e2e（同 e2e 内不能重置 localStorage 而不破坏「不再弹」断言）。
- [x] 「立即添加到 Bot」：勾选两个 Bot 后，两 Bot 的 `plugin_ids` 均含新插件且各自 UI 同步
      ——e2e 第二旅程经 `bots.get` 断言两 Bot `plugin_ids`（UI 同步由 `bots.changed` 事件
      刷新 Bot 详情「插件」区块，P2 既有机制）。
- [x] 扩展中心两页签；`localCollab` 旧深链落到已安装页系统卡；系统卡无插件操作菜单
      ——e2e `plugins-manage.spec.ts` 第三旅程（两页签、系统卡无 ⋮、展开内容）+
      `plugins.spec.ts` / `plugins-market.spec.ts` 页签数断言 + `tabs.test.ts`（映射
      单测，含 localCollab→installed+systemCard）。
- [x] 死代码清理后全仓 grep 无 `skillMarket` / `skills.presets` / `install_skill` /
      `recommended_skills` 残留——仅注释与 docs 历史记录提及（补记注明）；全量 `pnpm test`
      一次见下（失败集合均为已知负载敏感偶发，单跑复核全过）。
- [ ] （M2 若做）——M2 顺延，本节 §4 移交后续路标（HANDOFF 同步）。

**测试证据汇总**：core 全套（含 injection / marketplace / instances / capability-mounting-p2
/ mail / supervisor-turn / tool-effects / context-assembly / settings-*）定向与全量跑通；
shared unit 全绿；desktop renderer 单测 124 文件全绿；svelte-check 0 error（P4 修复后复核）。
e2e：`plugins` 9 + `plugins-market` 8 + `extension-center` 2 + `plugins-manage` 3（新增）+
`bot-plugins` 2 + `mail-plugins` 1 + `local-connectors` 2 + `skills` 3 全绿。

**全量一次**（审查修复后，`node scripts/run-tests.mjs run --maxWorkers=8`）：
**6884 通过 / 3 失败 / 37 跳过（6924 例）**。3 例失败均归因为负载敏感偶发并单跑复核全过：
`permission-bridge` ×2（5 秒超时，HANDOFF 已记载的基线偶发）、`apps/server/auth` ×1
（首启建号时序，单跑 10/10 过；本阶段未触碰 server/auth 面）。无基线外语义失败。

**lint**：本阶段新增 / 修改文件 0 新增报错（`registry.ts` 5 处未用 consent 类型导入与
ExtensionInstalled 的 Map 提示为 P3 基线既有，单测核对过）。
