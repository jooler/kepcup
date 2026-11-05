import type { LoopType } from '@kepcup/shared';
import { t, type MessageKey } from '$lib/i18n';

/** Loop-type display names shared by the composition card and the detail table. */
export const LOOP_KEYS: Record<LoopType, MessageKey> = {
  triage: 'usage.loop.triage',
  reflection: 'usage.loop.reflection',
  memory_consolidation: 'usage.loop.memory_consolidation',
  profile_curation: 'usage.loop.profile_curation',
  wiki_maintenance: 'usage.loop.wiki_maintenance',
  skill_authoring: 'usage.loop.skill_authoring',
  conversation_summary: 'usage.loop.conversation_summary',
  subagent: 'usage.loop.subagent',
  widget_authoring: 'usage.loop.widget_authoring',
  turn: 'usage.loop.turn',
  task: 'usage.loop.task',
  memory: 'usage.loop.memory',
  voice_input: 'usage.loop.voice_input',
  voice_reply: 'usage.loop.voice_reply',
  micro_app: 'usage.loop.micro_app',
};

export function loopLabel(loopType: LoopType): string {
  return t(LOOP_KEYS[loopType]);
}
