import type { BROWSER_RPC_METHODS } from '@kepcup/shared';
import {
  browserClickInputSchema,
  browserClearBotDataInputSchema,
  browserCloseInputSchema,
  browserEnsurePageInputSchema,
  browserEnsurePageOutputSchema,
  browserNavigateInputSchema,
  browserNavigateOutputSchema,
  browserPairInputSchema,
  browserPressInputSchema,
  browserScreenshotOutputSchema,
  browserScrollInputSchema,
  browserSetNetworkContextInputSchema,
  browserSnapshotOutputSchema,
  browserTypeInputSchema,
  okOutputSchema,
  type RpcMethodSpec,
} from '@kepcup/shared';
import type { BrowserHost } from './browser-host';

/**
 * Port B server side (P11): the core service's browser tools call these over
 * the platform channel; the main process only provides the capability
 * (docs/dev/phases/P11-browser.md 注意事项 — 权限判断不在这里).
 *
 * The return type is keyed by the shared BROWSER_RPC_METHODS registry, so a
 * missing or misspelled spec fails compilation (contract registration check).
 */
export function browserMethodSpecs(
  host: BrowserHost,
): Record<(typeof BROWSER_RPC_METHODS)[number], RpcMethodSpec> {
  return {
    'browser.ensurePage': {
      input: browserEnsurePageInputSchema,
      output: browserEnsurePageOutputSchema,
      handle: (input) => Promise.resolve(host.ensurePage(input as never)),
    },
    'browser.navigate': {
      input: browserNavigateInputSchema,
      output: browserNavigateOutputSchema,
      handle: (input) => host.navigate(input as never),
    },
    'browser.snapshot': {
      input: browserPairInputSchema,
      output: browserSnapshotOutputSchema,
      handle: (input) => host.snapshot(input as never),
    },
    'browser.click': {
      input: browserClickInputSchema,
      output: okOutputSchema,
      handle: (input) => host.click(input as never),
    },
    'browser.type': {
      input: browserTypeInputSchema,
      output: okOutputSchema,
      handle: (input) => host.type(input as never),
    },
    'browser.press': {
      input: browserPressInputSchema,
      output: okOutputSchema,
      handle: (input) => host.press(input as never),
    },
    'browser.scroll': {
      input: browserScrollInputSchema,
      output: okOutputSchema,
      handle: (input) => host.scroll(input as never),
    },
    'browser.screenshot': {
      input: browserPairInputSchema,
      output: browserScreenshotOutputSchema,
      handle: (input) => host.screenshot(input as never),
    },
    'browser.back': {
      input: browserPairInputSchema,
      output: okOutputSchema,
      handle: (input) => host.back(input as never),
    },
    'browser.close': {
      input: browserCloseInputSchema,
      output: okOutputSchema,
      handle: (input) => host.close(input as never),
    },
    'browser.setNetworkContext': {
      input: browserSetNetworkContextInputSchema,
      output: okOutputSchema,
      handle: (input) => Promise.resolve(host.setNetworkContext(input as never)),
    },
    'browser.clearBotData': {
      input: browserClearBotDataInputSchema,
      output: okOutputSchema,
      handle: (input) => host.clearBotData(input as never),
    },
  };
}
