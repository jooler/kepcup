export interface ConversationSearchInput {
  title: string;
  summary: string;
  preview: string;
  hasHiddenMessages: boolean;
}

export interface ConversationSearchFields {
  texts: string[];
  preview: string;
}

export interface ConversationPreviewInput {
  preview: string;
  summary: string;
  hasHiddenMessages: boolean;
}

/**
 * The visible one-line preview for a conversation. A summary can contain hidden
 * originals, so it is never shown (nor searched) for a conversation that has
 * hidden messages; the accumulated last-message preview still wins when present.
 */
export function safeConversationPreview(input: ConversationPreviewInput): string {
  if (input.preview.length > 0) return input.preview;
  return input.hasHiddenMessages ? '' : input.summary;
}

/** A summary can contain hidden originals, so it is never searched or shown for that conversation. */
export function conversationSearchFields(input: ConversationSearchInput): ConversationSearchFields {
  const summary = input.hasHiddenMessages ? '' : input.summary;
  const preview = safeConversationPreview(input);
  return {
    texts: [input.title, preview, ...(summary.length > 0 && summary !== preview ? [summary] : [])],
    preview,
  };
}

export function matchesConversationSearch(input: ConversationSearchInput, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return false;
  return conversationSearchFields(input).texts.some((text) => text.toLowerCase().includes(normalized));
}
