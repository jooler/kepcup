import { createWebmediaDriver } from './webmedia';

/** 摄像头约束（D76 本期仅设置页预览）：分辨率只给 ideal，不设 facingMode。 */
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

export const cameraDriver = createWebmediaDriver({
  kind: 'camera',
  deviceKind: 'videoinput',
  trackKey: 'video',
  constraints: CAMERA_CONSTRAINTS,
});
