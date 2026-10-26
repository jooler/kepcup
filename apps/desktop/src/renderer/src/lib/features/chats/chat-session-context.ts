import { getContext, setContext } from 'svelte';
import { chat } from '$lib/stores/chat.svelte';
import type { ChatSession } from '$lib/stores/chat-session.svelte';

const CHAT_SESSION = Symbol('kepcup.chat-session');

/** Provide a conversation session to the subtree. The main view leaves this unset. */
export function setChatSession(session: ChatSession): void {
  setContext(CHAT_SESSION, session);
}

/**
 * The session for this component. Unset context is the main chat, so existing
 * call sites behave as they did before a dialog could host its own session.
 * Call during component init (Svelte context).
 */
export function getChatSession(): ChatSession {
  return getContext<ChatSession>(CHAT_SESSION) ?? chat.main;
}
