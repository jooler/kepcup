/** Argument parsing for `kepcup-app` (no dependencies; exit code 2 on any usage error). */

export interface ValidateArgs {
  command: 'validate';
  target: string;
  auth: boolean;
  json: boolean;
  noBrowser: boolean;
  timeoutMs: number | undefined;
}

export type ParsedArgs =
  | ValidateArgs
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'error'; message: string };

export const USAGE = `Usage: kepcup-app validate <server.json path | https URL> [options]

Validates a KepCup connector manifest (MCP Registry server.json plus
_meta["app.kepcup/connector"]) and the remote MCP server it points at.

Options:
  --auth           Authorize once in a browser with KepCup's client identity, then
                   check the tools (without it, servers that require auth skip tool checks)
  --json           Print the machine-readable report (schemaVersion 1) instead of text
  --timeout <ms>   Per-request timeout in milliseconds (default 10000)
  --no-browser     With --auth: print the authorization URL instead of opening a browser
  -h, --help       Show this help
  -v, --version    Show the version

Exit codes: 0 no errors, 1 at least one error, 2 usage error or tool failure.
`;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  if (args.length === 0) {
    return { command: 'error', message: 'Missing command. Try: kepcup-app validate <server.json>' };
  }
  if (args.includes('-h') || args.includes('--help')) return { command: 'help' };
  if (args.includes('-v') || args.includes('--version')) return { command: 'version' };
  const command = args.shift();
  if (command !== 'validate') {
    return { command: 'error', message: `Unknown command "${command ?? ''}".` };
  }
  const result: ValidateArgs = {
    command: 'validate',
    target: '',
    auth: false,
    json: false,
    noBrowser: false,
    timeoutMs: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--auth') result.auth = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '--no-browser') result.noBrowser = true;
    else if (arg === '--timeout' || arg.startsWith('--timeout=')) {
      const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      const value = raw === undefined ? NaN : Number(raw);
      if (!Number.isInteger(value) || value < 100 || value > 600_000) {
        return {
          command: 'error',
          message: '--timeout needs an integer number of milliseconds (100-600000).',
        };
      }
      result.timeoutMs = value;
    } else if (arg.startsWith('-')) {
      return { command: 'error', message: `Unknown option "${arg}".` };
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    return {
      command: 'error',
      message:
        positional.length === 0
          ? 'Missing the server.json path or URL.'
          : 'Exactly one server.json path or URL is expected.',
    };
  }
  result.target = positional[0] as string;
  return result;
}
