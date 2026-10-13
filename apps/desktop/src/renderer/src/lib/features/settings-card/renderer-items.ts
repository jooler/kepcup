import type { SensorKind, SettingItem, SettingValues } from '@kepcup/shared';
import { sensorOfItem } from './setting-card-model';

/**
 * 渲染层条目（`owner: 'renderer'`，core 读不到也写不了，todo/conversational-app-setup.md §5.3
 * 第 6 条）的本机写入：confirm 卡「应用」时在这里写，再 `settings.cards.complete` 让 core 标
 * applied（无法核对，按用户所说）。只认目录登记过的非敏感字段。
 */

/** 本机写入口（注入便于单测；生产用 sensors store）。 */
export interface RendererWriters {
  setSensorEnabled(kind: SensorKind, enabled: boolean): void;
  setSensorDevice(kind: SensorKind, deviceId: string): void;
}

/** 写入成功返回 true；这一项本机还不会写（卡片退回「在设置中打开」）返回 false。 */
export function applyRendererValues(
  item: SettingItem,
  values: SettingValues,
  writers: RendererWriters,
): boolean {
  const sensor = sensorOfItem(item.id);
  if (sensor === null) return false;
  const enabled = values.enabled;
  const device = values.device;
  if (typeof enabled !== 'boolean' && typeof device !== 'string') return false;
  if (typeof enabled === 'boolean') writers.setSensorEnabled(sensor, enabled);
  if (typeof device === 'string') writers.setSensorDevice(sensor, device);
  return true;
}
