import { createWebmediaDriver } from './webmedia';

/** 麦克风约束（沿用 26 号设计）：全是软性——stereo-only 的 USB 麦克风、显示器拾音等
 * 设备上精确的 channelCount 会直接 OverconstrainedError。 */
export const MICROPHONE_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export const microphoneDriver = createWebmediaDriver({
  kind: 'microphone',
  deviceKind: 'audioinput',
  trackKey: 'audio',
  constraints: MICROPHONE_CONSTRAINTS,
});
