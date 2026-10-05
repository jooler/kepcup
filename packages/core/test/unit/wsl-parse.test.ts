import { describe, expect, it } from 'vitest';

import {
  classifyWslFailure,
  deriveWslState,
  parseWslListVerbose,
  parseWslStatus,
} from '../../src/sandbox/wsl/parse.js';

/**
 * Fixtures shaped after the documented wsl.exe output formats (P12 任务 2):
 * normal / 未安装 / 企业策略禁用 / WSL1 多态. All strings here are the
 * DECODED text (decode.ts handles the UTF-16 layer); these cover the
 * English and zh-CN label variants seen in the wild. Blind-written on
 * macOS — 真机复核列 todo/cross-platform-acceptance.md P12.
 */

const LIST_EN = [
  '  NAME            STATE           VERSION',
  '* Ubuntu          Running         2',
  '  Debian          Stopped         1',
  '  Kepcup      Stopped         2',
  '',
].join('\r\n');

const LIST_EMPTY_HEADER_ONLY = '  NAME            STATE           VERSION\r\n';

const LIST_ZH = ['  名称            状态            版本', '  Kepcup      正在运行         2', ''].join('\r\n');

describe('parseWslStatus', () => {
  it('parses the English status output', () => {
    const parsed = parseWslStatus('Default Distribution: Ubuntu\r\nDefault Version: 2\r\n');
    expect(parsed).toEqual({ defaultVersion: 2, defaultDistro: 'Ubuntu' });
  });

  it('parses zh-CN labels', () => {
    const parsed = parseWslStatus('默认分发: Ubuntu\r\n默认版本: 2\r\n');
    expect(parsed.defaultVersion).toBe(2);
    expect(parsed.defaultDistro).toBe('Ubuntu');
  });

  it('returns nulls for unknown/localized-beyond-recognition shapes', () => {
    expect(parseWslStatus('一些未知文本')).toEqual({ defaultVersion: null, defaultDistro: null });
  });
});

describe('parseWslListVerbose', () => {
  it('parses the verbose list including the WSL1 row', () => {
    const entries = parseWslListVerbose(LIST_EN);
    expect(entries).toEqual([
      { name: 'Ubuntu', state: 'Running', version: 2 },
      { name: 'Debian', state: 'Stopped', version: 1 },
      { name: 'Kepcup', state: 'Stopped', version: 2 },
    ]);
  });

  it('parses zh-CN rows (state tokens localized, version column intact)', () => {
    expect(parseWslListVerbose(LIST_ZH)).toEqual([{ name: 'Kepcup', state: '正在运行', version: 2 }]);
  });

  it('ignores the header-only output of a fresh install', () => {
    expect(parseWslListVerbose(LIST_EMPTY_HEADER_ONLY)).toEqual([]);
  });

  it('ignores unparseable lines instead of throwing', () => {
    expect(parseWslListVerbose('garbage\r\nno columns\r\n')).toEqual([]);
  });
});

describe('classifyWslFailure', () => {
  it('recognizes the group-policy disablement in EN and zh-CN', () => {
    expect(classifyWslFailure('WSL is blocked by group policy')).toBe('policy_disabled');
    expect(classifyWslFailure('适用于 Linux 的 Windows 子系统已被组策略禁用')).toBe('policy_disabled');
  });

  it('recognizes a missing WSL installation', () => {
    expect(classifyWslFailure('There are no installed distributions.')).toBe('not_installed');
    expect(classifyWslFailure('适用于 Linux 的 Windows 子系统没有已安装的分发版。')).toBe('not_installed');
  });

  it('recognizes the virtual-machine-platform enablement hint', () => {
    expect(classifyWslFailure('Please enable the Virtual Machine Platform')).toBe('needs_enable');
    expect(classifyWslFailure('请启用“虚拟机平台”可选组件')).toBe('needs_enable');
  });

  it('falls back to unknown for unrecognized failures', () => {
    expect(classifyWslFailure('boom')).toBe('unknown');
  });
});

describe('deriveWslState', () => {
  const OK_STATUS = { exitCode: 0, text: 'Default Version: 2\r\n' };
  const POLICY = { exitCode: 0x4ec, text: 'The operation was blocked by group policy (0x800704EC)' };
  const NOT_INSTALLED = { exitCode: 1, text: '适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n' };

  it('reports ok + registered when the distro exists as WSL2', () => {
    const state = deriveWslState({
      status: OK_STATUS,
      list: { exitCode: 0, text: LIST_EN },
      distroName: 'Kepcup',
    });
    expect(state.install).toEqual({ kind: 'ok', defaultVersion: 2 });
    expect(state.distro).toEqual({ kind: 'registered', running: false });
  });

  it('reports a running distro', () => {
    const state = deriveWslState({ status: OK_STATUS, list: { exitCode: 0, text: LIST_ZH }, distroName: 'Kepcup' });
    expect(state.distro).toEqual({ kind: 'registered', running: true });
  });

  it('reports wsl1 for a distro registered under version 1 (re-import required)', () => {
    const list = ['  NAME            STATE           VERSION', '  Kepcup      Stopped         1', ''].join('\r\n');
    const state = deriveWslState({ status: OK_STATUS, list: { exitCode: 0, text: list }, distroName: 'Kepcup' });
    expect(state.distro).toEqual({ kind: 'wsl1' });
  });

  it('reports absent when only other distros exist', () => {
    const list = ['  NAME            STATE           VERSION', '* Ubuntu          Running         2', ''].join('\r\n');
    const state = deriveWslState({ status: OK_STATUS, list: { exitCode: 0, text: list }, distroName: 'Kepcup' });
    expect(state.distro).toEqual({ kind: 'absent' });
  });

  it('policy-disabled wins over everything else (逐条确认模式的结构化原因)', () => {
    const state = deriveWslState({ status: POLICY, list: POLICY, distroName: 'Kepcup' });
    expect(state.install).toEqual({ kind: 'policy_disabled' });
  });

  it('policy-disabled wins even when ONE command succeeded (BR-P12-009)', () => {
    // 任一命令带出组策略错误即权威：不得因另一命令 exit 0 而判 ok。
    const state = deriveWslState({ status: POLICY, list: { exitCode: 0, text: LIST_EN }, distroName: 'Kepcup' });
    expect(state.install).toEqual({ kind: 'policy_disabled' });
    // distro 状态仍来自成功的那条命令（fail-closed 不损失信息）。
    expect(state.distro).toEqual({ kind: 'registered', running: false });
  });

  it('reports not_installed when both commands fail with the no-distribution text', () => {
    const state = deriveWslState({ status: NOT_INSTALLED, list: NOT_INSTALLED, distroName: 'Kepcup' });
    expect(state.install.kind).toBe('not_installed');
    expect(state.install.kind === 'not_installed' && state.install.detail.length > 0).toBe(true);
  });

  it('treats a missing wsl.exe binary (both null) as not_installed', () => {
    const state = deriveWslState({ status: null, list: null, distroName: 'Kepcup' });
    expect(state.install.kind).toBe('not_installed');
  });

  it('treats unknown failures of both commands as needs_enable (idempotent enable path)', () => {
    const state = deriveWslState({
      status: { exitCode: 1, text: 'boom' },
      list: { exitCode: 1, text: 'boom' },
      distroName: 'Kepcup',
    });
    expect(state.install.kind).toBe('needs_enable');
  });
});
