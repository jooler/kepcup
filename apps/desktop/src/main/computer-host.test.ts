import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputerHost } from './computer-host';
import {
  CAPABILITIES_RECORD_FILENAME,
  readCapabilitiesRecord,
} from './computer/capabilities-record';

const { capabilitiesMock, shutdownSidecarMock, probeCaptureMock, driverPermissionsMock } = vi.hoisted(() => ({
  capabilitiesMock: vi.fn(),
  shutdownSidecarMock: vi.fn(),
  probeCaptureMock: vi.fn(),
  driverPermissionsMock: vi.fn(),
}));

vi.mock('./computer/sidecar-client', () => ({
  callComputerSidecarCapabilities: capabilitiesMock,
  callComputerSidecarAction: vi.fn(),
  // P-B2 直采自检：设置页「检测截屏」经 sidecar 让 CuaDriver 真抓一帧。
  callComputerSidecarDirectCaptureProbe: probeCaptureMock,
  // 三端启用修订：win/linux 权限面板状态源（daemon check_permissions）。
  callComputerSidecarPermissionsStatus: driverPermissionsMock,
  // P-B1 WP6：ComputerHostImpl 构造时注入 cua socket 目录父级。
  setComputerSidecarUserDataDirectory: vi.fn(),
  // P-B2：stop / permissionsOpen 通过它终止 sidecar（provider 跑在子进程里）。
  shutdownComputerSidecar: shutdownSidecarMock,
}));

/**
 * D105 capabilities 握手落盘（2026-10-31 冒烟反馈）：失败此前只进 dev stdout，
 * 无终端就无从定位「工具为什么没注册」；现在成败都写 userData 记录，设置页
 * 可用性行经 capabilitiesStatus 读取。
 */
describe('ComputerHost capabilities record', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'kepcup-capabilities-'));
    capabilitiesMock.mockReset();
    shutdownSidecarMock.mockReset();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('persists a successful handshake', async () => {
    capabilitiesMock.mockResolvedValue({ platform: 'darwin' });
    const host = createComputerHost(() => userDataDir);

    await expect(host.capabilities()).resolves.toEqual({ platform: 'darwin' });
    expect(readCapabilitiesRecord(userDataDir)).toMatchObject({ available: true, error: null });
  });

  it('persists the failure reason and surfaces it via capabilitiesStatus', async () => {
    capabilitiesMock.mockRejectedValue(new Error('cua-driver daemon failed'));
    const host = createComputerHost(() => userDataDir);

    await expect(host.capabilities()).resolves.toBeNull();
    await expect(host.capabilitiesStatus()).resolves.toMatchObject({
      available: false,
      error: 'cua-driver daemon failed',
    });
    expect(readCapabilitiesRecord(userDataDir)).toMatchObject({
      available: false,
      error: 'cua-driver daemon failed',
    });
  });

  it('re-checks with capabilitiesStatus after the sidecar recovers and overwrites the record', async () => {
    capabilitiesMock.mockRejectedValueOnce(new Error('computer sidecar exited with code 1'));
    const host = createComputerHost(() => userDataDir);
    await host.capabilities();

    capabilitiesMock.mockResolvedValue({ platform: 'darwin' });
    await expect(host.capabilitiesStatus()).resolves.toMatchObject({
      available: true,
      error: null,
    });
    expect(readCapabilitiesRecord(userDataDir)).toMatchObject({ available: true });
  });

  it('names the record file under userData', () => {
    expect(join(userDataDir, CAPABILITIES_RECORD_FILENAME)).toContain(
      'computer-use-capabilities.json',
    );
  });
});

describe('ComputerHost permissions (P-B2: host TCC via systemPreferences)', () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'kepcup-permissions-'));
    capabilitiesMock.mockReset();
    shutdownSidecarMock.mockReset();
    probeCaptureMock.mockReset();
    driverPermissionsMock.mockReset();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  function permissionDeps(
    api: {
      isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
      getMediaAccessStatus?: (mediaType: 'screen') => string;
    } = {},
    platform: 'darwin' | 'win32' | 'linux' = 'darwin',
  ) {
    const apiMock = {
      isTrustedAccessibilityClient: vi.fn(api.isTrustedAccessibilityClient ?? (() => true)),
      getMediaAccessStatus: vi.fn(api.getMediaAccessStatus ?? (() => 'granted')),
    };
    const openExternal = vi.fn(async () => undefined);
    return { api: apiMock, shell: { openExternal }, platform };
  }

  it('maps host TCC states', async () => {
    const deps = permissionDeps({
      isTrustedAccessibilityClient: () => false,
      getMediaAccessStatus: () => 'denied',
    });
    const host = createComputerHost(() => userDataDir, deps);

    await expect(host.permissionsStatus()).resolves.toEqual({
      accessibility: 'not-granted',
      screenRecording: 'not-granted',
      directCapture: 'unknown',
    });
  });

  it('probes capture through the daemon and caches the result', async () => {
    probeCaptureMock.mockResolvedValue({ state: 'granted', reason: null });
    const host = createComputerHost(() => userDataDir, permissionDeps());

    await expect(host.permissionsProbeCapture()).resolves.toEqual({
      status: {
        accessibility: 'granted',
        screenRecording: 'granted',
        directCapture: 'granted',
      },
      reason: null,
    });
    expect(probeCaptureMock).toHaveBeenCalledTimes(1);
    // 后续只读状态沿用自检结论，不重复抓帧。
    await expect(host.permissionsStatus()).resolves.toMatchObject({ directCapture: 'granted' });
  });

  it('surfaces the driver reason when the probe cannot capture', async () => {
    probeCaptureMock.mockResolvedValue({
      state: 'not-granted',
      reason: 'direct_capture_consent_required: screen capture skipped',
    });
    const host = createComputerHost(() => userDataDir, permissionDeps());

    await expect(host.permissionsProbeCapture()).resolves.toEqual({
      status: {
        accessibility: 'granted',
        screenRecording: 'granted',
        directCapture: 'not-granted',
      },
      reason: 'direct_capture_consent_required: screen capture skipped',
    });
  });

  it('restarts a stale sidecar before probing (grant → Test capture)', async () => {
    const deps = permissionDeps({ getMediaAccessStatus: () => 'denied' });
    const host = createComputerHost(() => userDataDir, deps);
    probeCaptureMock.mockResolvedValue({ state: 'granted', reason: null });

    await host.permissionsStatus();
    deps.api.getMediaAccessStatus.mockReturnValue('granted');
    await host.permissionsStatus();
    expect(shutdownSidecarMock).not.toHaveBeenCalled();

    // 用户刚在系统设置里授权：旧 daemon 缓存着旧 TCC，自检前必须先重启。
    await host.permissionsProbeCapture();
    expect(shutdownSidecarMock).toHaveBeenCalledTimes(1);
  });

  it('drops a cached direct-capture verdict when screen recording is revoked', async () => {
    const deps = permissionDeps();
    const host = createComputerHost(() => userDataDir, deps);
    probeCaptureMock.mockResolvedValue({ state: 'granted', reason: null });
    await host.permissionsProbeCapture();

    deps.api.getMediaAccessStatus.mockReturnValue('denied');
    await expect(host.permissionsStatus()).resolves.toMatchObject({ directCapture: 'unknown' });
  });

  it('returns unknown without permission deps', async () => {
    const host = createComputerHost(() => userDataDir);
    await expect(host.permissionsStatus()).resolves.toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown',
      directCapture: 'unknown',
    });
  });

  // --- 三端启用修订：win/linux 状态源是 daemon 的 check_permissions -------------

  it('maps daemon-reported states on win32 (no TCC to read)', async () => {
    driverPermissionsMock.mockResolvedValue({
      accessibility: true,
      screenRecording: true,
      directCapture: 'granted',
      attribution: 'host',
    });
    const host = createComputerHost(() => userDataDir, permissionDeps({}, 'win32'));

    await expect(host.permissionsStatus()).resolves.toEqual({
      accessibility: 'granted',
      screenRecording: 'granted',
      directCapture: 'granted',
    });
    // 不读宿主 TCC（win 上没有对应概念）。
    expect(driverPermissionsMock).toHaveBeenCalledTimes(1);
  });

  it('maps daemon-reported states on linux', async () => {
    driverPermissionsMock.mockResolvedValue({
      accessibility: false,
      screenRecording: false,
      directCapture: 'unknown',
      attribution: 'host',
    });
    const host = createComputerHost(() => userDataDir, permissionDeps({}, 'linux'));

    await expect(host.permissionsStatus()).resolves.toEqual({
      accessibility: 'not-granted',
      screenRecording: 'not-granted',
      directCapture: 'unknown',
    });
  });

  it('reports unknown on win/linux when the daemon is unreachable', async () => {
    driverPermissionsMock.mockRejectedValue(new Error('cua-driver runtime was not found'));
    const host = createComputerHost(() => userDataDir, permissionDeps({}, 'win32'));

    await expect(host.permissionsStatus()).resolves.toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown',
      directCapture: 'unknown',
    });
  });

  it('keeps the probe path working on non-darwin platforms', async () => {
    probeCaptureMock.mockResolvedValue({ state: 'granted', reason: null });
    // 非 darwin 的状态源是 daemon：探针后 permissionsStatus 读 daemon 的最新结论。
    driverPermissionsMock.mockResolvedValue({
      accessibility: true,
      screenRecording: true,
      directCapture: 'granted',
      attribution: 'host',
    });
    const host = createComputerHost(() => userDataDir, permissionDeps({}, 'win32'));

    await expect(host.permissionsProbeCapture()).resolves.toMatchObject({
      status: { accessibility: 'granted', screenRecording: 'granted', directCapture: 'granted' },
      reason: null,
    });
    expect(probeCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('lets a real-frame probe verdict win over the daemon read-only verdict on win32', async () => {
    // Windows 实测：check_permissions 的 screen_recording_capturable 不可靠
    // （报 unknown 的同时真帧采集成功）——探针 granted 必须覆盖 daemon verdict。
    probeCaptureMock.mockResolvedValue({ state: 'granted', reason: null });
    driverPermissionsMock.mockResolvedValue({
      accessibility: false,
      screenRecording: false,
      directCapture: 'unknown',
      attribution: null,
    });
    const host = createComputerHost(() => userDataDir, permissionDeps({}, 'win32'));

    const result = await host.permissionsProbeCapture();
    expect(result.status.directCapture).toBe('granted');
    expect(result.reason).toBeNull();
    // 后续只读状态沿用真帧结论，不被 daemon verdict 打回 unknown。
    await expect(host.permissionsStatus()).resolves.toMatchObject({ directCapture: 'granted' });
  });

  it('keeps a failed probe verdict visible on win32 (reason surfaced)', async () => {
    probeCaptureMock.mockResolvedValue({
      state: 'not-granted',
      reason: 'capture blocked: no on-screen window',
    });
    driverPermissionsMock.mockResolvedValue({
      accessibility: false,
      screenRecording: false,
      directCapture: 'unknown',
      attribution: null,
    });
    const host = createComputerHost(() => userDataDir, permissionDeps({}, 'win32'));

    const result = await host.permissionsProbeCapture();
    // 真抓失败的 not-granted 同样优先于 daemon 的 unknown——如实显示失败。
    expect(result.status.directCapture).toBe('not-granted');
    expect(result.reason).toBe('capture blocked: no on-screen window');
  });

  it('prompts for accessibility and opens the Privacy pane', async () => {
    const deps = permissionDeps();
    const host = createComputerHost(() => userDataDir, deps);

    await host.permissionsOpen('accessibility');

    expect(deps.api.isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
    expect(deps.shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    );
    // 不在打开设置时杀掉可能承载在途动作的 sidecar；下一次 invoke 前重启。
    expect(shutdownSidecarMock).not.toHaveBeenCalled();
    await host.invoke('click', {});
    expect(shutdownSidecarMock).toHaveBeenCalledTimes(1);
  });

  it('opens the screen-recording Privacy pane', async () => {
    const deps = permissionDeps();
    const host = createComputerHost(() => userDataDir, deps);

    await host.permissionsOpen('screen-recording');

    expect(deps.api.isTrustedAccessibilityClient).not.toHaveBeenCalled();
    expect(deps.shell.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
    expect(shutdownSidecarMock).not.toHaveBeenCalled();
    await host.invoke('click', {});
    expect(shutdownSidecarMock).toHaveBeenCalledTimes(1);
  });

  it('restarts the sidecar when a grant is first observed', async () => {
    const api = {
      isTrustedAccessibilityClient: vi.fn(() => false),
      getMediaAccessStatus: vi.fn(() => 'denied'),
    };
    const deps = {
      api,
      shell: { openExternal: vi.fn(async () => undefined) },
      platform: 'darwin' as const,
    };
    const host = createComputerHost(() => userDataDir, deps);

    await host.permissionsStatus();
    expect(shutdownSidecarMock).not.toHaveBeenCalled();

    api.isTrustedAccessibilityClient.mockReturnValue(true);
    await host.permissionsStatus();
    // 读取权限不直接杀掉 sidecar（在途动作可能已下发）；下一次 invoke 前重启。
    expect(shutdownSidecarMock).not.toHaveBeenCalled();

    await host.invoke('click', {});
    expect(shutdownSidecarMock).toHaveBeenCalledTimes(1);
  });

  it('stop() terminates the sidecar so the daemon sees fresh TCC', () => {
    const host = createComputerHost(() => userDataDir);
    expect(host.stop('test')).toEqual({ stopped: true });
    expect(shutdownSidecarMock).toHaveBeenCalledTimes(1);
  });
});
