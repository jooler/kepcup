import type { Check, ValidationReport } from './types.js';

/** Human-readable rendering of a report (the `--json` form is the report object itself). */

const LABEL: Record<Check['severity'], string> = {
  error: 'ERROR',
  warn: 'WARN ',
  info: 'ok   ',
};

export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];
  lines.push(`kepcup-app validate ${report.target}`);
  if (report.remote !== null) lines.push(`remote: ${report.remote}`);
  lines.push('');
  for (const check of report.checks) {
    const subject = check.subject !== undefined ? ` [${check.subject}]` : '';
    lines.push(`${LABEL[check.severity]} ${check.id}${subject}  ${check.message}`);
    if (check.severity !== 'info') {
      if (check.hint !== undefined) lines.push(`      hint: ${check.hint}`);
      lines.push(`      docs: README.md#${check.doc}`);
    }
  }
  const { errors, warnings, infos } = report.summary;
  lines.push('');
  lines.push(
    `${errors === 0 ? 'PASS' : 'FAIL'}: ${errors} error(s), ${warnings} warning(s), ${infos} passed/info.`,
  );
  return `${lines.join('\n')}\n`;
}
