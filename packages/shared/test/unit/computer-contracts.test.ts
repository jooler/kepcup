import { describe, expect, it } from 'vitest';
import {
  COMPUTER_INVOKE_METHODS,
  computerActionResultSchema,
  computerErrorCodeSchema,
  computerListAppsResultSchema,
  computerListWindowsResultSchema,
  computerProviderCapabilitiesSchema,
  computerSnapshotResultSchema,
} from '../../src/index.js';

/**
 * 计算机操控（D105）契约 round-trip：schema 必须能原样消化 CuaDriver / sidecar
 * 实际产出的结构（fixtures 见 apps/desktop/src/main/computer/fixtures/cua-driver/），
 * 错误码与 invoke 方法面是 main / core / 渲染层共用的唯一事实来源。
 */

const snapshotFixture = {
  snapshot: {
    id: '6C1F…-uuid',
    app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 99106 },
    window: {
      id: 123,
      title: 'All iCloud – 23 notes',
      x: 0,
      y: 38,
      width: 1440,
      height: 900,
      isMinimized: false,
      isOffscreen: false,
      screenIndex: 0,
      platform: { layer: 0 },
    },
    coordinateSpace: 'window',
    treeText: 'App=com.apple.Notes (pid 99106)\nWindow: "All iCloud…"\n0 standard window…',
    elementCount: 174,
    focusedElementId: null,
    truncation: { truncated: false, maxNodes: 3000, maxDepth: 45, maxDepthReached: false },
  },
  screenshot: { data: 'iVBOR…', format: 'png', width: 2546, height: 1872, scale: 2 },
  screenshotStatus: {
    state: 'captured',
    metadata: { engine: 'screenCaptureKit', windowId: 123 },
  },
} as const;

describe('computer contracts', () => {
  it('error codes are the passthrough surface (no rewriting)', () => {
    expect(computerErrorCodeSchema.parse('permission_denied')).toBe('permission_denied');
    // 集合外的 code（如 sidecar 层的 CONTROLLER_BUSY，经 RuntimeClientError 另行
    // 透传）不属于 helper 契约枚举，schema 层拒收。
    expect(computerErrorCodeSchema.safeParse('controller_busy').success).toBe(false);
  });

  it('snapshot result round-trips a real helper response', () => {
    expect(computerSnapshotResultSchema.parse(snapshotFixture)).toEqual(snapshotFixture);
  });

  it('tree diff metadata attaches to snapshots (sidecar baseline diffing)', () => {
    const parsed = computerSnapshotResultSchema.parse({
      ...snapshotFixture,
      snapshot: {
        ...snapshotFixture.snapshot,
        treeDiff: { baseSnapshotId: 'prev-uuid', changed: 3, added: 1, removed: 0 },
      },
    });
    expect(parsed.snapshot.treeDiff?.added).toBe(1);
  });

  it('action result carries delivery + verification metadata (anti-replay surface)', () => {
    const action = computerActionResultSchema.parse({
      ...snapshotFixture,
      action: {
        path: 'accessibility',
        actionName: 'AXConfirm',
        delivery: 'background',
        verification: { state: 'unverified', reason: 'suspected_noop' },
        targetWindowId: 123,
      },
    });
    expect(action.action?.delivery).toBe('background');
    expect(action.action?.verification?.state).toBe('unverified');
    // synthetic click（坐标路径）没有 actionName 也要能过。
    expect(
      computerActionResultSchema.parse({
        ...snapshotFixture,
        action: {
          path: 'synthetic',
          fallbackReason: 'actionUnsupported',
          verification: { state: 'unverified', reason: 'synthetic_input' },
        },
      }).action?.path,
    ).toBe('synthetic');
  });

  it('verified readback carries the confirmed property', () => {
    const action = computerActionResultSchema.parse({
      ...snapshotFixture,
      action: {
        path: 'accessibility',
        actionName: 'AXSetValue',
        verification: { state: 'verified', property: 'value', expected: 'X', actualPreview: 'X' },
      },
    });
    expect(action.action?.verification).toMatchObject({ state: 'verified', property: 'value' });
  });

  it('handshake capabilities round-trip (macOS native provider)', () => {
    const capabilities = computerProviderCapabilitiesSchema.parse({
      platform: 'darwin',
      provider: 'orca-computer-use-macos',
      providerVersion: '1.0.0',
      protocolVersion: 1,
      supports: {
        apps: { list: true, bundleIds: true, pids: true },
        windows: { list: true, targetById: true, targetByIndex: true, focus: false, moveResize: false },
        observation: { screenshot: true, annotatedScreenshot: false, elementFrames: true, ocr: false },
        actions: {
          click: true,
          typeText: true,
          pressKey: true,
          hotkey: true,
          pasteText: true,
          scroll: true,
          drag: true,
          setValue: true,
          performAction: true,
        },
        surfaces: { menus: false, dialogs: false, dock: false, menubar: false },
        input: { background: true },
      },
    });
    expect(capabilities.supports.input?.background).toBe(true);
  });

  it('list results round-trip', () => {
    const apps = computerListAppsResultSchema.parse({
      apps: [{ name: 'Notes', bundleId: 'com.apple.Notes', pid: 1, isRunning: true, lastUsedAt: null, useCount: null }],
    });
    expect(apps.apps[0]?.name).toBe('Notes');
    const windows = computerListWindowsResultSchema.parse({
      app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 1 },
      windows: [
        {
          index: 0,
          app: { name: 'Notes', bundleId: 'com.apple.Notes', pid: 1 },
          id: 12,
          title: 'Notes',
          x: 0,
          y: 0,
          width: 800,
          height: 600,
          isMinimized: false,
          isOffscreen: false,
          screenIndex: 0,
          isMain: null,
          platform: { layer: 0, alpha: 1 },
        },
      ],
    });
    expect(windows.windows[0]?.index).toBe(0);
  });

  it('invoke method whitelist equals the sidecar surface', () => {
    // pressKey / hotkey 在工具层合一为 computer_key（设计 §4），sidecar 方法面不变。
    expect(COMPUTER_INVOKE_METHODS).toContain('pressKey');
    expect(COMPUTER_INVOKE_METHODS).toContain('hotkey');
    // orca 未实现的 selectText 不暴露。
    expect(COMPUTER_INVOKE_METHODS).not.toContain('selectText' as never);
  });
});
