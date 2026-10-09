import type { BROWSER_RPC_METHODS } from '@kepcup/shared';
import {
  browserActionOutputSchema,
  browserClickInputSchema,
  browserClearBotDataInputSchema,
  browserClearProfileDataInputSchema,
  browserCloseBotPagesInputSchema,
  browserCloseInputSchema,
  browserEnsurePageInputSchema,
  browserEnsurePageOutputSchema,
  browserFetchTextInputSchema,
  browserFetchTextOutputSchema,
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
      output: browserActionOutputSchema,
      handle: (input) => host.click(input as never),
    },
    'browser.type': {
      input: browserTypeInputSchema,
      output: browserActionOutputSchema,
      handle: (input) => host.type(input as never),
    },
    'browser.press': {
      input: browserPressInputSchema,
      output: browserActionOutputSchema,
      handle: (input) => host.press(input as never),
    },
    'browser.scroll': {
      input: browserScrollInputSchema,
      output: browserActionOutputSchema,
      handle: (input) => host.scroll(input as never),
    },
    'browser.screenshot': {
      input: browserPairInputSchema,
      output: browserScreenshotOutputSchema,
      handle: (input) => host.screenshot(input as never),
    },
    'browser.back': {
      input: browserPairInputSchema,
      output: browserActionOutputSchema,
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
    // W8 共享浏览器资料：profile switch / clear / delete.
    'browser.closeBotPages': {
      input: browserCloseBotPagesInputSchema,
      output: okOutputSchema,
      handle: (input) => Promise.resolve(host.closeBotPages(input as never)),
    },
    'browser.clearProfileData': {
      input: browserClearProfileDataInputSchema,
      output: okOutputSchema,
      handle: (input) => host.clearProfileData(input as never),
    },
    // W7 确定性监看：后台页取正文（不显示、取完即关）。
    'browser.fetchText': {
      input: browserFetchTextInputSchema,
      output: browserFetchTextOutputSchema,
      handle: (input) => host.fetchText(input as never),
    },
  };
}
