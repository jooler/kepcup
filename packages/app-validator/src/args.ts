/** Argument parsing for `kepcup-app` (no dependencies; exit code 2 on any usage error). */

export interface ValidateArgs {
  command: 'validate';
  target: string;
  auth: boolean;
  json: boolean;
  noBrowser: boolean;
  timeoutMs: number | undefined;
}

export interface InitPluginArgs {
  command: 'initPlugin';
  dir: string;
  id: string | null;
  name: string | null;
  force: boolean;
}

export interface PackPluginArgs {
  command: 'packPlugin';
  dir: string;
  out: string | null;
  json: boolean;
}

export type ParsedArgs =
  | ValidateArgs
  | InitPluginArgs
  | PackPluginArgs
  | { command: 'help' }
  | { command: 'version' }
  | { command: 'error'; message: string };

export const USAGE = `Usage: kepcup-app validate <server.json path | https URL | plugin directory | .kepcup file> [options]
       kepcup-app init plugin <directory> [--id <id>] [--name <name>] [--force]
       kepcup-app pack <directory> [--out <file>] [--json]

Validates a KepCup connector manifest (MCP Registry server.json plus
_meta["app.kepcup/connector"]) and the remote MCP server it points at, or a plugin
package (a directory with plugin.json, or a .kepcup archive) fully offline.

Commands:
  validate <target>      Connector mode for a server.json path / https URL; plugin
                         mode when <target> is a directory or ends with .kepcup
  init plugin <dir>      Write a minimal plugin skeleton into <dir>
  pack <dir>             Validate <dir>, then write a reproducible .kepcup archive

Options:
  --auth           Authorize once in a browser with KepCup's client identity, then
                   check the tools (without it, servers that require auth skip tool checks)
  --json           Print the machine-readable report (schemaVersion 1) instead of text
  --timeout <ms>   Per-request timeout in milliseconds (default 10000)
  --no-browser     With --auth: print the authorization URL instead of opening a browser
  --id <id>        With init: plugin id (default io.github.your-name/<directory name>)
  --name <name>    With init: display name (default: the directory name)
  --force          With init: write into a non-empty directory
  --out <file>     With pack: output path (default <id with / and @ replaced>-<version>.kepcup)
  -h, --help       Show this help
  -v, --version    Show the version

Exit codes: 0 no errors, 1 at least one error, 2 usage error or tool failure.
`;

function optionValue(
  args: readonly string[],
  index: number,
): { value: string | undefined; next: number } {
  const arg = args[index] as string;
  if (arg.includes('=')) return { value: arg.slice(arg.indexOf('=') + 1), next: index };
  return { value: args[index + 1], next: index + 1 };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const args = [...argv];
  if (args.length === 0) {
    return { command: 'error', message: 'Missing command. Try: kepcup-app validate <server.json>' };
  }
  if (args.includes('-h') || args.includes('--help')) return { command: 'help' };
  if (args.includes('-v') || args.includes('--version')) return { command: 'version' };
  const command = args.shift();
  if (command === 'init') return parseInitPlugin(args);
  if (command === 'pack') return parsePackPlugin(args);
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
      const { value: raw } = optionValue(args, i);
      if (!arg.includes('=')) i += 1;
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

function parseInitPlugin(args: string[]): ParsedArgs {
  const subcommand = args.shift();
  if (subcommand !== 'plugin') {
    return {
      command: 'error',
      message: `init needs the "plugin" subcommand (got "${subcommand ?? ''}").`,
    };
  }
  const result: InitPluginArgs = {
    command: 'initPlugin',
    dir: '',
    id: null,
    name: null,
    force: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--force') result.force = true;
    else if (arg === '--id' || arg.startsWith('--id=')) {
      const { value, next } = optionValue(args, i);
      if (value === undefined || value.length === 0) {
        return { command: 'error', message: '--id needs a plugin id.' };
      }
      result.id = value;
      i = next;
    } else if (arg === '--name' || arg.startsWith('--name=')) {
      const { value, next } = optionValue(args, i);
      if (value === undefined || value.length === 0) {
        return { command: 'error', message: '--name needs a display name.' };
      }
      result.name = value;
      i = next;
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
          ? 'Missing the plugin directory.'
          : 'Exactly one plugin directory is expected.',
    };
  }
  result.dir = positional[0] as string;
  return result;
}

function parsePackPlugin(args: string[]): ParsedArgs {
  const result: PackPluginArgs = { command: 'packPlugin', dir: '', out: null, json: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--json') result.json = true;
    else if (arg === '--out' || arg.startsWith('--out=')) {
      const { value, next } = optionValue(args, i);
      if (value === undefined || value.length === 0) {
        return { command: 'error', message: '--out needs a file path.' };
      }
      result.out = value;
      i = next;
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
          ? 'Missing the plugin directory.'
          : 'Exactly one plugin directory is expected.',
    };
  }
  result.dir = positional[0] as string;
  return result;
}
