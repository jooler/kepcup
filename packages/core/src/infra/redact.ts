/**
 * Secret redaction for persisted structured payloads (run steps, audit
 * details). The payload is serialized so one `redact` pass covers every
 * string field; this was the orchestrator's private helper and is shared with
 * the background loops that persist run steps too (wiki maintenance BR-P09-001,
 * skill authoring — same invariant: nothing reaches runs.db unredacted).
 */
export function redactStepPayload(redact: (text: string) => string, payload: unknown): unknown {
  return JSON.parse(redact(JSON.stringify(payload))) as unknown;
}
