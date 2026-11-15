# P1 · shared 契约与数据迁移

> 状态：**已实施（2026-11-15）** · 依赖：无 · 分支：`feat/plugin-platform`（单集成分支，覆盖每阶段一分支约定）
> 必读：[README](README.md)（固定契约）→ [CURRENT-STATE](CURRENT-STATE.md) → [60 号设计 §2 / §3](../../docs/design/60-capability-model-plugins.md)

## 1 目标

落地 D124 的数据面：插件清单新增 `capabilityModels` 贡献与 `'capability-model'` 实例 kind、Bot 运行时新增 `capability_entries` 字段、`usage_ledger` 扩列迁移。本阶段纯契约，不接任何运行时行为。

## 2 范围

| 包含 | 不包含 |
|---|---|
| `plugin-manifest.ts`：`capabilityModelEntrySchema` + `contributions.capabilityModels` + `PLUGIN_INSTANCE_KINDS` 扩展 + superRefine 两条 | 安装管线对 `engine` 的注册表校验（P2） |
| `botRuntimeSchema.capability_entries` | Bot 绑定的 RPC 与 UI（P2/P3） |
| 迁移 0075：plugin_items / plugin_instances kind CHECK 扩展 + usage_ledger 两列 | usage 写入逻辑（P2） |
| shared 单测 | core/renderer 任何改动 |

## 3 开工前核对

```bash
git status && git log --oneline -3
ls packages/core/migrations/main | tail -3   # 确认 head；若已过 0075，迁移号顺延并回写 60 号文档与 README 固定契约
rg "DEV-" DEVIATIONS.md | tail -5            # 记最后一个 DEV 编号
pnpm --filter @kepcup/shared build           # 基线可构建
```

## 4 步骤

### 步骤 1：manifest 条目 schema

`packages/shared/src/domain/plugin-manifest.ts`：

1. 新增并导出 `capabilityModelEntrySchema`（strictObject），字段与约束按 [60 §2](../../docs/design/60-capability-model-plugins.md)：
   - `id`：复用既有贡献 id 规则（对齐 skills 贡献的 id schema，插件内唯一性交给 superRefine）；
   - `capability`：`z.enum(['image','video','tts','asr','embedding','rerank','multimodal'])`（独立枚举，不复用 `ModelCapability`——排除 `'chat'` 且不引入跨文件耦合）；
   - `model`：`z.string().min(1).max(200)`；`engine`：`z.string().min(1).max(64)`；
   - `displayName?`（≤100）、`description?`（≤500）、`params?`（`z.record(z.string(), z.unknown())`）、`instance?`（string）。
2. `pluginManifestSchema.contributions` 加 `capabilityModels: z.array(capabilityModelEntrySchema).max(32).optional()`。
3. `PLUGIN_INSTANCE_KINDS` 加 `'capability-model'`；`instances` 联合随之扩展。
4. superRefine 增两条：声明 `capabilityModels` 非空 ⇒ `instances` 必含 `'capability-model'`（错误信息给中文指引）；`capabilityModels` 条目 `id` 查重。
5. 头部注释的字段清单同步（该文件 :8-16 有格式约定）。

### 步骤 2：Bot 运行时字段

`packages/shared/src/domain/types.ts`（`botRuntimeSchema`，:63-125）：

```ts
capability_entries: z.array(strictObject({ plugin: z.string().min(1), entry: z.string().min(1) })).max(16).default([])
```

`.default([])` 保证旧 profile_json 读出即合法（零迁移）。导出 `capabilityEntryRefSchema` 供 core/renderer 复用。

### 步骤 3：迁移 0075

`packages/core/migrations/main/0075_capability_model_plugins.sql`（编号以开工前核对为准）：

1. `plugin_items` / `plugin_instances` 的 kind CHECK 重建，纳入 `'capability-model'`——**逐字模仿 0066 的重建写法**（建新表 → 拷贝 → 改名），不原地改约束。
2. `usage_ledger` 加列：`capability TEXT`、`model_entry_id TEXT`（均 nullable，无默认值，不动既有行）。
3. 相邻的迁移登记处（若有 schema 版本表/清单）按 0074 先例更新。

### 步骤 4：shared 单测

新增 `packages/shared/test/unit/plugin-manifest-capability-models.test.ts`：

- 合法最小清单（一条 image 条目 + `instances:['capability-model']`）通过；
- 声明条目但缺 instances kind → 拒；条目 id 重复 → 拒；未知能力值 → 拒；条目 >32 → 拒；`capability_entries` >16 → 拒；
- 旧格式清单（无新字段）解析结果 `capabilityModels` 缺省 / `capability_entries` 默认 `[]`（向后兼容证据）。

扩展 `packages/shared/test/unit/` 中 botRuntime 相关既有测试文件补 `capability_entries` 用例（若无独立文件则在 `plugin-manifest` 测试同处覆盖）。

### 步骤 5：构建与定向回归

```bash
pnpm --filter @kepcup/shared build
node scripts/run-tests.mjs run packages/shared/test/unit/plugin-manifest-capability-models.test.ts
node scripts/run-tests.mjs run packages/shared/test/unit   # shared 全目录定向一轮（改动面在 shared 公共契约）
```

> 本阶段改了 shared 契约（AGENTS.md 允许全量的情形），但按「先定向、收口一次全量」约定，全量放在 P4；此处跑 shared 目录定向即可。

## 5 验收

- [x] `capabilityModelEntrySchema` / `contributions.capabilityModels` / `'capability-model'` kind / `capability_entries` 字段落地，名字与 [README 固定契约](README.md#固定契约名字不得改动)一致。证据：`packages/shared/src/domain/plugin-manifest.ts`（schema + contributions + `PLUGIN_INSTANCE_KINDS` + superRefine 两条）、`packages/shared/src/domain/types.ts`（`capabilityEntryRefSchema` + `capability_entries`）；名字核对见 `plugin-manifest-capability-models.test.ts`。
- [x] 迁移落库可重放（新库 + 0066 既有库两条路径），`plugin_items` / `plugin_instances` 可写 kind `'capability-model'` 行。证据：0075 逐字沿用 0066 重建写法；`packages/core/test/unit/plugins-migration.test.ts` 7/7 过（新库全链）；/tmp 一次性重放脚本（一次性脚本，不入库）双路径 17 项全过——路径 B 模拟 0074 既有库（含 im 行与 `config_json`），补跑仅应用 0075、数据与 `plugin_items_ref` 索引保留、新 kind 两表均可写。
- [x] `usage_ledger` 新列存在且旧行读出 NULL。证据：重放脚本路径 A / B 各验一条旧行 `capability` / `model_entry_id` 读 NULL，写入后可读回。
- [x] shared 定向测试全绿，旧清单解析兼容。证据：`node scripts/run-tests.mjs run packages/shared/test/unit` → 52 文件 622 用例全过；新增 `plugin-manifest-capability-models.test.ts` 12 用例（含旧清单 `capabilityModels` 缺省、旧 profile `capability_entries` 默认 `[]`）。

## 6 实施记录

- 分支 / 提交：`feat/plugin-platform`（提交由主代理负责，本阶段未 commit）
- 实际迁移号：0075（`packages/core/migrations/main/0075_capability_model_plugins.sql`，head 核对时 0074 未被占用，未顺延）
- DEV 偏差：DEV-093（条目 `id` 复用 `pluginMcpIdSchema`——任务书「skills 贡献的 id schema」表述失准，skills 无 id 字段）；DEV-094（testkit 一行编译修复已落；core 6 处 / renderer 1 处 typecheck 中断为固定契约的必然后果，待 P2 / P3 清零，P2/P3 落地前全量 `pnpm test` 的 typecheck 段不会绿）
