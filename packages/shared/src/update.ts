import { z } from 'zod';

/**
 * Auto-update status contract between the MAIN process and the RENDERER
 * (P13 任务 2). This is an ipcRenderer channel (`update:status`), not a core
 * RPC event: electron-updater lives in the main process, the core only feeds
 * the in-flight-run gate. Consumed by the P13-B update UI; the payload schema
 * lives here so both sides share one type.
 */
export const updateStatusPhaseSchema = z.enum([
  /** No update flow in progress (or checks are disabled). */
  'idle',
  /** Checking the feed for a newer version. */
  'checking',
  /** A newer version was found and is downloading in the background. */
  'downloading',
  /** Download finished; in-flight executions exist — waiting for them to drain. */
  'waiting-runs',
  /**
   * Download finished but executions did not drain within the wait budget.
   * The UI must now ask the user: keep waiting, or confirm an interrupt
   * (update.cancelActive) and install. Nothing installs automatically here.
   */
  'awaiting-user',
  /** Download finished and nothing is executing — restart installs the update. */
  'ready-to-install',
  /** quitAndInstall was invoked; the app is going down. */
  'installing',
  /** Feed unreachable or the updater errored (logged; silent for the user). */
  'error',
]);
export type UpdateStatusPhase = z.infer<typeof updateStatusPhaseSchema>;

export const updateStatusPayloadSchema = z.object({
  phase: updateStatusPhaseSchema,
  /** New version string once known (downloaded or in progress). */
  version: z.string().optional(),
  /** Number of in-flight executions while waiting (drives the UI copy). */
  activeRuns: z.number().int().nonnegative().optional(),
  /** Human-readable detail for 'error'; already localized for display. */
  message: z.string().optional(),
});
export type UpdateStatusPayload = z.infer<typeof updateStatusPayloadSchema>;
