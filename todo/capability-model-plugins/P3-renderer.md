# P3 · renderer UI 与对话内设置

> 状态：**已实施（2026-11-15，工作区未提交；含审查修正）** · 依赖：P2 · 分支：`feat/plugin-platform`（单集成分支，与 P2 同支）
> 必读：[CURRENT-STATE](CURRENT-STATE.md) §3/§5 → [60 号设计 §5 / §6 / §8](../../docs/design/60-capability-model-plugins.md) → Bot 详情「插件」区块现有组件、`CapabilityModelSection.svelte`、插件详情页（mail/im 实例管理同形）

## 1 目标

把 P2 的机制做成用户可见的三块：Bot 详情「插件」区块的**条目勾选**、插件详情页的**模型条目与实例管理**、对话内**插件凭据设置卡**（SETUP_REQUIRED 自动续跑）。以及工具描述注入条目清单。

## 2 范围

| 包含 | 不包含 |
|---|---|
| Bot 详情插件区块：按插件分组条目复选（`plugins.setBotCapabilityEntries`） | 全局七槽位卡改动（原样保留，仅加入口行） |
| 插件详情：条目只读列表 + 逐条「测试连接」；实例添加/删除/凭据表单 | 设置目录新条目（决策：零新增） |
| 设置页能力卡「插件提供」入口行（deepLink 插件详情） | 用量页新视图 |
| 对话内插件凭据卡（setup 需求 payload `{pluginId, instanceId, entryId}` 渲染 PluginField 表单） | 首次安装引导流程改动 |
| 工具描述注入条目清单（≤6 行） | 窄屏专项（复用既有响应式，不单列任务） |

## 3 开工前核对

```bash
git log --oneline -3
rg "SETUP_REQUIRED|capability-model" packages/core/src --count-matches | head   # 确认 P2 payload 已带定位
rg "DEV-" DEVIATIONS.md | tail -5
```

## 4 步骤

### 步骤 1：Bot 详情条目勾选

1. 定位 Bot 详情「插件」区块组件（D105 P4 收拢处，参照 `InkCop` 排除逻辑确认落点）：插件卡片展开区按能力分组渲染条目（分组标题用能力中文名：图片生成 / 视频生成 / 语音合成 / 语音识别 / 图文理解…）。
2. 条目行：复选框 + `displayName`（次行 `model`）+ 配置状态徽标（`listCapabilityEntries` 的 `configured:false` 置灰 +「去配置」→ 跳插件详情实例区）。
3. 变更即存：整集替换调 `plugins.setBotCapabilityEntries`（乐观更新 + 失败回滚 toast，与 `setBotPlugins` 交互一致）；插件被卸载后残留 ref 显示「已卸载」灰行、不可勾选，保存时由 core 忽略（60 §决策 5）。

### 步骤 2：插件详情页

1. 能力模型类插件（有 `capabilityModels` 贡献）详情页新增「模型条目」区：只读列表（能力徽标 / displayName / model / engine），每行「测试连接」按钮 → `plugins.testCapabilityEntry`，结果以行内徽标回显（成功绿 / 失败红 + 错误人话——复用 `media/http.ts` 错误码文案映射）。
2. 「账号实例」区与 mail / im 插件实例管理同形：添加实例（`instanceFields` 表单，`sensitive` 字段密码框）、删除实例、多实例提示（条目未指定 `instance` 且多实例时，行内提示「调用需在条目上指定实例」）。
3. 设置页 `CapabilityModelSection` 每卡底部加一行「插件提供 · N 个模型 →」：N 来自 `listCapabilityEntries` 过滤该能力，点击 deepLink 扩展中心对应插件详情。零目录改动（AGENTS.md 设置清单不触发）。

### 步骤 3：对话内插件凭据卡

1. setup 需求消费处（D58 链的设置卡渲染，`kind:'capability-model'`）：按 `payload.pluginId/instanceId` 拉取引擎 `credentialFields`（复用 `plugins.listCapabilityEntries` 或既有实例字段 RPC——以 P2 实际暴露为准），渲染 PluginField 通用表单（`sensitive` 密码框，与插件实例表单同一组件）。
2. 保存 = 实例创建/更新（走插件实例既有 RPC），成功后既有自动续跑（`runs.retry`）接管；卡片回执文案带条目名（「已配置阿里云百炼 · Qwen-Image，正在继续生成图片」）。
3. 凭据永不出现在卡片回执、消息、设置快照（D89 敏感字段规则；表单组件已有此保证，勿破坏）。

### 步骤 4：工具描述注入

1. orchestrator 构建媒体 deps 处（`#mediaFacade` 调用方）：按 Bot 解析条目摘要（`displayName(model)` 逗号清单，≤6 行，超出截断 +「等 N 个」），传入 `imageTools` / `speechTools` 工厂。
2. 三个生成工具描述追加一段：「本 Bot 可用的 {能力} 模型条目：…；用 model 参数指定，留空用默认」。**清单为空（未绑定条目）时不追加任何文案**——描述与今日逐字节一致。

### 步骤 5：定向测试与护栏

```bash
node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts
node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts packages/core/test/unit/settings-item-writes.test.ts packages/core/test/unit/settings-adapters-coverage.test.ts   # AGENTS.md 设置护栏（确认零新增 + 覆盖率不回退）
node scripts/run-tests.mjs run apps/desktop/src   # renderer 目录定向（按仓库实际 renderer 测试位置调整）
```

UI 交互验证（手动清单，记入实施记录）：勾选条目 → 任务里生成图片走条目；去配置 → 补凭据卡 → 自动续跑；卸载插件 → 灰行 + 回退全局槽位。

## 5 验收

- [ ] Bot 详情可勾选条目并即时生效（勾选后下一任务 `generate_image` 走条目模型）。证据：UI 与 RPC 已落地（`BotPluginsSection` 条目复选 → `plugins.setBotCapabilityEntries` 整集写入）；端到端生成链路属手动清单，**待主代理收口时在桌面端实测补证据**。
- [ ] 插件详情条目列表 + 测试连接 + 实例管理可用；多实例未指定时条目行有提示。证据：`ExtensionCapabilityModels.svelte`（条目区 `instanceState==='multi'` 行内提示；实例区同 mail/im 形）；端到端属手动清单，同上待补。
- [ ] 对话内凭据卡出卡、保存、自动续跑闭环走通；凭据不出现在任何回执/快照。证据：分发判定 `isPluginCredentialEntryPath`（setup-alias.test.ts 5 用例）；保存走既有实例 RPC，敏感值 core 侧只进 secrets（D105 既有投影）；续跑复用 `continueAfterSetup`（D58 链不动）；闭环实测待补。
- [x] 未绑定条目的 Bot：媒体工具描述与今日逐字节一致。证据：`packages/core/test/unit/media-tools.test.ts`「生成工具描述的条目清单注入」5 用例——三个基线描述在测试里逐字节复抄，`toBe` 全串断言（缺省 hints / 空数组 / 注入 / 按能力分流 / >6 条截断）。
- [x] AGENTS.md 四个设置定向测试全绿。证据：card-components 13 用例；settings-catalog 35 + settings-item-writes 38 + settings-adapters-coverage 合计 79 用例全绿（2026-11-15 审查轮）。`git diff 2737420a -- packages/shared/src/settings-catalog` 为空（零新增）。

## 6 实施记录

- 分支 / 提交：`feat/plugin-platform`（单集成分支，未 commit；任务书原定 `feat/capability-plugins/p3-renderer`，与 P2 的单分支现实一致，提交由主代理负责）。
- 条目分组组件落点：
  - 条目勾选：`apps/desktop/src/renderer/src/lib/features/bot-panel/BotPluginsSection.svelte`（插件卡展开区按能力分组复选）+ 纯函数 `bot-panel/bot-plugins.ts`（`toggleEntryRef` / `dedupeEntryRefs` / `saveableEntryRefs` / `groupEntriesByCapability` / `ENTRY_GROUP_ORDER` / `ENTRY_GROUP_LABEL_KEYS` / `CAPABILITY_ENTRIES_MAX`）。
  - 条目数据 store：`plugins/capability-entries.svelte.ts`（`plugins.listCapabilityEntries` 分组视图，`start()` 幂等 + `plugins.changed` 重拉；capability-entries.svelte.test.ts 6 用例）。
  - 插件详情：`extension-center/ExtensionCapabilityModels.svelte`（模型条目只读列表 + 逐条测试连接 + 账号实例增删改）+ 表单 `plugins/CapabilityInstanceForm.svelte`（与对话内凭据卡共用，sensitive 密码框由 `PluginFieldForm` 保证）。
  - 对话内凭据卡：`chats/PluginCredentialSetupBody.svelte`，分发在 `settings-card/SettingSetupBody.svelte`（判定纯函数 `chats/setup-alias.ts` 的 `isPluginCredentialEntryPath`）。
  - 设置页入口行：`settings/ModelConfigDetail.svelte` 能力槽位卡内「插件提供 · N 个模型」→ deepLink；工具描述注入：`core/tools/media-entry-hints.ts` + orchestrator 媒体 deps 构建处 + `media/service.ts` `entrySummariesFor`。
- 测试：media-tools.test.ts +5 用例（描述注入护栏）、bot-plugins.test.ts +5、capability-entries.svelte.test.ts +6、setup-alias.test.ts +5、extension-center/tabs.test.ts +4；settings 护栏三测试与 renderer 全目录（196 文件 / 1905 用例）2026-11-15 全绿。
- DEV 偏差（已落账 DEVIATIONS.md）：
  1. **DEV-100** 设置页「插件提供」入口行落 `ModelConfigDetail.svelte`（设置页现役能力槽位 UI）而非任务书字面的 `CapabilityModelSection.svelte`——后者现仅存于对话内设置卡（SettingCardEmbed），放它会把 deepLink 带进对话卡且设置页反而没有入口；与 60 §5「设置页加入口」的意图一致。
  2. **DEV-101** 新增 `shell.extensionCenterPluginFocus` deepLink 状态（仿 `extensionCenterSystemCardFocus` 消费即复位模式），承载设置页入口行与 Bot 详情「去配置」两处落点；「去配置」落插件详情页顶部、不滚动定位到实例区（详情页信息架构条目区在前，接受现状）。
  3. **DEV-102** 卸载残留 ref 在**渲染端保存前剔除**（`saveableEntryRefs`）：任务书步骤 1.3 写「保存时由 core 忽略」，但 P2 的 `setBotCapabilityEntries` 实现为未知 ref **整批拒绝**（INVALID_INPUT），「忽略」无法成立，故改为不发送；灰行展示 + 不可勾选照旧（60 §决策 5 的 UI 语义保留）。
  4. **DEV-103** `ENTRY_GROUP_LABEL_KEYS` 等分组纯函数放 `bot-panel/bot-plugins.ts`（与条目勾选逻辑同文件），插件详情（extension-center）跨特性导入复用；任务书未规定位置。
  5. 未配置/空清单文案复用既有键为主（`apps.catalog.loading` / `mcp.pluginMissing` 等），仅 `plugins.capabilityModels.*` 一组新键与 `settings.capabilityPluginProvided*` 两个入口行键为新增；审查补 `noEntries` / `notConfiguredHint` 两键修正空态文案误用（键级修订，不入 DEV 账）。
- 审查修正（2026-11-15，独立审查子代理）：
  1. `ExtensionInstalled.svelte` 插件深链消费改为等清单拉到再判定（新纯函数 `tabs.ts#pluginFocusContentView` + 4 用例）——原先立即消费会在冷启动（清单未 load）吞掉 focus，深链落回插件网格而非详情。
  2. `SettingSetupBody.svelte` 条目路径分发：清单未拉到时也先走凭据卡（凭据卡新增载入态；清单拉到后插件缺失才回落全局槽位卡，缺失文案改 `mcp.pluginMissing`）——原先载入窗口会误派发全局能力槽位卡，配好也解不了实例凭据缺失。
  3. `CapabilityInstanceForm.svelte`「未保存先测」的 keyOverride 键从实例字段声明取（首个 sensitive 字段），不再硬编码 `values.apiKey`（首批三引擎恰好都是 apiKey，后续引擎换键名会静默失效）。
  4. 空态文案：Bot 详情条目空态与插件详情条目空态原复用「插件声明的一个模型一条；到 Bot 详情…勾选」（自我指涉）/「没有这个类别的插件」（语义不符），改用新键 `plugins.capabilityModels.noEntries`；插件详情未配置行「未配置：还没有账号实例：…」双冒号改 `notConfiguredHint` 专用文案。
  5. 删除 `capability-entries` store 上无任何组件消费的 `testing` SvelteSet 死代码（测试连接在途标记由各调用方自持）。
- 手动清单（任务书步骤 5）未执行：勾选条目 → 生成图片走条目 / 去配置 → 补凭据卡 → 自动续跑 / 卸载插件 → 灰行 + 回退全局槽位，待主代理在桌面端收口时实测并回填 §5 前三项证据。
- 已知越界事实（并行阶段 D125-P1 引入，非本阶段）：`packages/shared` 的 `CapabilityModelEntry.engine` 转可选后，P2 已提交 core 代码出现 8 处 tsc 错误（`MEDIA_ENGINES[entry.engine]` 索引等，`pnpm --filter @kepcup/core typecheck` 红属并行阶段账，不由 P3 处理）。
