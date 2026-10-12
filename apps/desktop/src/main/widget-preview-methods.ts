import type { WIDGET_PREVIEW_RPC_METHODS } from '@kepcup/shared';
import {
  widgetPreviewRunInputSchema,
  widgetPreviewRunOutputSchema,
  type RpcMethodSpec,
  type WidgetPreviewRunInput,
  type WidgetPreviewRunOutput,
} from '@kepcup/shared';

/**
 * Port B server side (D87 P3b): core's widget checker asks the main process to run a draft
 * widget in the hidden preview window (S2, docs/design/32-bot-widgets.md §11.9). Input and
 * output are validated by the RPC channel against the shared schemas; the host itself is
 * injected so tests need no Electron.
 *
 * The return type is keyed by the shared WIDGET_PREVIEW_RPC_METHODS registry (missing or
 * misspelled specs fail compilation).
 */
export function widgetPreviewMethodSpecs(host: {
  run(input: WidgetPreviewRunInput): Promise<WidgetPreviewRunOutput>;
}): Record<(typeof WIDGET_PREVIEW_RPC_METHODS)[number], RpcMethodSpec> {
  return {
    'widgetPreview.run': {
      input: widgetPreviewRunInputSchema,
      output: widgetPreviewRunOutputSchema,
      handle: (input) => host.run(input as WidgetPreviewRunInput),
    },
  };
}
