import {
  SENSOR_KINDS,
  sensorDescriptor,
  type SensorKind,
  type SensorPermissionStatus,
} from '@kepcup/shared';
import {
  loadSensorPrefs,
  saveSensorPrefs,
  type SensorPrefs,
  type StorageLike,
} from './preferences';
import { getDriver } from './registry';
import {
  SensorDisabledError,
  type OpenedSensor,
  type SensorAccess,
  type SensorDevice,
  type SensorDriver,
} from './types';

/**
 * 传感器中枢（docs/design/31-sensors.md §2.2，D76）：每个 kind 一份状态
 * （启用 / 设备偏好 / 设备列表 / 权限 / 最近错误 / 回退标记）+ 设备热插拔监听 +
 * 偏好持久化。不依赖 Svelte runes——响应式镜像在 `sensors.svelte.ts`，这里保持
 * 纯 TS 以便单测。
 */

export interface SensorState {
  enabled: boolean;
  /** 空串 = 跟随系统默认。 */
  deviceId: string;
  devices: SensorDevice[];
  /** null = 尚未查询。 */
  permission: SensorPermissionStatus | null;
  /** 最近一次 open 是否因所选设备不可用而回退到系统默认。 */
  fellBack: boolean;
  lastError: string | null;
}

export type SensorSnapshot = Record<SensorKind, SensorState>;

export interface SensorHubDeps {
  storage?: StorageLike | null;
  /** 默认走 registry；单测注入伪 driver。 */
  driverFor?: (kind: SensorKind) => SensorDriver;
  /** devicechange 订阅；默认 navigator.mediaDevices。返回取消订阅函数。 */
  onDeviceChange?: (listener: () => void) => () => void;
}

/** 已选设备是否已从设备列表消失。无名 / 无 id 的列表（未授权时浏览器不给 id）无法判断，返回 false。 */
export function isSelectedDeviceMissing(state: SensorState): boolean {
  if (state.deviceId.length === 0) return false;
  const ids = state.devices.map((device) => device.deviceId).filter((id) => id.length > 0);
  if (ids.length === 0) return false;
  return !ids.includes(state.deviceId);
}

function defaultOnDeviceChange(listener: () => void): () => void {
  const md = globalThis.navigator?.mediaDevices;
  if (md === undefined) return () => {};
  md.addEventListener('devicechange', listener);
  return () => md.removeEventListener('devicechange', listener);
}

export class SensorHub {
  readonly #storage: StorageLike | null | undefined;
  readonly #driverFor: (kind: SensorKind) => SensorDriver;
  readonly #onDeviceChange: (listener: () => void) => () => void;
  readonly #listeners = new Set<(snapshot: SensorSnapshot) => void>();
  #state: SensorSnapshot;
  #stopDeviceWatch: (() => void) | null = null;
  /** 已打开且可能仍在采集的流（停用时一并切断，隐私总闸不只管新打开）。 */
  readonly #openStreams: Record<SensorKind, Set<MediaStream>> = {
    microphone: new Set(),
    camera: new Set(),
  };
  /** refresh 的序号：重叠的刷新只让最新一次落盘，避免旧设备列表覆盖新的。 */
  readonly #refreshSeq: Record<SensorKind, number> = { microphone: 0, camera: 0 };

  constructor(deps: SensorHubDeps = {}) {
    this.#storage = deps.storage;
    this.#driverFor = deps.driverFor ?? getDriver;
    this.#onDeviceChange = deps.onDeviceChange ?? defaultOnDeviceChange;
    const prefs = loadSensorPrefs(deps.storage);
    const state = {} as SensorSnapshot;
    for (const descriptor of SENSOR_KINDS) {
      const pref = prefs[descriptor.id];
      state[descriptor.id] = {
        enabled: pref?.enabled ?? descriptor.defaultEnabled,
        deviceId: pref?.deviceId ?? '',
        devices: [],
        permission: null,
        fellBack: false,
        lastError: null,
      };
    }
    this.#state = state;
  }

  get snapshot(): SensorSnapshot {
    return this.#state;
  }

  subscribe(listener: (snapshot: SensorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 开始监听设备热插拔（幂等）；返回停止函数。 */
  start(): () => void {
    if (this.#stopDeviceWatch === null) {
      const stop = this.#onDeviceChange(() => void this.refreshAll());
      this.#stopDeviceWatch = () => {
        stop();
        this.#stopDeviceWatch = null;
      };
    }
    return this.#stopDeviceWatch;
  }

  async refreshAll(): Promise<void> {
    await Promise.all(SENSOR_KINDS.map((descriptor) => this.refresh(descriptor.id)));
  }

  /** 重新枚举设备并读取系统权限状态。 */
  async refresh(kind: SensorKind): Promise<void> {
    const driver = this.#driverFor(kind);
    const seq = ++this.#refreshSeq[kind];
    const [devices, permission] = await Promise.all([
      driver.listDevices(),
      driver.permissionStatus().catch((): SensorPermissionStatus => 'unknown'),
    ]);
    if (seq !== this.#refreshSeq[kind]) return;
    this.#patch(kind, { devices, permission });
  }

  setEnabled(kind: SensorKind, enabled: boolean): void {
    if (!enabled) this.#stopOpenStreams(kind);
    this.#patch(kind, { enabled });
    this.#persist();
  }

  setDeviceId(kind: SensorKind, deviceId: string): void {
    this.#patch(kind, { deviceId, fellBack: false });
    this.#persist();
  }

  /** 授权门；结果同步到 state.permission。 */
  async ensureAccess(kind: SensorKind): Promise<SensorAccess> {
    const driver = this.#driverFor(kind);
    const access = await driver.ensureAccess();
    this.#patch(kind, {
      permission: access === 'granted' ? 'granted' : access === 'denied' ? 'denied' : 'unknown',
    });
    return access;
  }

  openSettings(kind: SensorKind): void {
    this.#driverFor(kind).openSettings();
  }

  /**
   * 打开传感器（按当前设备偏好）。已停用 → SensorDisabledError（隐私总闸，不放行）。
   * 授权门由调用方先走 ensureAccess——denied / unavailable 的提示文案各场景不同。
   * 所选设备不可用时回退系统默认并置 state.fellBack，供调用方 / 设置页显式提示。
   */
  async open(kind: SensorKind): Promise<OpenedSensor> {
    const state = this.#state[kind];
    if (!state.enabled) throw new SensorDisabledError(kind);
    try {
      const opened = await this.#driverFor(kind).open(state.deviceId);
      // getUserMedia 等待期间（如系统授权弹框）用户可能已停用：此时立即切断，不交付。
      if (!this.#state[kind].enabled) {
        for (const track of opened.stream.getTracks()) track.stop();
        throw new SensorDisabledError(kind);
      }
      this.#trackStream(kind, opened.stream);
      this.#patch(kind, { fellBack: opened.fellBack, lastError: null });
      return opened;
    } catch (error) {
      this.#patch(kind, { lastError: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  #trackStream(kind: SensorKind, stream: MediaStream): void {
    const streams = this.#openStreams[kind];
    for (const known of streams) {
      if (known.getTracks().every((track) => track.readyState === 'ended')) streams.delete(known);
    }
    streams.add(stream);
  }

  #stopOpenStreams(kind: SensorKind): void {
    for (const stream of this.#openStreams[kind]) {
      for (const track of stream.getTracks()) track.stop();
    }
    this.#openStreams[kind].clear();
  }

  #patch(kind: SensorKind, patch: Partial<SensorState>): void {
    sensorDescriptor(kind); // 未知 kind 立即抛错
    this.#state = { ...this.#state, [kind]: { ...this.#state[kind], ...patch } };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #persist(): void {
    const prefs: SensorPrefs = {};
    for (const descriptor of SENSOR_KINDS) {
      const state = this.#state[descriptor.id];
      prefs[descriptor.id] = { enabled: state.enabled, deviceId: state.deviceId };
    }
    saveSensorPrefs(prefs, this.#storage);
  }
}
