#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from './args.js';
import { isAcceptableUrl } from './util.js';
import { formatReport } from './report.js';
import { validate, type ValidateOptions } from './validate.js';

export const VERSION = '0.0.0';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Override the browser opener (tests). */
  openBrowser?: ValidateOptions['openBrowser'];
  /** Extra options merged into every validate call (tests: client id, ports, fetch). */
  validateOverrides?: Partial<ValidateOptions>;
  /** Replace the validator (tests: simulate an internal failure). */
  validate?: typeof validate;
}

/** Best-effort system browser launch; the URL is also printed so a headless user can copy it. */
function systemOpen(url: string): void {
  // Defence in depth (the validator already refuses unsafe authorization URLs): never hand the
  // system a non-web URL such as file:, smb: or a custom protocol handler.
  if (!isAcceptableUrl(url)) return;
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL has been printed; the user can open it by hand.
  }
}

/** Runs the CLI and returns the process exit code (0 ok, 1 validation errors, 2 usage/tool failure). */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') {
    io.stdout(USAGE);
    return 0;
  }
  if (parsed.command === 'version') {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (parsed.command === 'error') {
    io.stderr(`kepcup-app: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }
  const log = (line: string): void => {
    if (!parsed.json) io.stderr(`${line}\n`);
  };
  const openBrowser: NonNullable<ValidateOptions['openBrowser']> =
    io.openBrowser ??
    ((url) => {
      io.stderr(`Authorize in your browser: ${url}\n`);
      if (!parsed.noBrowser) systemOpen(url);
    });
  try {
    const report = await (io.validate ?? validate)({
      target: parsed.target,
      auth: parsed.auth,
      timeoutMs: parsed.timeoutMs,
      openBrowser,
      log,
      ...io.validateOverrides,
    });
    io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
    return report.exitCode;
  } catch (error) {
    io.stderr(`kepcup-app: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  void runCli(process.argv.slice(2), {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
  }).then((code) => {
    process.exitCode = code;
  });
}
