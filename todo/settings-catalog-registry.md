# 设置注册中心（Settings Catalog Contributions）实施文档

> 写于 2026-10-21。状态：**已实施（同日，任务 0～6 + 8；任务 7 按设计留作后续）**，
> 实施记录见 §12。
>
> 关联文档：
> - 设计篇：[docs/design/38-conversational-settings.md](../docs/design/38-conversational-settings.md)（D89）
> - 原始方案：[todo/conversational-app-setup.md](conversational-app-setup.md)
> - 现有目录：`packages/shared/src/settings-catalog/`
> - 现有适配器：`packages/core/src/settings/adapters.ts`
> - 现有卡片宿主：`apps/desktop/src/renderer/src/lib/features/settings-card/`

## 1. 结论

“注册中心”方向可行，而且现有代码已经实现了核心部分：`SETTING_ITEMS` 是设置项的单一事实来源，`settings_search` / `settings_read` / `settings_change` 已经由它驱动，卡片宿主也按 `CardKey` 分发。**不需要另起一套注册中心**。

真正要解决的是三个问题：

1. **注册点分散**：新增一个设置项仍要改 5～7 个文件，做不到“只在一个功能模块登记一次”。
2. **缺适配器会静默误报**：`adapters.ts` 对未登记条目回 `configured`，Bot 会以为能力已配好。
3. **简单设置也要写自定义 UI/适配器**：没有充分利用目录里的 `fields` 元数据。

本方案把现有目录升级为“**分层贡献协议**”：

- `shared`：设置项元数据（唯一的 id 与契约）。
- `core`：按条目注册的适配器贡献（也可用通用标量适配器）。
- `desktop`：按卡片键注册的 UI 贡献（后续可统一 props、动态分发）。
- `tests`：强制“目录条目 → 适配器 → 卡片 → 设置页锚点”闭合，漏注册直接失败。

目标不是“完全无感”，而是：

> **新增简单设置只改一个文件；新增复杂设置只改一个功能目录；漏掉任何一层，CI 失败。**

## 2. 现状审计

### 2.1 当前数据流

```text
用户 / Bot
   │
   ├─ settings_search / settings_read / settings_change      （core，通用三个工具）
   │        │
   │        └─ SETTING_ITEMS                                （shared，目录）
   │                 │
   │                 ├─ buildItemAdapters(deps)              （core，按 id 取适配器）
   │                 │        └─ settings / bots / services / secrets
   │                 │
   │                 └─ setting_card                        （system_event）
   │                          └─ SettingCard
   │                               └─ SettingCardEmbed      （desktop，按 CardKey 分发）
   │                                        └─ 设置页组件（embedded）
   │
   └─ 设置页 / 右栏 / 对话框（手写表单，整表保存或条目级保存）
```

### 2.2 现有注册点

| 层 | 文件 | 作用 | 新增设置时是否要改 |
| --- | --- | --- | --- |
| 契约 | `packages/shared/src/settings-catalog/types.ts` | `SettingItem`、`CARD_KEYS`、字段/档位/深链 schema | 新卡片键时要改 |
| 元数据 | `packages/shared/src/settings-catalog/items.ts` | `SETTING_ITEMS`、`DIRECT_ITEM_IDS`、`CAPABILITY_SETTING_IDS` | 必改 |
| 查询/裁定 | `settings-catalog/query.ts`、`mode.ts` | 搜索、概览、档位裁定 | 通常不用改 |
| 适配器 | `packages/core/src/settings/adapters.ts` | 按 id 的读/写/选项/校验 | core 条目必改 |
| 工具宿主 | `packages/core/src/settings/host.ts` | 写锁、CAS、出卡、撤销、唤醒 | 通常不用改 |
| 卡片映射 | `apps/desktop/.../settings-card/card-components.ts` | `CardKey → 组件名`、`cardEmbeddable` | 新卡片键时要改 |
| 卡片分发 | `apps/desktop/.../settings-card/SettingCardEmbed.svelte` | import、if/else、各组件 props | 新卡片键时要改 |
| 设置页 | `apps/desktop/.../features/settings/*`、`SettingsSectionView.svelte` | 真实表单与 `data-settings-anchor` | 有 UI 入口时要改 |
| 测试 | `packages/shared/test/unit/settings-catalog.test.ts`、`settings-ui-scan.ts`、`card-components.test.ts` | 覆盖率、映射、白名单 | 通常不用改 |

当前代码规模（以 `items.ts` / `types.ts` 为准，2026-10-21 复核）：

- 60 条目录条目（含并行加入的 `general.task-loop`）；
- 49 条有内嵌卡（`card !== null`）；
- 28 个 `CardKey`；
- `adapters.ts` 约 2140 行，`items.ts` 约 1020 行。

### 2.3 缺口

#### G1：没有“按功能聚合”的贡献单元

一个功能（例如“邮件”）的设置元数据在 `shared`，适配器在 `core` 的大文件里，卡片在 `desktop` 的另一个大文件里。三处靠字符串 id 对齐，没有类型或测试强制“三件套齐全”。

#### G2：缺适配器静默回 `configured`

`packages/core/src/settings/adapters.ts`（`buildItemAdapters` 末尾，约 2133 行）：

```ts
const fallback: ItemAdapter = { read: () => snapshot('configured', null, '详情以设置页为准') };
```

新条目忘写适配器时：

- `settings_read` 会说“已配置”，Bot 可能据此判断能力可用；
- 真正写入时才报 `INVALID_INPUT`；
- 测试不会失败。

这是当前对“新增功能自动覆盖”的最大隐患。

#### G3：卡片分发是 if/else 长链

`SettingCardEmbed.svelte` 有 28 个 `{:else if item.card === '...'}` 分支，每个分支的 props 不同。新增卡片必须同时改：

1. `CARD_KEYS`
2. `card-components.ts`
3. `SettingCardEmbed.svelte` 的 import + 分支

`card-components.test.ts` 会核对 import 和分支，所以不会漏，但样板多。

#### G4：`FieldEditorCard` 是“伪通用”

`FieldEditorCard.svelte` 目前按 `item.id` 硬编码：

```ts
switch (item.id) {
  case 'models.widget-review': ...
  case 'models.concurrency': ...
  case 'agents.default': ...
  case 'general.launch-at-login': ...
}
```

它没有真正按 `item.fields` 的 `type` / `options` 渲染，所以简单设置不能只靠目录落地。

#### G5：设置页不是目录驱动

设置页仍是手写表单，设计篇 §11.2 已明确**不做“页 = 卡”的全面改造**。因此新增设置仍要手动加组件和 `data-settings-anchor`。这是合理边界，但可以给“新简单设置”提供一条低成本通道。

#### G6：覆盖率只覆盖“已有 UI → 目录”

`settingsCoverageProblems` 能保证：

- 设置页已有分区 / 锚点 → 有目录条目或排除理由；
- 目录条目的深链 → 锚点真实存在；
- 有 `card` 的条目 → 组件映射存在。

它不能保证：

- 新功能 → 必须有设置条目；
- 目录条目 → 必须有 core 适配器。

#### G7：文档数字与代码漂移

设计篇 / 旧 todo 里写“58 条、46 条有卡、26 个卡片键”，当前代码是约 52 / 42 / 28。实施时以代码和测试为准，收口时同步修正文档。

## 3. 目标架构

### 3.1 分层

```text
shared:  SettingItem（唯一 id、fields、write、card、deepLink、store）
   │
   ├─ core:     SettingAdapterContribution  ── itemId → ItemAdapter
   │
   └─ desktop:  SettingCardContribution     ── cardKey → 组件 + embeddable
                          │
                          └─ 设置页 / 设置卡 / 失败续跑卡
```

原则：

1. **一个 id 贯穿三层**。`item.id` 是唯一键；适配器和卡片都用它对齐。
2. **shared 不依赖 core/desktop**。贡献表分层，不做跨包全局单例。
3. **显式注册优先于自动发现**。自动发现（`import.meta.glob`）可以作为后续优化，但安全相关的 `direct`、敏感字段、白名单必须显式。
4. **测试是闭合手段**。没有测试的“自动注册”只是把漏注册藏得更深。

### 3.2 “无感”的现实定义

| 场景 | 目标成本 |
| --- | --- |
| 新增一个全局标量设置（开关 / 文本 / 数字 / 静态下拉） | 只改 `items.ts` 一条；需要 UI 入口时在设置页加一行 `SettingsCatalogFields` |
| 新增一个需要自定义读写的设置 | `items.ts` 一条 + `core/settings/contributions/<feature>.ts` 一个文件 + 一个 barrel 行 |
| 新增一个需要自定义卡片的设置 | 再加 `desktop/.../settings-card/cards/<feature>.ts` 一个文件 + 一个 barrel 行 |
| 漏写适配器 / 卡片 / 锚点 | 定向测试失败，不允许合并 |

## 4. 详细设计

### 4.1 shared：目录与覆盖检查

#### 4.1.1 抽出 `define.ts`

把 `items.ts` 里的私有 helper 抽到 `packages/shared/src/settings-catalog/define.ts` 并导出：

```ts
export type SettingItemInput = Omit<
  SettingItem,
  'owner' | 'readOnly' | 'enables' | 'keywords' | 'fields'
> &
  Partial<Pick<SettingItem, 'owner' | 'readOnly' | 'enables' | 'keywords' | 'fields'>>;

export function defineSettingItem(input: SettingItemInput): SettingItem;
export function defineSettingField(
  name: string,
  label: string,
  type: SettingFieldType,
  extra?: Partial<Omit<SettingFieldSpec, 'name' | 'label' | 'type'>>,
): SettingFieldSpec;
export function defineSettingWrite(
  maxMode: SettingWriteMode,
  extra?: Partial<Omit<SettingWriteSpec, 'maxMode'>>,
): SettingWriteSpec;
export function defineViaTool(
  tool: string,
  maxMode: SettingWriteMode,
  widensPermission?: boolean,
): SettingWriteSpec;
```

`items.ts` 改为从 `define.ts` 导入。现有导出保持不变，避免影响 core/desktop。

#### 4.1.2 给字段加 `path`

`SettingFieldSpec` 增加可选 `path`，用于“目录字段 → settings 点路径”的通用映射：

```ts
export const settingFieldSpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  label: z.string().min(1),
  type: settingFieldTypeSchema,
  sensitive: z.boolean(),
  options: settingOptionSourceSchema.optional(),
  staticOptions: z.array(settingOptionSchema).optional(),
  multiple: z.boolean().optional(),
  hint: z.string().optional(),
  /** store.kind = 'settings' 时，这个字段在 settings 上的点路径；缺省 = name。 */
  path: z.string().min(1).optional(),
});
```

示例：

```ts
defineSettingItem({
  id: 'general.workbench',
  group: 'general',
  title: '工作台',
  summary: '在侧栏显示工作台入口，统筹事项与备忘',
  keywords: ['工作台', '事项', '备忘', '待办'],
  scope: 'global',
  fields: [
    defineSettingField('enabled', '显示工作台', 'toggle', { path: 'workbenchEnabled' }),
  ],
  write: defineSettingWrite('confirm'),
  card: 'field-editor',
  deepLink: { surface: 'settings', section: 'general', anchor: 'general-workbench' },
  store: { kind: 'settings', paths: ['workbenchEnabled'], generic: true },
});
```

#### 4.1.3 给 store 加 `generic`

`settingStoreSchema` 的 `settings` 分支增加：

```ts
z.object({
  kind: z.literal('settings'),
  paths: z.array(z.string().min(1)).min(1),
  /** 允许 core 用通用标量适配器读写；只对单层标量字段生效。 */
  generic: z.boolean().optional(),
}),
```

`generic: true` 是显式选择，不靠猜测。复杂对象（`backgroundTasks`、`capabilityModels`）继续用自定义适配器。

#### 4.1.4 新增适配器覆盖检查

在 `packages/shared/src/settings-catalog/coverage.ts` 增加纯函数：

```ts
export interface SettingsAdapterCoverageInput {
  items?: readonly SettingItem[];
  /** core 贡献表里登记的全部 itemId。 */
  adapterIds: Iterable<string>;
  /**
   * 明确接受“没有适配器”的条目及理由（例如 profile.user-facts 没有安全信号）。
   * 有理由才能进入这个表，不能靠静默 fallback。
   */
  explicitFallback?: Readonly<Record<string, string>>;
}

export function settingsAdapterCoverageProblems(
  input: SettingsAdapterCoverageInput,
): string[];
```

规则：

1. `owner === 'core'`、`write.via === 'catalog'`、`readOnly !== true`、且**没有**走通用标量
   适配器（`store.kind === 'settings' && store.generic === true`）的条目，必须在 `adapterIds`
   或 `explicitFallback` 里；
2. `adapterIds` 里的每个 id 必须对应真实目录条目（防过期）；via-tool 条目也可以有读适配器
   （如 `skills.install` 的计数读法），同样受这条约束；
3. `explicitFallback` 的每个 key 必须是真实条目，且确实需要 fallback（既没有适配器、又不
   属于被豁免的类别），防遗留。

测试放在 `packages/core/test/unit/settings-adapters-coverage.test.ts`（core 能同时 import shared 和贡献表）。

#### 4.1.5 条目 id 类型

增加：

```ts
export const SETTING_ITEM_IDS = SETTING_ITEMS.map((item) => item.id);
export type SettingItemId = (typeof SETTING_ITEM_IDS)[number];
```

注意：`SETTING_ITEMS` 是 `readonly SettingItem[]`，推导出来是 `string`，不是字面量联合。若需要字面量联合，保持 `items.ts` 末尾用 `as const` 或单独维护联合类型。**第一阶段不强制**，避免为了类型体操改大量代码；贡献表用 `string` 也可。

### 4.2 core：按条目注册适配器

#### 4.2.1 目录结构

```text
packages/core/src/settings/
  adapters.ts                 # 保留 buildItemAdapters 出口与公共 helper
  contributions/
    types.ts                  # SettingAdapterContribution
    index.ts                  # SETTING_ADAPTER_CONTRIBUTIONS
    models.ts
    search.ts
    connections.ts
    bot.ts
    project.ts
    workdir.ts
    general.ts
    background.ts
    environment.ts
    developer.ts
    capability.ts
```

第一阶段可以只抽 3～4 个高频组（models / bot / general / environment），其余仍留在 `adapters.ts`，用“兼容贡献”包住。**不要求一次拆完。**

#### 4.2.2 贡献接口

一个贡献单元是一个功能组：`adapters` 直接按条目 id 列工厂（一个组里可以有多个不同的适配器，
这是「一个 `create` 返回单个适配器」表达不了的；同一适配器服务多个条目时重复列同一工厂即可）。

```ts
// packages/core/src/settings/contributions/types.ts
import type { AdapterDeps, ItemAdapter } from '../adapters.js';

export interface SettingAdapterContribution {
  /** 贡献单元名，日志/测试用。 */
  name: string;
  /** 目录条目 id → 适配器工厂；键集合就是本贡献负责的条目（覆盖测试用）。 */
  adapters: Readonly<Record<string, (deps: AdapterDeps) => ItemAdapter>>;
}
```

`index.ts`：

```ts
export const SETTING_ADAPTER_CONTRIBUTIONS: readonly SettingAdapterContribution[] = [
  capabilityContribution,
  modelsContribution,
  botContribution,
  generalContribution,
  environmentContribution,
  // ... 其余
];
```

> 实施备注：`buildItemAdapters` 搬到 `contributions/index.ts`（`adapters.ts` 只留类型、共享
> helper 与适配器实现并被贡献文件 import），避免 `adapters.ts ↔ contributions/` 互相 import
> 成环。`host.ts` 与两个单测的 import 路径随之更新；函数签名不变。

#### 4.2.3 `buildItemAdapters` 改造

保持函数签名不变：

```ts
export function buildItemAdapters(deps: AdapterDeps): (item: SettingItem) => ItemAdapter
```

内部改为：

1. 先装配贡献表：

```ts
const byId = new Map<string, ItemAdapter>();
for (const contribution of SETTING_ADAPTER_CONTRIBUTIONS) {
  for (const [id, factory] of Object.entries(contribution.adapters)) {
    if (byId.has(id)) throw new Error(`重复的设置适配器：${id}`);
    byId.set(id, factory(deps));
  }
}
```

2. 保留特殊规则。**顺序与现状一致，别调整**——`capability.*` 从 `startsWith` 前缀匹配改为
   贡献表显式登记后，`byId` 查表必须仍在 `viaTool` 之前（`skills.install`、`schedules.*`、
   `bot.identity` 等 via-tool 条目在表里有自己的读适配器，先查 viaTool 会把它们遮蔽成
   「由某工具管理」）：

```ts
if (item.readOnly) return READONLY_ITEM_ADAPTER;
if (item.owner === 'renderer') return RENDERER_ADAPTER;
const adapter = byId.get(item.id);
if (adapter !== undefined) return adapter;
if (item.write.via !== 'catalog') return viaToolAdapter(item.write.via.tool);
if (item.store.kind === 'settings' && item.store.generic === true) {
  return genericSettingsAdapter(deps, item);
}
return UNREGISTERED_ITEM_ADAPTER;
```

3. 删除 `fallback = configured`。改为：

```ts
const UNREGISTERED_ITEM_ADAPTER: ItemAdapter = {
  read: () => snapshot('unknown', null, '未接入设置目录适配器'),
};
```

这样：

- 新增条目忘写适配器 → Bot 看到 `unknown`，不会误判为已配置；
- core 覆盖测试失败，强迫补适配器或在 `explicitFallback` 写明理由。

4. `profile.user-facts` 这类“确实没有安全信号”的条目，显式登记：

```ts
const EXPLICIT_ADAPTER_FALLBACK: Readonly<Record<string, string>> = {
  'profile.user-facts': '没有不含画像原文的安全信号，读状态以设置页为准',
};
```

测试用 `settingsAdapterCoverageProblems` 校验。

#### 4.2.4 通用标量适配器

新增 `packages/core/src/settings/generic-adapter.ts`：

```ts
/** 只支持单层标量：boolean / string / number / static enum。 */
export function genericSettingsAdapter(deps: AdapterDeps, item: SettingItem): ItemAdapter;
```

行为：

- `read`：按 `field.path ?? field.name` 从 `deps.settings.get()` 取顶层值，生成 `values`；
  - 布尔：`configured`，摘要「已开启 / 已关闭」；
  - 字符串 / 数字：空值 `unconfigured`，否则 `configured`；
  - 静态下拉：值在 `staticOptions` 里为 `configured`，否则 `partial`。
- `normalize`：按字段类型做形状校验，静态选项必须命中；
- `write`：只把本次提交的字段写回，`deps.settings.update({ [path]: value })`；
- 不处理敏感字段（`generic` 条目的字段不允许 `sensitive`，测试强制）；
- 不处理 `wideningMode`（放宽类设置必须自定义）；
- 不处理写后副作用（如 `platform.autostart`），有副作用就自定义。

适用示例：

- `general.workbench`（`workbenchEnabled`）；
- 以后新增的简单开关 / 文本 / 静态下拉。

不适用：

- `general.launch-at-login`（需要 `publish('platform.autostart')`）；
- `background.tasks`（嵌套对象 + 智能体校验）；
- `models.*`（需要厂商/模型校验与动态选项）。

### 4.3 desktop：按卡片键注册 UI

#### 4.3.1 目录结构

```text
apps/desktop/src/renderer/src/lib/features/settings-card/
  cards/
    types.ts
    index.ts
    default-models.ts
    provider-setup.ts
    capability-model.ts
    ...
  card-components.ts          # 兼容出口：从 contributions 派生
  SettingCardEmbed.svelte
  FieldEditorCard.svelte
```

#### 4.3.2 贡献接口（第一阶段）

第一阶段只登记元数据：**不 import 组件本身**。组件的 import 与分发仍留在
`SettingCardEmbed.svelte`（阶段 A），否则同一个组件会被两处引入。`componentName` 供
`card-components.test.ts` 核对 `SettingCardEmbed` 的 import / 分支。

```ts
// cards/types.ts
import type { CardKey, SettingItem } from '@kepcup/shared';

/** 内嵌时需要的上下文（谁的卡、作用对象、可用的外部智能体）。 */
export interface EmbedContext {
  botId: string | null;
  conversationId: string | null;
  workdirId: string | null;
  prefill: SettingValues | null;
  agent(id: string): AgentView | null;
  defaultAgentId: string | null;
}

export interface SettingCardContribution {
  key: CardKey;
  /** 组件名，供 card-components.test.ts 核对 SettingCardEmbed 的 import/分支。 */
  componentName: string;
  /** 当前上下文能否内嵌；不能则退回跳转卡。 */
  embeddable(item: SettingItem, ctx: EmbedContext): boolean;
}
```

示例：

```ts
// cards/web-search.ts（或按组归入 cards/<feature>.ts）
export const webSearchCard: SettingCardContribution = {
  key: 'web-search',
  componentName: 'WebSearchSection',
  embeddable: () => true,
};
```

`index.ts`：

```ts
export const SETTING_CARD_CONTRIBUTIONS: readonly SettingCardContribution[] = [
  defaultModelsCard,
  providerSetupCard,
  capabilityModelCard,
  // ...
];
```

> 阶段 A 的登记条目很短（三行），可以按功能组归并进少量文件（`cards/models.ts`、
> `cards/bot.ts`……），不必每个键一个文件；新增卡片只在自己的组文件加一条 + barrel。

`SELF_APPLYING_CARD_KEYS` / `COMPONENT_SAVE_CARD_KEYS` 先保留 `setting-card-model.ts` 里的
显式集合（阶段 B 统一 props 时再考虑由贡献表派生）。

#### 4.3.3 `card-components.ts` 变为派生层

```ts
export const SETTING_CARD_COMPONENTS = Object.fromEntries(
  SETTING_CARD_CONTRIBUTIONS.map((card) => [card.key, card.componentName]),
) as Record<CardKey, string>;

const BY_KEY = new Map(SETTING_CARD_CONTRIBUTIONS.map((card) => [card.key, card]));

export function cardEmbeddable(item: SettingItem, ctx: EmbedContext): boolean {
  if (item.card === null) return false;
  return BY_KEY.get(item.card)?.embeddable(item, ctx) ?? false;
}
```

`SETTING_CARD_COMPONENTS` 和 `cardEmbeddable` 的导出保持不变，现有 import 不用改。

`SELF_APPLYING_CARD_KEYS` / `COMPONENT_SAVE_CARD_KEYS` 可以由贡献表派生，也可以先保留 `setting-card-model.ts` 里的显式集合（推荐先保留，避免一次改太多）。

#### 4.3.4 `SettingCardEmbed` 的两个阶段

**阶段 A（低风险）**：保留现有 if/else，只把 import 和分支的核对交给测试；`card-components.ts` 改为派生。新增卡片仍然要改 `SettingCardEmbed` 一次。

**阶段 B（可选，后续）**：统一 props：

```ts
export interface SettingCardProps {
  item: SettingItem;
  ctx: EmbedContext;
  prefill: SettingValues | null;
  expected: SettingValues | null;
  messageId?: string;
  onSaved: () => void;
  onConflict?: (current: SettingValues | null) => void;
}
```

每个卡片提供一个 bridge 组件（例如 `CapabilityModelCard.svelte`），把标准 props 映射到现有设置页组件。宿主改为：

```svelte
{#each [contribution] as card (card.key)}
  {@const Card = card.component}
  <Card {item} {ctx} {prefill} {expected} {messageId} {onSaved} {onConflict} />
{/each}
```

这样新增卡片只需：

1. `CARD_KEYS` 加键；
2. `cards/<feature>.ts` 一个文件；
3. `cards/index.ts` 一行。

**不要**在阶段 A 就删除 if/else，否则会牵动 28 个组件的 props，回归面太大。

#### 4.3.5 通用 `FieldEditorCard`

把 `FieldEditorCard.svelte` 从“按 item.id 硬编码”改为“按 `item.fields` 渲染”。

第一阶段支持：

| 字段类型 | 控件 | 说明 |
| --- | --- | --- |
| `toggle` | Checkbox | `values[field.name] = boolean` |
| `text` | input | 单行文本 |
| `number` | input[type=number] | 有限数 |
| `select` + `options: 'static'` | select | 用 `staticOptions` |
| `select` + `options: 'agents'` | select | 用 `agentsStore` |
| `select` + `options: 'providers'` | select | 用 `settingsStore.providers` |
| `model` | `ModelSelectField` | 用 `settingsStore.availableModelOptions` |

暂不支持（继续用专用卡）：

- `secret` / `oauth` / `account`；
- 多选、复杂动态选项、需要副作用确认的字段；
- `wideningMode` / user-only 的安全开关。

种子值（`path` 支持点路径，如 `taskLoop.idleWarnAfter`，不限于顶层）：

```ts
function seed(item: SettingItem, prefill: SettingValues | null): SettingValues {
  if (prefill !== null) return { ...prefill };
  const settings = settingsStore.settings;
  const out: SettingValues = {};
  for (const field of item.fields) {
    if (field.sensitive) continue;
    const path = field.path ?? field.name;
    const value = readAtPath(settings, path);
    if (value !== undefined) out[field.name] = value;
  }
  return out;
}
```

保存仍然走 `applySettingItem({ itemId, values, expected, messageId })`，不引入第二条写路径。

> 实施备注：`models.concurrency`（provider 选择联动 limit + 「默认」伪选项）、
> `general.launch-at-login`（i18n 标签与 OS 级提示）、`models.widget-review`（i18n 提示）、
> `agents.default`（「无」空选项）四个既有条目保留专用分支；通用渲染作为默认路径，
> 新条目（`general.workbench`、`general.task-loop` 这类）零改动出卡。

#### 4.3.6 设置页的“目录字段组”

新增一个轻量组件：

```svelte
<!-- apps/desktop/src/renderer/src/lib/features/settings/SettingsCatalogFields.svelte -->
<script lang="ts">
  import { getSettingItem } from '@kepcup/shared';
  import { settingItemText } from '$lib/i18n';
  import FieldEditorCard from '$lib/features/settings-card/FieldEditorCard.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';

  let { itemIds, title }: { itemIds: readonly string[]; title?: string } = $props();
  const items = $derived(
    itemIds
      .map((id) => getSettingItem(id))
      .filter(
        (item) =>
          item !== null &&
          item.owner === 'core' &&
          item.scope === 'global' &&
          item.card === 'field-editor',
      ),
  );
</script>

{#if items.length > 0}
  <section class="grid gap-3">
    {#if title}<h3>{title}</h3>{/if}
    {#each items as item (item.id)}
      <div class="grid gap-1">
        <span class="text-sm font-medium">{settingItemText(item.id, 'title', item.title)}</span>
        <FieldEditorCard {item} onSaved={() => void settingsStore.refresh()} />
      </div>
    {/each}
  </section>
{/if}
```

**锚点由设置页静态写**（`data-settings-anchor="..."` 的值必须是字符串字面量）——覆盖率扫描
只认字面量与模板串前缀，组件里 `{item.deepLink.anchor}` 表达式绑定扫不到，放组件里会让
覆盖率测试报「锚点不存在」。组件本身不渲染锚点。

用途：

- **只给新增的简单设置用**；
- 设置页原有分区继续使用整表保存，不迁移；
- 新增全局标量设置时，在目标分区加一行：

```svelte
<div data-settings-anchor="general-foo">
  <SettingsCatalogFields itemIds={['general.foo']} />
</div>
```

这是“UI 端只引入卡片”的最低成本路径。复杂设置仍按现有方式写专用组件。

注意：

- `SettingsCatalogFields` 使用条目级保存（`settings.items.apply`），与所在页面的整表保存是两种模型。不要把同一个字段同时放进整表表单和这个组件，避免两个保存路径互相覆盖。
- 该组件第一阶段只支持 `owner === 'core'`、`scope === 'global'`、`card === 'field-editor'` 的条目；其他条目直接不渲染，由专用卡负责。
- `data-settings-anchor` 必须真实存在（由设置页静态写），覆盖率测试会扫描。

### 4.4 Bot 侧

**不需要新机制。** 现有三个工具已经由目录驱动：

- `settings_search` 读 `title` / `summary` / `enables` / `keywords`；
- `settings_read` 读字段、当前值、选项、档位；
- `settings_change` 按 `effectiveMode` 出卡 / 直改 / 重定向。

新增条目只要元数据写清楚，Bot 就能自动发现。需要保证：

1. `title` / `summary` / `enables` / `keywords` 用用户会说的词，不要只写内部术语；
2. `fields` 的 `label` / `type` / `options` 准确，否则通用卡和 `settings_read` 都会误导；
3. `store` / `write` / `owner` 正确，否则档位裁定会错；
4. `deepLink` 指向真实锚点。

提示词（`packages/core/src/settings/prompt.ts` 的 `SETTINGS_RULE`）不需要为新条目修改。

### 4.5 安全不变量

注册中心不能削弱现有安全模型：

1. **`direct` 永远人工白名单**：新条目默认 `maxMode` 不得为 `direct`；只有加入 `DIRECT_ITEM_IDS` 才可能 direct，测试双向校验。
2. **敏感字段永不经模型**：`secret` / `oauth` / `account` 只能由用户在卡片里填；`settings_change.values` 出现即拒绝；`settings_read` 只回已配置 / 未配置。
3. **放宽权限必须 user-only**：`wideningMode` / `widensPermission` 保持现有裁定，不因注册方式改变。
4. **渲染层条目仍由渲染层写**：`owner: 'renderer'` 不改。
5. **不允许“注册即执行”**：贡献表只描述读写与 UI，不包含自动执行、自动批准或绕过审批的逻辑。
6. **显式 fallback 必须写理由**：没有适配器的条目只能在 `EXPLICIT_ADAPTER_FALLBACK` 里登记，并说明为什么不安全/不需要读。

## 5. 实施任务

> 一次一个任务，单独提交。每个任务结束跑定向测试；不要求每个任务都跑全量。

### 任务 0：基线记录

**做什么。**

- 记录当前相关测试的定向结果：
  - `node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts`
  - `node scripts/run-tests.mjs run packages/shared/test/unit/settings-mode.test.ts`
  - `node scripts/run-tests.mjs run packages/core/test/unit/settings-item-writes.test.ts`
  - `node scripts/run-tests.mjs run packages/core/test/integration/settings-cards.test.ts`
  - `node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`
- 把结果写进本文件的“实施记录”小节（实施时新增）。

**完成标准。** 知道哪些失败是既有基线，避免后面误判。

### 任务 1：shared 覆盖检查与 `define.ts`

**改哪些文件。**

- 新增 `packages/shared/src/settings-catalog/define.ts`
- 改 `packages/shared/src/settings-catalog/items.ts`（改为 import helper）
- 改 `packages/shared/src/settings-catalog/types.ts`（`path`、`store.generic`）
- 改 `packages/shared/src/settings-catalog/coverage.ts`（`settingsAdapterCoverageProblems`）
- 改 `packages/shared/src/settings-catalog/index.ts`（导出新符号）
- 新增 / 改 `packages/shared/test/unit/settings-catalog.test.ts`

**步骤。**

1. 抽出 `defineSettingItem` / `defineSettingField` / `defineSettingWrite` / `defineViaTool`，保持 `SETTING_ITEMS` 输出完全不变。
2. 加 `path` 和 `generic` 字段，先不改任何现有条目（现有条目保持原样也能通过）。
3. 实现 `settingsAdapterCoverageProblems` 纯函数。
4. 单测覆盖：
   - 缺适配器 → 报问题；
   - 多出适配器 → 报问题；
   - 显式 fallback 有理由 → 通过；
   - fallback 指向不存在条目 → 报问题。

**完成标准。**

- `pnpm --filter @kepcup/shared typecheck` 通过；
- `settings-catalog.test.ts` 全绿；
- 现有 core/desktop 代码无需改动。

**不要做。** 不要在这一步拆 `items.ts` 成多文件；不要改任何现有条目的行为。

### 任务 2：core 贡献表

**改哪些文件。**

- 新增 `packages/core/src/settings/contributions/types.ts`
- 新增 `packages/core/src/settings/contributions/index.ts`
- 新增 `packages/core/src/settings/contributions/{models,search,bot,general,environment,...}.ts`
- 改 `packages/core/src/settings/adapters.ts`（`buildItemAdapters` 从贡献表装配）
- 新增 `packages/core/test/unit/settings-adapters-coverage.test.ts`

**步骤。**

1. 先只迁移 3～4 组低风险条目（建议 `models`、`general`、`environment`、`bot`），其余保留在 `adapters.ts` 内，通过一个 `legacyContribution` 包住。
2. `buildItemAdapters` 改为“贡献表 → Map”；保留 `readOnly` / `renderer` / `viaTool` 的短路顺序。
3. 删除 `fallback = configured`，改为 `UNREGISTERED_ITEM_ADAPTER`（`unknown`）。
4. 加 `EXPLICIT_ADAPTER_FALLBACK`，至少包含 `profile.user-facts` 与现有确实没有适配器的条目。
5. 覆盖测试调用 `settingsAdapterCoverageProblems`，`adapterIds` 来自 `SETTING_ADAPTER_CONTRIBUTIONS`。

**完成标准。**

- 现有 `settings-item-writes.test.ts`、`settings-adapters-project.test.ts`、`settings-catalog-host.test.ts` 全绿；
- 覆盖测试通过；
- 新条目如果忘写适配器，测试失败且 `settings_read` 不再误报 `configured`。

**不要做。** 不要一次把 2060 行全部拆完；不要改适配器内部读写语义。

### 任务 3：通用标量适配器

**改哪些文件。**

- 新增 `packages/core/src/settings/generic-adapter.ts`
- 改 `packages/core/src/settings/adapters.ts`（`store.generic` 分支）
- 改 `packages/shared/src/settings-catalog/items.ts`（只迁移 1～2 个简单条目做验证，建议 `general.workbench`）
- 新增 `packages/core/test/unit/settings-generic-adapter.test.ts`

**步骤。**

1. 实现 `genericSettingsAdapter(deps, item)`：
   - 顶层标量路径；
   - `read` / `normalize` / `write`；
   - 不支持敏感、user-only、widening、副作用。
2. 在 `buildItemAdapters` 中，`store.kind === 'settings' && store.generic === true` 时使用它。
3. 迁移 `general.workbench` 验证；保留 `general.launch-at-login` 的自定义适配器（有 `platform.autostart` 副作用）。
4. 单测：
   - 读已配置 / 未配置；
   - 写只改本字段；
   - 静态选项校验；
   - 敏感字段条目不得使用 `generic`（测试失败）。

**完成标准。**

- `general.workbench` 的 Bot 读 / 写 / 卡片行为不变；
- 新增同类设置只改 `items.ts`。

**不要做。** 不要给 `generic` 加“自动推断为 direct”；不要用它处理嵌套对象。

### 任务 4：desktop 卡片贡献表

**改哪些文件。**

- 新增 `apps/desktop/src/renderer/src/lib/features/settings-card/cards/types.ts`
- 新增 `cards/index.ts`
- 新增 `cards/<key>.ts`（每个现有 `CardKey` 一个，第一阶段只登记元数据）
- 改 `card-components.ts`（从贡献表派生 `SETTING_CARD_COMPONENTS` / `cardEmbeddable`）
- 改 `card-components.test.ts`

**步骤。**

1. 把 `card-components.ts` 里的键、组件名、`cardEmbeddable` 分支迁移到 `cards/*.ts`。
2. `card-components.ts` 只保留派生逻辑和兼容导出。
3. `SettingCardEmbed.svelte` **先不动**，继续显式 if/else；测试仍核对 import 与分支。
4. 加测试：
   - `SETTING_CARD_CONTRIBUTIONS` 的 key 集合与 `CARD_KEYS` 一致；
   - 每个条目的 `card` 都有贡献；
   - 贡献里的 `componentName` 被 `SettingCardEmbed` 引入并有分支。

**完成标准。**

- `card-components.test.ts` 全绿；
- 新增卡片时，`card-components.ts` 不再需要手改（只需 `cards/<key>.ts` + barrel + `SettingCardEmbed` 分支）。

**不要做。** 不要在任务 4 改 28 个组件的 props；不要删除 if/else。

### 任务 5：通用 `FieldEditorCard`

**改哪些文件。**

- 改 `apps/desktop/src/renderer/src/lib/features/settings-card/FieldEditorCard.svelte`
- 新增 / 改 `FieldEditorCard` 的单测（建议 `field-editor-card.test.ts`，纯逻辑部分抽到 `field-editor-model.ts` 便于测试）
- 视需要改 `packages/shared/src/settings-catalog/items.ts`（给示例条目补 `path`）

**步骤。**

1. 抽出 `seedValues(item, prefill, settings)` / `valuesFromState(item, state)` / `fieldControl(field)` 纯函数。
2. 按字段类型渲染：`toggle` / `text` / `number` / `select(static|agents|providers)` / `model`。
3. 保存继续走 `applySettingItem`。
4. `general.workbench` 与 `general.task-loop` 走通用渲染作为验收样例（`fields` 补 `path` 元数据）；`models.concurrency`、`general.launch-at-login`、`models.widget-review`、`agents.default` 保留专用分支（联动 / i18n 提示 / 空选项）。
5. 不支持的类型明确回退：不渲染该字段，并在卡上提示“请在设置页修改”（不要静默丢弃）。

**完成标准。**

- `general.workbench` 的设置卡行为与现在一致；
- 新增一个 `fields: [toggle]` 的条目，不改 `FieldEditorCard` 就能出卡；
- `settings.items.apply` 仍是唯一保存路径。

**不要做。** 不要在这一步支持 `secret` / `oauth` / `account`；不要做 user-only 风险确认。

### 任务 6：设置页目录字段组

**改哪些文件。**

- 新增 `apps/desktop/src/renderer/src/lib/features/settings/SettingsCatalogFields.svelte`
- 改目标设置页（例如 `GeneralSection.svelte`），放入一个示例条目
- 改 `packages/shared/test/unit/settings-catalog.test.ts` 或 UI 扫描测试（新增锚点自动进入覆盖检查）
- 视需要改 i18n 文案

**步骤。**

1. 实现 `SettingsCatalogFields`：只渲染 `owner === 'core'`、`scope === 'global'`、`card === 'field-editor'` 的条目。
2. 用 `FieldEditorCard` 渲染，保存后刷新 `settingsStore`。
3. 设置页在组件外层静态写 `data-settings-anchor`，锚点与目录 `deepLink` 一致。
4. 在设置页放一个示例。**用 `general.task-loop`**：D90 之后 `general.workbench` 已有
   即点即生效的专属开关（替换成「应用」按钮卡是交互回退）；`general.task-loop` 的
   `GeneralSection` 专属表单与 core 适配器重复实现了一套交叉校验，换成本组件后校验单一
   来源在 core，锚点 `general-task-loop` 不变。
5. 文档写清：该组件只用于新增简单设置，不迁移现有整表表单。

**完成标准。**

- 覆盖率测试通过；
- 设置页与对话内卡片对同一条目读写一致；
- 新增简单设置只需在设置页加一行 `SettingsCatalogFields itemIds={[...]}`。

**不要做。** 不要用这个组件替换现有设置页分区；不要把整表保存和条目级保存混在同一个字段上。

### 任务 7（可选）：卡片宿主统一 props

**前置条件。** 任务 4 稳定，且团队接受一次 28 个组件的桥接改造。

**做什么。**

- 定义 `SettingCardProps`；
- 每个卡片加 bridge 组件；
- `SettingCardEmbed` 改为动态组件；
- 删除 if/else；
- 测试改为核对贡献表而非源码分支。

**完成标准。**

- 新增卡片只改 `cards/<key>.ts` + barrel；
- 现有 28 个卡片行为不变；
- `setting-card.spec.ts` e2e 通过。

**风险。** 回归面最大，建议单独分支、单独提交，不与任务 1～6 混合。

### 任务 8：文档与 AGENTS.md

**做什么。**

- 本文件“实施记录”小节补充实际完成项、偏差、测试结果；
- 更新 `docs/design/38-conversational-settings.md` 的目录数字与新增机制；
- 按本文件 §10 更新 `AGENTS.md`；
- 如拆了 `items.ts`，更新 `settings-catalog/index.ts` 的文件分工注释。

**完成标准。**

- 新 Agent 只看 `AGENTS.md` + 本文件就能按规则新增设置；
- 设计篇与代码一致。

## 6. 测试矩阵

| 层 | 测试文件 | 覆盖 |
| --- | --- | --- |
| shared | `packages/shared/test/unit/settings-catalog.test.ts` | 条目 schema、id 唯一、direct 白名单、敏感字段、覆盖率、深链、适配器覆盖纯函数 |
| shared | `packages/shared/test/unit/settings-mode.test.ts` | `effectiveMode` 全矩阵，只收紧不放宽 |
| core | `packages/core/test/unit/settings-adapters-coverage.test.ts` | 目录 → 适配器闭合、无过期适配器、显式 fallback 有理由 |
| core | `packages/core/test/unit/settings-generic-adapter.test.ts` | 通用标量读写、静态选项、拒绝敏感/generic 组合 |
| core | `packages/core/test/unit/settings-item-writes.test.ts` | 现有条目 CAS / 脱敏 / 并发 / MCP / Bot 写入 |
| core | `packages/core/test/unit/settings-adapters-project.test.ts` | 项目组条目读 / 提议 / 拒绝 |
| core | `packages/core/test/integration/settings-cards.test.ts` | 八个端到端场景：direct 回执、form 卡、confirm、user-only、link、settings.changed、required 续跑 |
| desktop | `.../settings-card/card-components.test.ts` | 贡献表 → 组件映射、SettingCardEmbed import/分支、可嵌入性 |
| desktop | `.../settings-card/setting-card-model.test.ts` | 卡片形态、预填过滤、撤销窗口、link 自标 applied |
| desktop | 新增 `field-editor-card.test.ts` | 字段种子、渲染能力、保存值、拒绝不支持类型 |
| e2e | `apps/desktop/test/e2e/setting-card.spec.ts` | 单聊 direct 撤销、项目组 confirm 后唤醒 Bot 续答 |

命令（迭代时定向跑）：

```bash
node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts
node scripts/run-tests.mjs run packages/shared/test/unit/settings-mode.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/settings-adapters-coverage.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/settings-item-writes.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/settings-cards.test.ts
node scripts/run-tests.mjs run apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts
```

类型检查：

```bash
pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck
```

全量 `pnpm test` 只在阶段收口或最终交付前跑一次；改了 shared 契约先 `pnpm --filter @kepcup/shared build`。

## 7. 兼容与迁移

- **不新增 RPC**：继续使用 `settings.items.apply`、`settings.cards.*`、`settings.update` / `bots.update`。
- **不改数据库**：没有迁移。
- **不改现有导出**：`SETTING_ITEMS`、`getSettingItem`、`listSettingItems`、`SETTING_CARD_COMPONENTS`、`cardEmbeddable`、`buildItemAdapters` 的签名保持。
- **贡献表顺序**：先装配贡献，再走 `readOnly` / `renderer` / `viaTool` / `generic` 的短路；重复 id 直接抛错。
- **静默 fallback 的行为变化**：从 `configured` 改为 `unknown`。这是有意的安全修正；受影响条目必须在 `EXPLICIT_ADAPTER_FALLBACK` 登记，否则测试失败。
- **`items.ts` 拆分可选**：第一阶段保留单文件；如果继续增长，再按 `items/{models,bot,general,...}.ts` 拆，`SETTING_ITEMS` 由 `index.ts` 拼接，外部导入不变。

## 8. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 贡献表重复 id | 后注册覆盖前注册，行为不确定 | `buildItemAdapters` 装配时抛错；单测覆盖 |
| 自动发现把未审核卡片带入 | 安全/体积/行为不可控 | 第一阶段只用显式 barrel；`import.meta.glob` 只作为后续可选 |
| 通用适配器误用于复杂设置 | 整对象被覆盖、副作用丢失 | `generic: true` 显式开启；只支持顶层标量；测试拒绝敏感/嵌套 |
| 设置页两种保存模型混用 | 同一字段互相覆盖 | `SettingsCatalogFields` 只给新增简单设置；不与整表表单共享字段 |
| 覆盖率扫描依赖源码字符串 | 重构 Svelte 时误报/漏报 | 保持 `data-settings-anchor` 约定；必要时改为显式 manifest |
| 卡片 props 统一改造回归大 | 28 个卡片行为变化 | 任务 7 可选、单独分支、单独提交 |
| 文档数字漂移 | 误导实施 | 收口时以代码与测试为准，统一修正设计篇/README |

## 9. 验收清单

实施完成后逐项确认：

- [ ] `settingsAdapterCoverageProblems` 在 core 覆盖测试中通过；
- [ ] 未登记适配器的条目 `settings_read` 返回 `unknown`，不再返回 `configured`；
- [ ] 新增一个 `store.generic` 的全局开关，只改 `items.ts` 即可被 Bot 搜索、读取、出卡、保存；
- [ ] 新增该开关的设置页入口只需一行 `SettingsCatalogFields`，覆盖率测试通过；
- [ ] 新增一个自定义卡片，只需 `items.ts` + `cards/<key>.ts` + barrel（任务 7 后连 `SettingCardEmbed` 也不用改）；
- [ ] 缺卡片键 / 缺组件 / 缺锚点 / 缺适配器都会让定向测试失败；
- [ ] `direct` 白名单没有被放宽；
- [ ] 敏感字段仍不经模型、不进快照；
- [ ] 现有 `settings-cards.test.ts` / `setting-card.spec.ts` 行为不变；
- [ ] `AGENTS.md` 已加入设置规则。

## 10. AGENTS.md 规则（已加入并随实施更新）

AGENTS.md 的「设置：只走设置目录」小节在实施时已同步更新（贡献表 / `store.generic` /
`EXPLICIT_ADAPTER_FALLBACK` 都已是现实结构，定向测试命令补了
`settings-adapters-coverage.test.ts`）。以 AGENTS.md 当前内容为准，本节保留原始提案版本备查。

```md
## 设置：只走设置目录

- 任何需要用户配置的新能力，先在 `packages/shared/src/settings-catalog/items.ts`（或拆分后的 `items/`）登记目录条目。设置目录是唯一事实来源：Bot 工具、设置卡、设置页、测试都从它读，不要另建设置清单。
- 新增条目按层补齐：目录条目（id / fields / write / card / deepLink / store）→ core 适配器（`packages/core/src/settings/contributions/` 或 `adapters.ts`）→ 渲染层卡片贡献（`apps/desktop/src/renderer/src/lib/features/settings-card/cards/`）→ 设置页 `data-settings-anchor`。缺适配器或卡片必须显式登记并写明理由（实施后为 `EXPLICIT_ADAPTER_FALLBACK`），不要依赖静默兜底。
- 简单全局标量设置优先用 `store.generic` + `card: 'field-editor'`，不要新写自定义组件；复杂设置才写专用适配器和卡片。
- `direct` 只能加进 `DIRECT_ITEM_IDS`，新条目默认 `maxMode` 不得为 `direct`。敏感字段（secret / oauth / account）只能由用户在卡片里填，永不出现在 `settings_change.values` 或 Bot 可读快照里。
- 改设置相关代码后至少跑定向测试：`node scripts/run-tests.mjs run packages/shared/test/unit/settings-catalog.test.ts packages/core/test/unit/settings-item-writes.test.ts apps/desktop/src/renderer/src/lib/features/settings-card/card-components.test.ts`；涉及 shared 契约先 `pnpm --filter @kepcup/shared build`。
- 设计细节以 `docs/design/38-conversational-settings.md` 和 `todo/settings-catalog-registry.md` 为准。
```

## 11. 待定问题

1. **是否拆 `items.ts`**：52 条约 990 行，单文件仍可维护；拆分能让一个功能一个文件，但会制造一次大 diff。建议任务 1 不做，等条目超过 ~80 条再拆。
2. **是否引入 `import.meta.glob` 自动发现卡片**：能减少 barrel 行，但会削弱显式审查与 tree-shaking 控制。建议任务 7 之后再评估。
3. **设置页“目录字段组”放在哪里**：是每个现有分区里嵌一小块，还是新建“更多设置”分区？建议先嵌在目标分区，避免新分区变成杂物间。
4. **目录文案 i18n**：当前 `items.ts` 的 `title` / `summary` / `label` 是中文硬编码。若未来支持多语言，需要把目录文案改成 i18n key 或渲染层映射；本次不做。
5. **`profile.user-facts` 的 fallback**：当前没有安全信号，继续显式登记为“无适配器、按设置页为准”。是否要为它设计一个不含原文的摘要，是独立产品问题。

## 12. 实施记录（2026-10-21）

### 完成情况

| 任务 | 状态 | 说明 |
| --- | --- | --- |
| 0 基线记录 | 完成 | 见下「测试结果」；5 个既有失败属并行未提交改动（未登记锚点 `bot-inkcop-agents`、扩展页签 `localCollab`），由其所属任务补登记 |
| 1 shared 覆盖检查 + `define.ts` | 完成 | `define.ts` 抽出四个 helper 并从 index 导出；`SettingFieldSpec.path`、`settingStoreSchema.settings.generic`、`coverage.ts` 新增 `requiresItemAdapter` + `settingsAdapterCoverageProblems` |
| 2 core 贡献表 | 完成 | `contributions/{types,capability,models,bot,general,environment,legacy,index}.ts`；`buildItemAdapters` 移到 `contributions/index.ts` 并导出 `assembleAdapters`（重复 id 抛错可测）；`capability.*` 改显式登记；删除静默 fallback，漏登记回 `unknown`；`EXPLICIT_ADAPTER_FALLBACK` 仅 `profile.user-facts`；新增 `settings-adapters-coverage.test.ts` |
| 3 通用标量适配器 | 完成 | `generic-adapter.ts`；`general.workbench` 迁移（`store.generic: true` + `field.path`），删除 `workbenchEnabledAdapter`；新增 `settings-generic-adapter.test.ts`；目录测试钉死 generic 条目纪律（非敏感、单值、顶层键、不放宽） |
| 4 desktop 卡片贡献表 | 完成 | `settings-card/cards/{types,index}.ts`（`EmbedContext` 与 `embeddedAgentId` 移入）；`card-components.ts` 变派生层，`SETTING_CARD_COMPONENTS` / `cardEmbeddable` 导出不变；`SettingCardEmbed.svelte` 未动；`card-components.test.ts` 补贡献表闭合检查 |
| 5 通用 FieldEditorCard | 完成 | 新增 `field-editor-model.ts`（控件判定 / 点路径种子 / 提交值整理）+ `field-editor-model.test.ts`；`FieldEditorCard.svelte` 重写为元数据驱动（toggle/text/number/select static·agents·providers/model），不支持的字段显示「请在设置页修改」；`workbench` / `task-loop` 走通用路径，`models.concurrency`、`general.launch-at-login`、`models.widget-review`、`agents.default` 保留专用分支（联动 / i18n / 空选项），后三者补了 `field.path` |
| 6 设置页目录字段组 | 完成 | 新增 `Settings/SettingsCatalogFields.svelte`；`GeneralSection` 的任务 Loop 专属表单（约 110 行，与 core 适配器重复实现交叉校验）替换为该组件渲染 `general.task-loop`，校验单一来源在 core，锚点 `general-task-loop` 由页面静态写、不变 |
| 7 卡片宿主统一 props | 未做 | 按设计留作后续（回归面大，前置条件是任务 4 稳定运行一段时间） |
| 8 文档与 AGENTS.md | 完成 | 设计篇 §状态 / §1.2 / §1.3（测试四）/ §1.4 / §11.2 与 AGENTS.md 已同步；本文件 §2.2 数字、§4.1.4、§4.2、§4.3 已按实施修正 |

### 与原方案的偏差（均为实施时决策）

1. **`buildItemAdapters` 移到 `contributions/index.ts`**（原方案保留在 `adapters.ts`）：
   `adapters.ts` 只留类型、共享 helper 与适配器实现，贡献文件单向 import 它——避免
   `adapters.ts ↔ contributions/` 循环引用。`host.ts` 与两个单测的 import 路径随之更新。
2. **贡献接口形态**：`adapters: Record<itemId, factory>` 取代 `itemIds + create(deps)`
   （原形态表达不了一个功能组里多个不同适配器）。短路顺序按行为等价定为
   只读 → 渲染层 → 贡献表 → viaTool → generic → 未登记（原方案把 viaTool 放前面会
   遮蔽 via-tool 条目自己的读适配器，已在 §4.2.3 修正）。
3. **desktop 贡献第一阶段不 import 组件**（`componentName` 字符串 + `embeddable` 判定），
   登记集中在 `cards/index.ts` 按组分段，不做每键一文件；组件 import 仍在
   `SettingCardEmbed`，避免同一组件两处引入。
4. **任务 6 示例条目用 `general.task-loop`** 而非原建议的 `general.workbench`（D90 已给
   workbench 即点即生效的专属开关，替换是交互回退；task-loop 的专属表单与 core 适配器
   重复实现校验，替换后单一来源）。
5. **`SettingsCatalogFields` 不渲染锚点**（§4.3.6 修正）：覆盖率扫描只认字面量，动态
   `{expr}` 绑定扫不到；锚点由设置页静态写。
6. **`model-selection-single-source` 白名单**补 `settings/contributions/models.ts`（贡献
   文件引用 `defaultMainModel` 等字段名属于登记，不做选取）。

### 行为变化（有意）

- **漏登记适配器**：`settings_read` 从静默回 `configured`（误导 Bot「能力已配好」）改为
  `unknown`（「未接入设置目录适配器」）；core 覆盖测试同时失败。受影响的既有条目只有
  `profile.user-facts`（已在 `EXPLICIT_ADAPTER_FALLBACK` 显式登记），其 link 卡手动
  「我已设置好」仍结卡（`verified: null`，与渲染层条目同语义）。
- **`general.workbench` 的读摘要**由通用适配器生成（单布尔开关下与原自定义适配器逐字一致）。

### 后续修复（2026-10-21）

- InkCop 的 `localCollab` 扩展页签与 `bot-inkcop-agents` 锚点已补登记：`agents.inkcop-local-collab` / `bot.inkcop-agents`（link 卡 + core 只读适配器）；`settings-catalog` UI 覆盖恢复全绿。
- `systemBotId` 从 `inkcopLocalCollabSettingsSchema` 移除（RPC patch 仍兼容旧字段），桌面端 svelte-check 恢复 0 error。
- 本节下方「测试结果」中记录的 5 个基线失败与 4 个 desktop 错误已随之消除。

### 测试结果（2026-10-21）

定向矩阵（`node scripts/run-tests.mjs run ...`）：

- `shared/settings-catalog.test.ts`：**5 failed / 28+ passed** —— 5 个失败全部是基线既有
  （并行未提交改动引入的 `bot-inkcop-agents` 锚点与 `localCollab` 扩展页签未登记），
  与本次改动无关，属其所属任务；
- `shared/settings-mode.test.ts`、`core/settings-item-writes / settings-adapters-project /
  settings-catalog-host / settings-adapters-coverage（新）/ settings-generic-adapter（新）/
  model-selection-single-source`、`core/integration/settings-cards`：全绿；
- `desktop/settings-card/card-components / setting-card-model / deep-link /
  field-editor-model（新）/ project-members`、`i18n/catalog-text`：全绿；
- 类型检查：`shared`、`core` 通过；`desktop` 的 `svelte-check` 剩 4 个错误 + tsc.node 1 个
  错误，全部位于并行任务的文件（`inkcop-collab.ts` / `ExtensionLocalCollab.svelte` /
  `inkcop-local-bridge.spec.ts` 的 `systemBotId`），本次改动的文件仅 1 个有意 warning
  （`FieldEditorCard` 捕获 `item` 初始值，与旧实现同模式）。
- 全量 `pnpm test`（阶段收口跑一次）：537/541 文件、5782/5812 用例通过；7 个失败全部
  归属并行未提交改动——shared UI 覆盖 5 个（见上）、`tool-effects`（`get_run_steps`
  未分类）、`permission-bridge`（skill 目录豁免），无一来自本次改动。

### 实施期间的环境事件

同仓库有并行会话在进行 `feat/english-ui` 合并（曾短暂留下 `rpc/methods.ts` 冲突标记，
由该会话自行解决）。上文的「基线既有失败」与 desktop 类型检查错误均来自这批并行改动，
收口时以当前工作树为准复核即可。

