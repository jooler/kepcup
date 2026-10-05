import type { WslRunResult, WslRunner } from './setup.js';
import { WSL_DISTRO_NAME } from './constants.js';

/**
 * P12-B TEST SEAM — a scriptable stand-in for wsl.exe so the Windows sandbox
 * preparation wizard is drivable end-to-end on non-Windows dev machines
 * (docs/dev/phases/P12-windows-and-enhanced-sandbox.md 任务 7 e2e). Production
 * never activates it: it only exists when the launcher sets
 * `KEPCUP_WSL_TEST_FIXTURE` (never set outside e2e) AND the build is not
 * production — `NODE_ENV=production` hard-disables the seam even when a
 * machine accidentally carries the env var (修复轮加固). The emitted bytes
 * mirror the real UTF-16LE-with-BOM shapes the decode/parse fixtures use.
 *
 * Scenario behavior:
 *  - `not_installed`: both metadata commands fail with the localized
 *    "no installed distributions" shape; the elevated
 *    `wsl --install --no-distribution` succeeds and flips the metadata output
 *    to the "components present" shape (simulating the completed reboot), so
 *    the state machine continues into the import → ready path.
 *  - `policy_disabled`: both metadata commands fail with the group-policy
 *    shape (and the elevated enable fails the same way) — the wizard stays in
 *    the per-command confirm mode (任务书: 保持逐条确认).
 *  - `ready`: metadata reports the components and a registered Kepcup
 *    distro — probe is available (就绪).
 */

export type WslFixtureScenario = 'not_installed' | 'policy_disabled' | 'ready';

const NOT_INSTALLED_TEXT = '适用于 Linux 的 Windows 子系统没有已安装的分发版。\r\n';
const POLICY_TEXT = '适用于 Linux 的 Windows 子系统已被组策略禁用。\r\n';
const OK_STATUS_TEXT = 'Default Version: 2\r\n';
const LIST_WITH_DISTRO_TEXT = [
  '  NAME            STATE           VERSION',
  `  ${WSL_DISTRO_NAME}      Stopped         2`,
  '',
].join('\r\n');
const LIST_EMPTY_TEXT = ['  NAME            STATE           VERSION', ''].join('\r\n');

/** Reads the scenario from the environment; null = the seam is inactive. */
export function wslFixtureScenarioFromEnv(env: NodeJS.ProcessEnv): WslFixtureScenario | null {
  // Fail-safe: packaged builds run with NODE_ENV=production, e2e with
  // NODE_ENV=test — the seam must never fire in the former (BR-P12 修复轮).
  if (env.NODE_ENV === 'production') return null;
  const raw = env.KEPCUP_WSL_TEST_FIXTURE;
  if (raw === 'not_installed' || raw === 'policy_disabled' || raw === 'ready') return raw;
  return null;
}

/**
 * Builds the fixture runner. `importDelayMs` stretches the `wsl --import`
 * step so the UI (and e2e) can observe the importing phase; the default is
 * short enough for tests and irrelevant in production (seam inactive).
 */
export function createWslFixtureRunner(
  scenario: WslFixtureScenario,
  options: { importDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): WslRunner {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const importDelayMs = options.importDelayMs ?? 2_500;
  // not_installed flips to "components present" once the elevated enable ran
  // (the fixture simulates that the required reboot already happened); the
  // distro row appears once --import succeeded.
  let componentsInstalled = scenario === 'ready';
  let distroImported = scenario === 'ready';
  const utf16 = (text: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const result = (exitCode: number, text: string): WslRunResult => ({
    exitCode,
    stdout: utf16(text),
    stderr: Buffer.alloc(0),
  });

  const metadata = (): { status: WslRunResult; list: WslRunResult } => {
    if (scenario === 'policy_disabled') {
      return { status: result(126, POLICY_TEXT), list: result(126, POLICY_TEXT) };
    }
    if (!componentsInstalled) {
      return { status: result(1, NOT_INSTALLED_TEXT), list: result(1, NOT_INSTALLED_TEXT) };
    }
    const list = distroImported ? LIST_WITH_DISTRO_TEXT : LIST_EMPTY_TEXT;
    return { status: result(0, OK_STATUS_TEXT), list: result(0, list) };
  };

  return {
    async run(args, runOptions = {}): Promise<WslRunResult> {
      void runOptions;
      if (args[0] === '--status') {
        const { status } = metadata();
        return status;
      }
      if (args[0] === '--list') {
        const { list } = metadata();
        return list;
      }
      if (args[0] === '--import') {
        // Stretch this step so the importing phase is observable.
        await sleep(importDelayMs);
        componentsInstalled = true;
        distroImported = true;
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      if (args[0] === '-d') {
        // In-distro steps: tee (wsl.conf), useradd, terminate, kepcup-sandbox
        // --selfcheck — all succeed (the fixture image is healthy).
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
    async runElevated(args): Promise<WslRunResult> {
      // UAC grant succeeded; under policy_disabled even the enable fails with
      // the policy shape (matches the real wsl.exe behavior).
      if (scenario === 'policy_disabled') return result(126, POLICY_TEXT);
      if (args[0] === '--install') {
        componentsInstalled = true;
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  };
}
