import {
  sensorDescriptor,
  sensorKindSchema,
  type SensorKind,
  type SensorOsMediaType,
  type SensorPermissionStatus,
} from '@kepcup/shared';

/**
 * 传感器系统权限门（docs/design/31-sensors.md §2.1，D76；由 26 号的 mic:* 泛化）。
 *
 * macOS 的 TCC 授权弹框只出现一次：首次请求被拒后系统不再弹框，只能引导用户
 * 去系统设置。因此按 kind 的 osMediaType 暴露「状态 / 主动请求 / 深链系统设置」
 * 三件套。非 macOS 或无系统权限门（osMediaType === null）一律视为已授权
 * （Windows 用自己的隐私指示器，Linux 无此机制）。
 */

/** systemPreferences 的结构化子集（便于单测注入）。 */
export interface MediaAccessApi {
  getMediaAccessStatus(mediaType: SensorOsMediaType): SensorPermissionStatus;
  askForMediaAccess(mediaType: SensorOsMediaType): Promise<boolean>;
}

const SETTINGS_PANE: Record<SensorOsMediaType, string> = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
};

/** IPC 入参校验：未知 kind 抛错（拒绝）。 */
export function parseSensorKind(raw: unknown): SensorKind {
  const parsed = sensorKindSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Unknown sensor kind: ${String(raw)}`);
  return parsed.data;
}

function osMediaTypeOf(kind: SensorKind, platform: NodeJS.Platform): SensorOsMediaType | null {
  return platform === 'darwin' ? sensorDescriptor(kind).osMediaType : null;
}

export function sensorPermissionStatus(
  kind: SensorKind,
  api: MediaAccessApi,
  platform: NodeJS.Platform = process.platform,
): SensorPermissionStatus {
  const mediaType = osMediaTypeOf(kind, platform);
  return mediaType === null ? 'granted' : api.getMediaAccessStatus(mediaType);
}

export async function sensorPermissionRequest(
  kind: SensorKind,
  api: MediaAccessApi,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const mediaType = osMediaTypeOf(kind, platform);
  return mediaType === null ? true : api.askForMediaAccess(mediaType);
}

/** 系统设置面板深链；无系统权限门的组合返回 null（调用方不做事）。 */
export function sensorSettingsUrl(
  kind: SensorKind,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const mediaType = osMediaTypeOf(kind, platform);
  return mediaType === null ? null : SETTINGS_PANE[mediaType];
}
