import type { SHELL_RPC_METHODS } from '@kepcup/shared';
import {
  shellOpenExternalInputSchema,
  shellOpenExternalOutputSchema,
  type RpcMethodSpec,
} from '@kepcup/shared';

/**
 * Port B server side (D73): core asks the main process to open an URL in the
 * system browser (OAuth consent page, docs/design/29-connected-apps.md §5.1).
 *
 * The main process is the last line of defence for what the shell is allowed
 * to launch: the URL is parsed with `new URL()` and only `https:` — or `http:`
 * to a loopback IP literal (`127.0.0.1` / `[::1]`, local dev servers and the
 * test fakes) — is opened. The OS call goes through Electron's
 * `shell.openExternal`, never through a shell command line, so the URL string
 * is not interpreted by a shell.
 *
 * The return type is keyed by the shared SHELL_RPC_METHODS registry (missing or
 * misspelled specs fail compilation).
 */

/** Whether `rawUrl` may be handed to the OS (exported for tests). */
export function isOpenableExternalUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  // Credentials in the URL have no business in an authorization page link.
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'https:') return url.hostname !== '';
  if (url.protocol === 'http:') {
    return url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  }
  return false;
}

export function shellMethodSpecs(
  /** Electron `shell.openExternal` (injected so tests need no Electron). */
  openExternal: (url: string) => Promise<void>,
): Record<(typeof SHELL_RPC_METHODS)[number], RpcMethodSpec> {
  return {
    'shell.openExternal': {
      input: shellOpenExternalInputSchema,
      output: shellOpenExternalOutputSchema,
      handle: async (input) => {
        const { url } = input as { url: string };
        if (!isOpenableExternalUrl(url)) return { ok: false };
        try {
          await openExternal(new URL(url).toString());
          return { ok: true };
        } catch {
          return { ok: false };
        }
      },
    },
  };
}
