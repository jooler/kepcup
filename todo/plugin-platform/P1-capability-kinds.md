# P1 · 能力类型注册表、插件配置、实例机制（基座）

> 状态：待实施。依赖：无（基于已完成的第一期 D104）。分支：`feat/plugins-platform/p1-capability-kinds`。
> 必读：[README.md](README.md) §2.1–2.3、§4；[CURRENT-STATE.md](CURRENT-STATE.md)；
> 源码 `packages/shared/src/domain/plugin-manifest.ts`、`packages/shared/src/domain/mcpb.ts`、
> `packages/core/src/plugins/{registry,store,projectors/index}.ts`。

## 1. 目标

交付后：插件清单可以声明 `config`（插件级配置字段）与 `instances`（纯实例能力声明）；
core 有唯一的能力类型注册表，实例与配置的 RPC / 存储 / secrets 通路全部就绪并有通用测试；
渲染端尚无任何新入口（本阶段无用户可见行为，P2/P3/P4 消费）。

## 2. 范围

| 包含 | 不包含（后续阶段） |
|---|---|
| `pluginFieldSchema` 泛化与 mcpb re-export、清单 `config` / `instances` 字段、`PLUGIN_UPGRADE_REQUIRED` | 任何 UI（卡片配置表单、实例管理 UI） |
| `CapabilityKindAdapter` 注册表（收编现有四投影器，纯重构独立提交） | mail kind 的实例化改造（P3） |
| `plugin_instances` 表 + `PluginInstanceService`（通用 CRUD + materializer 注册） | mail materializer（P3）、custom-mcp materializer（P4-M2） |
| `plugins.config.*` / `plugins.instances.*` RPC、`plugins` 表 `config_json` 列 | 注入模型（P2）、安装引导（P4） |
| inspect 输出 `configFields` / `capabilitySummary`、`PluginSummary` 扩展 | 市场条目 UI 消费（P4） |

## 3. 开工前核对

```bash
git status --short                    # 确认干净或与上期收尾改动无冲突
ls packages/core/migrations/main | tail -3   # 0056 未被占用则用 0056，否则顺延并登记
rg -n "^### DEV-" docs/dev/DEVIATIONS.md | tail -1
```

## 4. 步骤

### 步骤 1：shared 契约

1. `packages/shared/src/domain/plugins.ts`：新增 `pluginFieldSchema`（形状 = 现
   `mcpbUserConfigFieldSchema`：`key / type(string|number|boolean|directory|file) / title /
   description / required / sensitive / multiple / default? / min? / max?`，zod）；
   `mcpb.ts` 删除本地定义、改为 `export { pluginFieldSchema as mcpbUserConfigFieldSchema }`
   （MCPB 标准解析行为不变，`pnpm --filter @kepcup/shared test` 的 mcpb 用例必须原样全绿）。
2. `plugin-manifest.ts` 扩展（全部 strict、可选字段，`format_version` 保持 1）：
   - `config?: { fields: z.array(pluginFieldSchema).max(32) }`；
   - `instances?: z.array(z.enum(['mail','mcp'])).max(4)`；
   - 「至少一类贡献」superRefine 改为 `贡献总数 + instances.length ≥ 1`；
   - `config.fields` 与 `instances` 内部查重（fieldKey / kind 不重复）。
3. 错误码：`ERROR_CODES` 追加 `PLUGIN_UPGRADE_REQUIRED`；core 的 `manifest-loader` 捕获 zod
   unrecognized-key 类失败时映射该码（其余仍 `PLUGIN_INVALID`）；`chats.errorCode.*` 两语文案
   （键顺序一致）。
4. `plugins.ts` 契约扩展（README §4.1 表）：
   - `PluginSummary` 加 `configFields`（安全投影 schema：`key/title/type/required` + 可选
     `description/sensitive/multiple`，**不含** `default`）、`instanceCounts`、`providesInstances`；
   - inspect 输出加 `configFields` 与 `capabilitySummary`（core 推导：按贡献类型计数拼接的一句话，
     如「提供 1 个连接（Notion）与 2 个技能；可添加多个邮箱账号」；纯函数放 shared，`<untrusted>` 无关——
     它来自清单文案，须经 `sanitizeDisplayText` / `oneLine` 清洗）；
   - RPC schema：`plugins.config.get / set`、`plugins.instances.list / create / update / delete`
     （输入输出 zod；`values` = `Record<string, string|number|boolean|string[]>`；**登记两处**：
     `rpcMethodSchemas` 与 `APP_METHODS`）。
5. `pnpm --filter @kepcup/shared run build` + shared 定向测试绿。

### 步骤 2：能力类型注册表（纯重构，独立提交）

1. 新增 `packages/core/src/plugins/kinds.ts`：`CapabilityKindAdapter`（README §2.1 形状）+
   `CAPABILITY_KINDS`。四个现有投影器收编为适配器：`contributionSchema` 引 shared 对应 schema、
   `hasInstances` = `mail`（P3 起 materializer 才接入，本阶段注册表先只声明）/其余 `false`、
   `consentItems` = 现 inspect 的推导逻辑搬入。
2. `projectors/index.ts` 的固定顺序、`PLUGIN_PROJECTORS` barrel 与覆盖率测试改为**从注册表派生**
   （漏注册的 kind 在测试失败）；`PluginRegistry` 的账本 kind 校验、卸载反向顺序同源。
3. 行为零变化：`node scripts/run-tests.mjs run packages/core/test/unit/plugin-projector-skills.test.ts packages/core/test/unit/plugin-projector-update.test.ts packages/core/test/unit/plugins-manifest.test.ts packages/core/test/integration/plugins.test.ts` 全绿（以第一期实施记录中的等价测试文件清单为准，可加不可删）。

### 步骤 3：迁移与存储

1. `0056_plugin_instances.sql`（README §4.2 DDL 原样）：`plugin_instances` 表 + `plugins.config_json` 列。
2. `store.ts`（或新 `instances.ts` 的 store 部分）：`plugin_instances` 的 CRUD；
   `AppPaths` 无需新目录。
3. `PluginRegistry`：`config_json` 读写（互斥内）、`config` 值的 schema 校验
   （按清单 `config.fields` 校验 values；未知 fieldKey 拒绝；sensitive 字段写
   secrets `{{pluginId}}:config:{key}`，`config_json` 与日志/审计只存占位）、
   `instanceCounts` / `providesInstances` 汇总进 `list` 输出。

### 步骤 4：PluginInstanceService

1. `packages/core/src/plugins/instances.ts`：`registerMaterializer(kind, { create, update, remove })`
   + 通用流程：`create(pluginId, values)` → 校验插件 `installed && enabled` → kind 有 materializer？
   走之（返回领域 id）→ 写 `plugin_instances` 行 → 广播 `plugins.changed`；无 materializer 的 kind
   暂不可创建（`INVALID_INPUT`）。
2. `update` / `delete` 对称：delete 先 materializer 拆领域数据再删行；全部幂等、走
   `PluginRegistry` 同一把互斥锁（经注入引用，不另起锁）。
3. 卸载级联：`uninstall` / 更新替换路径在删插件行前，对其全部实例逐个 `delete`（复用上一步）；
   加失败注入测试（中途崩溃后 `recoverInterrupted` 不留实例孤儿）。

### 步骤 5：RPC 接线

1. `rpc/plugins-bindings.ts`：注册步骤 1 的 6 个方法；远程端点不限制（实例与配置无本地路径语义）。
2. 审计：`plugin_config_set` / `plugin_instance_create|update|delete`（detail 只含
   `{ pluginId, instanceId?, kind }`，**不含 values**）。

### 步骤 6：inspect / list 扩展与测试

1. inspect 输出补 `configFields` + `capabilitySummary`；本地安装 / 更新 / Bot 确认卡三条路径的
   同意面板数据自动带上（渲染端本阶段可以不渲染）。
2. 新增测试：清单 `config` / `instances` 校验（含「纯实例清单」合法用例）、unknown kind 字段 →
   `PLUGIN_UPGRADE_REQUIRED`、实例 CRUD + materializer 失败回滚、config 敏感值不落
   `config_json`、覆盖率测试从注册表派生。

## 5. 验收

- [ ] 一个手工构造的纯实例清单（`instances: ['mail']` + `config.fields`）能通过 manifest 校验并
      被 `plugins.inspect` 正确返回（本阶段 mail 无 materializer，create 返回 `INVALID_INPUT` 是预期）。
- [ ] 现有四类插件的安装 / 更新 / 卸载 / 启停行为与 P1 前完全一致（回归测试全绿，行为零变化提交可证）。
- [ ] `plugins.config.set` 后：非敏感值在 `config_json`、敏感值只在 secrets、审计无值。
- [ ] `PLUGIN_UPGRADE_REQUIRED`：含未知字段的清单给出升级提示错误码与两语文案。
- [ ] shared / core `typecheck` 通过；全量 `pnpm test` 一次，失败不超基线。

## 6. 实施记录

（执行后填写：做了什么（按提交）/ 偏差与 DEV 编号 / 迁移实际编号 / 自由度判断点 / 验收证据 / 遗留问题。）
