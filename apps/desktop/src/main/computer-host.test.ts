import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComputerHost } from './computer-host';
import {
  CAPABILITIES_RECORD_FILENAME,
  readCapabilitiesRecord,
} from './computer/capabilities-record';

const { capabilitiesMock } = vi.hoisted(() => ({
  capabilitiesMock: vi.fn(),
}));

vi.mock('./computer/sidecar-client', () => ({
  callComputerSidecarCapabilities: capabilitiesMock,
  callComputerSidecarAction: vi.fn(),
  // P-B1 WP6：ComputerHostImpl 构造时注入 cua socket 目录父级。
  setComputerSidecarUserDataDirectory: vi.fn(),
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
    capabilitiesMock.mockRejectedValue(new Error('helper spawn failed'));
    const host = createComputerHost(() => userDataDir);

    await expect(host.capabilities()).resolves.toBeNull();
    await expect(host.capabilitiesStatus()).resolves.toMatchObject({
      available: false,
      error: 'helper spawn failed',
    });
    expect(readCapabilitiesRecord(userDataDir)).toMatchObject({
      available: false,
      error: 'helper spawn failed',
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
