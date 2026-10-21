import {
  concurrencyAdapter,
  embeddingLocalAdapter,
  providerKeyAdapter,
  settingsModelAdapter,
} from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/** 模型组：默认主 / 轻量、厂商接入、组件审查、本地向量、并发上限。 */
export const modelsContribution: SettingAdapterContribution = {
  name: 'models',
  adapters: {
    'models.default-main': (deps) => settingsModelAdapter(deps, 'defaultMainModel', null),
    'models.default-light': (deps) => settingsModelAdapter(deps, 'defaultLightModel', null),
    'models.widget-review': (deps) =>
      settingsModelAdapter(deps, 'widgetReviewModel', '跟随 Bot 主模型'),
    'models.provider': providerKeyAdapter,
    'models.embedding-local': embeddingLocalAdapter,
    'models.concurrency': concurrencyAdapter,
  },
};
