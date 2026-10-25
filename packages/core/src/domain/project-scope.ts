/**
 * The project a conversation belongs to (D103 Q9).
 * `project` → its own id; `card` → `parentProjectId`; anything else → null.
 */
export function projectScopeOf(
  conversation:
    | {
        type: string;
        id: string;
        parentProjectId?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (conversation == null) return null;
  if (conversation.type === 'project') return conversation.id;
  if (conversation.type === 'card') {
    const parent = conversation.parentProjectId;
    return typeof parent === 'string' && parent.length > 0 ? parent : null;
  }
  return null;
}
