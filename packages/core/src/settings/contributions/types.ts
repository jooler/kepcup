import type { AdapterDeps, ItemAdapter } from '../adapters.js';

/**
 * core 设置适配器的贡献单元（todo/settings-catalog-registry.md §4.2）。
 *
 * 一个功能组一个贡献：`adapters` 按目录条目 id 列工厂（一个组里可以有多个不同的适配器；
 * 同一适配器服务多个条目时重复列同一工厂）。新功能只需：`items.ts` 登记条目 +
 * 这里加一个文件 + `index.ts` 一行 barrel。漏登记的条目由
 * `settingsAdapterCoverageProblems`（core 单测调用）强制暴露。
 */
export interface SettingAdapterContribution {
  /** 贡献单元名，日志/测试用。 */
  name: string;
  /** 目录条目 id → 适配器工厂；键集合就是本贡献负责的条目。 */
  adapters: Readonly<Record<string, (deps: AdapterDeps) => ItemAdapter>>;
}
