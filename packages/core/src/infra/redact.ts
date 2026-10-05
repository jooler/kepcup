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

/**
 * 把请求 payload 中的 image 内容块替换为占位（run_steps.request 不落 base64，
 * docs/design/20-conversation-media.md）。「模型看到什么」仍完整：有占位即
 * 看到了图，mime 与体量保留。response loop 与 subagent 子 run 的步骤持久化共用。
 */
export function stripImageBlocks(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(stripImageBlocks);
  if (payload === null || typeof payload !== 'object') return payload;
  const record = payload as Record<string, unknown>;
  if (
    record['type'] === 'image' &&
    (typeof record['data'] === 'string' || typeof record['base64'] === 'string')
  ) {
    const data =
      typeof record['data'] === 'string'
        ? record['data']
        : typeof record['base64'] === 'string'
          ? record['base64']
          : '';
    return {
      type: 'image',
      ...(record['mimeType'] !== undefined ? { mimeType: record['mimeType'] } : {}),
      approxBytes: Math.round((data.length * 3) / 4),
      note: '[图片内容已省略：模型输入包含此图片]',
    };
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = stripImageBlocks(value);
  }
  return result;
}
