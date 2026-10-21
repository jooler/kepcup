import type { Settings } from '@kepcup/shared';

/** Profile `runtime.message_transport` for Bots that talk via the InkCop local bridge. */
export const INKCOP_LOCAL_TRANSPORT = 'inkcop-local' as const;

export function inkcopCollabEnabled(settings: Settings | null | undefined): boolean {
  return settings?.inkcopLocalCollab?.enabled === true;
}
