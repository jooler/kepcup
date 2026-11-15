# P3 · renderer UI 与对话内设置

> 状态：**待实施** · 依赖：P2 · 分支：`feat/capability-plugins/p3-renderer`
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

- [ ] Bot 详情可勾选条目并即时生效（勾选后下一任务 `generate_image` 走条目模型）。证据：
- [ ] 插件详情条目列表 + 测试连接 + 实例管理可用；多实例未指定时条目行有提示。证据：
- [ ] 对话内凭据卡出卡、保存、自动续跑闭环走通；凭据不出现在任何回执/快照。证据：
- [ ] 未绑定条目的 Bot：媒体工具描述与今日逐字节一致（快照断言或字符串断言）。证据：
- [ ] AGENTS.md 四个设置定向测试全绿。证据：

## 6 实施记录

- 分支 / 提交：
- 条目分组组件落点：
- DEV 偏差：
