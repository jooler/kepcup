/**
 * Result model of `kepcup-app validate`. Every finding is a {@link Check}; passing checks are
 * reported as `info` so a report shows what was verified, not only what failed.
 */

export type Severity = 'error' | 'warn' | 'info';

export interface Check {
  /** Stable machine id, e.g. `tool.title` (documented in README.md). */
  id: string;
  severity: Severity;
  message: string;
  /** How to fix it (omitted for passing checks). */
  hint?: string | undefined;
  /** README anchor of the check (`id` with dots replaced by dashes). */
  doc: string;
  /** What the finding is about, e.g. the tool name. */
  subject?: string | undefined;
  /** Extra machine-readable facts (kept JSON-serialisable). */
  details?: unknown;
}

export interface CheckExtras {
  hint?: string | undefined;
  subject?: string | undefined;
  details?: unknown;
}

export function docAnchor(id: string): string {
  return id.replaceAll('.', '-');
}

export function makeCheck(
  id: string,
  severity: Severity,
  message: string,
  extras: CheckExtras = {},
): Check {
  return {
    id,
    severity,
    message,
    ...(extras.hint !== undefined ? { hint: extras.hint } : {}),
    doc: docAnchor(id),
    ...(extras.subject !== undefined ? { subject: extras.subject } : {}),
    ...(extras.details !== undefined ? { details: extras.details } : {}),
  };
}

export const REPORT_SCHEMA_VERSION = 1;

export interface ReportSummary {
  errors: number;
  warnings: number;
  infos: number;
}

/** Machine output of `--json` (schema version {@link REPORT_SCHEMA_VERSION}, documented in README.md). */
export interface ValidationReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  /** What was validated: the argument as given. */
  target: string;
  /** The MCP endpoint that was probed, if any. */
  remote: string | null;
  /** Whether `--auth` was requested. */
  auth: boolean;
  summary: ReportSummary;
  /** 0 = no errors, 1 = at least one error. */
  exitCode: 0 | 1;
  checks: Check[];
}

export function summarize(checks: readonly Check[]): ReportSummary {
  return {
    errors: checks.filter((c) => c.severity === 'error').length,
    warnings: checks.filter((c) => c.severity === 'warn').length,
    infos: checks.filter((c) => c.severity === 'info').length,
  };
}
