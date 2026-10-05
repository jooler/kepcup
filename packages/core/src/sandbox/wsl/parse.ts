/**
 * Parsers for wsl.exe metadata output (docs/dev/phases/P12 任务 2). The
 * output is localized (English / zh-CN labels both occur in the wild) and
 * UTF-16 encoded — decoding happens in decode.ts, matching here is tolerant:
 * column positions are derived from the 2+ space gaps, version from the
 * trailing 1|2 token. Pure functions; fixture unit tests feed samples shaped
 * after the documented formats (normal / not installed / policy disabled /
 * WSL1-only distros).
 */

export interface WslStatusInfo {
  /** "Default Version" value; null when not present/parseable. */
  defaultVersion: number | null;
  /** "Default Distribution" value when found. */
  defaultDistro: string | null;
}

const STATUS_VERSION_LABELS = ['default version', '默认版本'];
const STATUS_DISTRO_LABELS = ['default distribution', '默认分发', '默认分发版'];

/** Parses `wsl --status` text. Never throws — unknown shapes yield nulls. */
export function parseWslStatus(text: string): WslStatusInfo {
  let defaultVersion: number | null = null;
  let defaultDistro: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const normalized = line.toLowerCase();
    const splitAt = Math.max(normalized.indexOf(':'), normalized.indexOf('：'));
    if (splitAt < 0) continue;
    const label = normalized.slice(0, splitAt).trim();
    const value = line.slice(splitAt + 1).trim();
    if (defaultVersion === null && STATUS_VERSION_LABELS.includes(label)) {
      const parsed = Number.parseInt(value, 10);
      if (parsed === 1 || parsed === 2) defaultVersion = parsed;
    }
    if (defaultDistro === null && STATUS_DISTRO_LABELS.includes(label) && value.length > 0) {
      defaultDistro = value;
    }
  }
  return { defaultVersion, defaultDistro };
}

export interface WslDistroEntry {
  name: string;
  /** Localized state token as printed (Running / Stopped / 正在运行 / …). */
  state: string;
  version: 1 | 2;
}

/**
 * Parses `wsl --list --verbose` output. Format per line:
 * `[*] NAME<2+ spaces>STATE<2+ spaces>1|2`. The header line (localized) is
 * skipped by the trailing version token requirement. Distro names with
 * single spaces survive; anything unparseable is ignored (fail-closed
 * consumers treat an empty list as "distro absent").
 */
export function parseWslListVerbose(text: string): WslDistroEntry[] {
  const entries: WslDistroEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, '').trim();
    if (line.length === 0) continue;
    const body = line.startsWith('*') ? line.slice(1).trim() : line;
    const versionMatch = /(?:^|\s{2,})([12])\s*$/.exec(body);
    if (versionMatch === null) continue;
    const version = Number.parseInt(versionMatch[1]!, 10) as 1 | 2;
    const withoutVersion = body.slice(0, versionMatch.index).trim();
    const gapMatch = /\s{2,}/.exec(withoutVersion);
    if (gapMatch === null) continue;
    const name = withoutVersion.slice(0, gapMatch.index).trim();
    const state = withoutVersion.slice(gapMatch.index).trim();
    if (name.length === 0 || state.length === 0) continue;
    entries.push({ name, state, version });
  }
  return entries;
}

/**
 * Classification of a failed `wsl --status` / `wsl --list` invocation.
 * Markers cover the English and zh-CN shapes of the three documented
 * failure classes; anything unmatched is `unknown` (the setup flow reacts
 * with the generic enable path, which is idempotent).
 */
export type WslFailureClass = 'policy_disabled' | 'not_installed' | 'needs_enable' | 'unknown';

const POLICY_MARKERS = [
  'group policy',
  'disabled by policy',
  'blocked by group policy',
  '0x800704ec',
  'access disabled by policy',
  '组策略',
  '策略禁用',
  '已被策略',
];

const NOT_INSTALLED_MARKERS = [
  'no installed distributions',
  'wsl is not installed',
  'not been installed',
  '没有已安装的分发版',
  '尚未安装',
  '未安装适用于 linux 的 windows 子系统',
];

const NEEDS_ENABLE_MARKERS = [
  'virtual machine platform',
  'enable the virtual machine platform',
  '虚拟机平台',
  '请启用',
  '0x80370102', // virtual machine feature not enabled (hypervisor)
  '0x8007019e', // WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED
];

export function classifyWslFailure(text: string): WslFailureClass {
  const normalized = text.toLowerCase();
  if (POLICY_MARKERS.some((marker) => normalized.includes(marker))) return 'policy_disabled';
  if (NOT_INSTALLED_MARKERS.some((marker) => normalized.includes(marker))) return 'not_installed';
  if (NEEDS_ENABLE_MARKERS.some((marker) => normalized.includes(marker))) return 'needs_enable';
  return 'unknown';
}

// --- combined state -------------------------------------------------------------

export type WslInstallState =
  | { kind: 'ok'; defaultVersion: number | null }
  | { kind: 'policy_disabled' }
  | { kind: 'needs_enable'; detail: string }
  | { kind: 'not_installed'; detail: string };

export type WslDistroState =
  | { kind: 'absent' }
  | { kind: 'wsl1' }
  | { kind: 'registered'; running: boolean };

export interface WslStateInput {
  /** wsl.exe spawn result for `--status` (null = binary itself missing). */
  status: { exitCode: number | null; text: string } | null;
  /** wsl.exe spawn result for `--list --verbose` (null = binary missing). */
  list: { exitCode: number | null; text: string } | null;
  /** The private distro name (Kepcup). */
  distroName: string;
}

export interface WslState {
  install: WslInstallState;
  distro: WslDistroState;
}

/**
 * Combines the two command results into the machine-readable state the
 * setup flow and probe() consume:
 *  - wsl.exe missing (spawn ENOENT) or "not installed" markers → not_installed;
 *  - policy markers win over everything else (企业策略禁用 → 逐条确认模式,
 *    structured reason);
 *  - `--status` parseable → ok (+ default version);
 *  - otherwise needs_enable (binary present, component state unclear — the
 *    idempotent `wsl --install --no-distribution` enable flow resolves it).
 * The distro state is derived from the distro's own list row: absent / WSL1
 * (must be re-imported as version 2) / registered (+ running flag).
 */
export function deriveWslState(input: WslStateInput): WslState {
  const listEntries = input.list !== null ? parseWslListVerbose(input.list.text) : [];
  const ownRow = listEntries.find((entry) => entry.name === input.distroName) ?? null;
  const distro: WslDistroState =
    ownRow === null
      ? { kind: 'absent' }
      : ownRow.version === 1
        ? { kind: 'wsl1' }
        : { kind: 'registered', running: /running|正在运行/i.test(ownRow.state) };

  if (input.status === null && input.list === null) {
    return { install: { kind: 'not_installed', detail: 'wsl.exe 不存在（未安装 Windows 子系统）' }, distro };
  }
  const failureText = [input.status, input.list]
    .filter((result): result is { exitCode: number; text: string } => result !== null)
    .filter((result) => result.exitCode !== 0)
    .map((result) => result.text)
    .join('\n');
  const statusUsable = input.status !== null && input.status.exitCode === 0;
  const listUsable = input.list !== null && input.list.exitCode === 0;
  // Policy markers win over everything else — also when ONE of the two
  // commands succeeded (BR-P12-009): a group-policy error on the other is
  // authoritative, never "ok" (fail-closed: per-command confirm mode).
  if (classifyWslFailure(failureText) === 'policy_disabled') {
    return { install: { kind: 'policy_disabled' }, distro };
  }
  if (!statusUsable && !listUsable) {
    const classified = classifyWslFailure(failureText);
    if (classified === 'not_installed') {
      return { install: { kind: 'not_installed', detail: summarize(failureText) }, distro };
    }
    if (classified === 'needs_enable') {
      return { install: { kind: 'needs_enable', detail: summarize(failureText) }, distro };
    }
    // Unknown failure of both commands: the binary exists but WSL clearly is
    // not usable → treat as needs_enable (enable flow is idempotent).
    return { install: { kind: 'needs_enable', detail: summarize(failureText) }, distro };
  }
  const status = input.status !== null && input.status.exitCode === 0 ? parseWslStatus(input.status.text) : null;
  return { install: { kind: 'ok', defaultVersion: status?.defaultVersion ?? null }, distro };
}

/** First non-empty line of a failure, for display (bounded). */
function summarize(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return 'wsl 命令失败';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
