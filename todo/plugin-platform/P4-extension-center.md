# P4 · 扩展中心收口：卡片配置 / 实例 UI、安装引导、清理

> 状态：待实施。依赖：P2、P3。分支：`feat/plugins-platform/p4-extension-center`。
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

（执行后填写；M2 顺延则写明去向。）
