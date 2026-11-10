import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputerHost } from './computer-host';
import {
  CAPABILITIES_RECORD_FILENAME,
  readCapabilitiesRecord,
} from './computer/capabilities-record';

const { capabilitiesMock, shutdownSidecarMock, probeCaptureMock } = vi.hoisted(() => ({
  capabilitiesMock: vi.fn(),
  shutdownSidecarMock: vi.fn(),
  probeCaptureMock: vi.fn(),
}));

vi.mock('./computer/sidecar-client', () => ({
  callComputerSidecarCapabilities: capabilitiesMock,
  callComputerSidecarAction: vi.fn(),
  // P-B2 直采自检：设置页「检测截屏」经 sidecar 让 CuaDriver 真抓一帧。
  callComputerSidecarDirectCaptureProbe: probeCaptureMock,
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
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  function permissionDeps(
    api: {
      isTrustedAccessibilityClient?: (prompt: boolean) => boolean;
      getMediaAccessStatus?: (mediaType: 'screen') => string;
    } = {},
  ) {
    const apiMock = {
      isTrustedAccessibilityClient: vi.fn(api.isTrustedAccessibilityClient ?? (() => true)),
      getMediaAccessStatus: vi.fn(api.getMediaAccessStatus ?? (() => 'granted')),
    };
    const openExternal = vi.fn(async () => undefined);
    return { api: apiMock, shell: { openExternal }, platform: 'darwin' as const };
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
