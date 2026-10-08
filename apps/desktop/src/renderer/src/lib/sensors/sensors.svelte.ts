import type { SensorKind } from '@kepcup/shared';
import { SensorHub, type SensorSnapshot } from './hub';

/**
 * 传感器 store（docs/design/31-sensors.md，D76）：SensorHub 的 Svelte 响应式
 * 镜像。逻辑都在 hub（纯 TS，可单测）；这里只把快照放进 $state 并转发方法。
 */
class SensorsStore {
  readonly #hub = new SensorHub();
  // $state.raw + 只读 getter：快照由 hub 整体替换，外部不能就地改字段而绕开 hub。
  #snapshot = $state.raw<SensorSnapshot>(this.#hub.snapshot);

  get state(): SensorSnapshot {
    return this.#snapshot;
  }

  constructor() {
    this.#hub.subscribe((snapshot) => {
      this.#snapshot = snapshot;
    });
    this.#hub.start();
  }

  refresh = (kind: SensorKind) => this.#hub.refresh(kind);
  refreshAll = () => this.#hub.refreshAll();
  setEnabled = (kind: SensorKind, enabled: boolean) => this.#hub.setEnabled(kind, enabled);
  setDeviceId = (kind: SensorKind, deviceId: string) => this.#hub.setDeviceId(kind, deviceId);
  ensureAccess = (kind: SensorKind) => this.#hub.ensureAccess(kind);
  openSettings = (kind: SensorKind) => this.#hub.openSettings(kind);
  open = (kind: SensorKind) => this.#hub.open(kind);
}

export const sensors = new SensorsStore();
