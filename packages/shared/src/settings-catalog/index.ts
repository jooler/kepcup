/**
 * 设置目录（Settings Catalog，todo/conversational-app-setup.md §四）
 * ==================================================================
 *
 * KepCup 自身全部设置的**唯一事实来源**：每个设置项的 id、作用、范围、读写位置、最宽松档位、
 * 卡片组件、深链锚点都登记在这里（纯数据、无 UI 依赖）。读它的人：
 *
 * - core：条目适配器（读 / 条目级 CAS 写 / 撤销）、`settings_search` / `settings_read` /
 *   `settings_change` 三个工具、档位裁定 `effectiveMode`、`settings.changed` 映射
 *   （`itemIdsForSettingsPaths` 等）；
 * - desktop：通用卡片宿主 `SettingCard` 按 `card`（`CardKey`）分发到设置页组件，link 档按
 *   `deepLink` 跳转；组件映射用 `cardComponentProblems` 自检；
 * - 测试：覆盖率（每个设置位置有条目或排除理由、深链锚点真实存在）、direct 白名单、敏感字段。
 *
 * 文件分工：
 * - `types.ts`：条目形态（`SettingItem` / `SettingFieldSpec` / 档位 / 卡片键 / 深链）；
 * - `define.ts`：登记条目用的小 helper（`defineSettingItem` 等）；
 * - `items.ts`：`SETTING_ITEMS` 与 `DIRECT_ITEM_IDS`；
 * - `mode.ts`：`effectiveMode`（§5.3 宿主裁定，只会收紧）；
 * - `query.ts`：列表、按 id 取、搜索、概览、变更映射；
 * - `coverage.ts`：排除表、待补锚点、覆盖率 / 组件映射 / 适配器闭合检查（纯函数，扫描源码在测试里）；
 * - `cards.ts`：`setting_card` / `setting_card_resolved` 事件与三个工具的结构化结果；
 * - `validate.ts`：`values` 的形状校验（未登记的键、类型、静态选项），core 写入前统一过一遍；
 * - `merge.ts`：三方合并，`settings.update` / `bots.update` 带 `base` 时不让过期表单覆盖别处的修改。
 *
 * 加一个设置项：在 `items.ts` 登记（`card` 先填 null = 跳转卡；简单全局标量直接
 * `store.generic` + `card: 'field-editor'`）；组件嵌入化后在 `CARD_KEYS` 加键并填 `card`。
 * `direct` 只能给 `DIRECT_ITEM_IDS` 里的条目（测试强制）。
 */
export * from './types.js';
export * from './define.js';
export * from './items.js';
export * from './mode.js';
export * from './query.js';
export * from './coverage.js';
export * from './cards.js';
export * from './validate.js';
export * from './merge.js';
