import type { SensorKind, SettingItem, SettingValues } from '@kepcup/shared';
import { sensorOfItem } from './setting-card-model';

/**
 * 渲染层条目（`owner: 'renderer'`，core 读不到也写不了，todo/conversational-app-setup.md §5.3
 * 第 6 条）的本机写入：confirm 卡「应用」时在这里写，再 `settings.cards.complete` 让 core 标
 * applied（无法核对，按用户所说）。只认目录登记过的非敏感字段。
 */

/** 本机写入口（注入便于单测；生产用 sensors store / mode-watcher / i18n）。 */
export interface RendererWriters {
  setSensorEnabled(kind: SensorKind, enabled: boolean): void;
  setSensorDevice(kind: SensorKind, deviceId: string): void;
  setTheme?(theme: 'light' | 'dark' | 'system'): void;
  setLanguage?(language: string): void;
  /** 支持的界面语言（i18n `localeOptions`）；不在里面的值不写。 */
  languages?: readonly string[];
}

/** 写入成功返回 true；这一项本机还不会写（卡片退回「在设置中打开」）返回 false。 */
export function applyRendererValues(
  item: SettingItem,
  values: SettingValues,
  writers: RendererWriters,
): boolean {
  if (item.id === 'general.theme') {
    const theme = values.theme;
    if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return false;
    if (writers.setTheme === undefined) return false;
    writers.setTheme(theme);
    return true;
  }
  if (item.id === 'general.language') {
    const language = values.language;
    if (typeof language !== 'string' || language.length === 0) return false;
    if (writers.setLanguage === undefined) return false;
    if (writers.languages !== undefined && !writers.languages.includes(language)) return false;
    writers.setLanguage(language);
    return true;
  }
  const sensor = sensorOfItem(item.id);
  if (sensor === null) return false;
  const enabled = values.enabled;
  const device = values.device;
  if (typeof enabled !== 'boolean' && typeof device !== 'string') return false;
  if (typeof enabled === 'boolean') writers.setSensorEnabled(sensor, enabled);
  if (typeof device === 'string') writers.setSensorDevice(sensor, device);
  return true;
}
