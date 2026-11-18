import {
  concurrencyAdapter,
  defaultTaskEngineAdapter,
  embeddingLocalAdapter,
  providerKeyAdapter,
  settingsModelAdapter,
} from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/** 模型组：默认主 / 轻量 / 后台任务模型、默认任务执行引擎、厂商接入、组件审查、本地向量、并发上限。 */
export const modelsContribution: SettingAdapterContribution = {
  name: 'models',
  adapters: {
    'models.default-main': (deps) => settingsModelAdapter(deps, 'defaultMainModel', null),
    'models.default-light': (deps) => settingsModelAdapter(deps, 'defaultLightModel', null),
    'models.background-model': (deps) =>
      settingsModelAdapter(deps, 'backgroundModel', '跟随轻量模型'),
    'models.task-engine': defaultTaskEngineAdapter,
    'models.widget-review': (deps) =>
      settingsModelAdapter(deps, 'widgetReviewModel', '跟随 Bot 主模型'),
    'models.micro-app': (deps) =>
      settingsModelAdapter(deps, 'microAppModel', '跟随 Bot 轻量模型'),
    'models.provider': providerKeyAdapter,
    'models.embedding-local': embeddingLocalAdapter,
    'models.concurrency': concurrencyAdapter,
  },
};
