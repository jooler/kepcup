import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Cards rendered inside a transcript must follow the session context. Reading
 * `chat.current` there would show the main chat inside a card dialog.
 * Main-shell surfaces (project chrome, the conversation list, the right
 * panel, TaskRunView) stay on `chat`.
 */
const files = [
  'SetupRequiredCard.svelte',
  'ConfirmLocalConnectorBody.svelte',
  '../settings-card/BotConfigCard.svelte',
  '../settings-card/BotModelCard.svelte',
  '../settings-card/ProjectLeadCard.svelte',
  '../settings-card/ProjectMembersCard.svelte',
];

describe('transcript cards follow the chat session', () => {
  it('does not read chat.current', () => {
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain('getChatSession');
      expect(source, file).not.toMatch(/chat\.current/);
    }
  });

  it('dismisses the session setup card, not the main chat facade', () => {
    for (const file of ['SetupRequiredCard.svelte', 'ConfirmLocalConnectorBody.svelte']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).toContain('session.dismissSetupCard()');
      expect(source, file).not.toContain('chat.dismissSetupCard');
    }
  });
});
