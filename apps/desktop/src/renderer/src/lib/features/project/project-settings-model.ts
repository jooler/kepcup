import { PROJECT_GOAL_MAX_CHARS, PROJECT_TITLE_MAX } from '@kepcup/shared';

/**
 * Pure save decisions for the project settings page title / goal fields
 * (D92 §11.3 overview). Both save on blur, so the rules must be exact:
 * trim first, never resubmit an unchanged value, an emptied title falls back
 * to the saved name, an emptied goal clears it (`null`). Inputs carry a
 * `maxlength`, the clamp below is belt and braces for programmatic drafts.
 */

export type TitleSaveAction =
  /** Same as the saved value — nothing to submit. */
  | { kind: 'skip' }
  /** The title was emptied — restore the saved name instead of submitting. */
  | { kind: 'restore' }
  /** Submit this name. */
  | { kind: 'save'; value: string };

export type GoalSaveAction =
  /** Same as the saved value — nothing to submit. */
  | { kind: 'skip' }
  /** Submit this value (`null` = clear the goal). */
  | { kind: 'save'; value: string | null };

export function planTitleSave(draft: string, current: string): TitleSaveAction {
  const next = draft.trim().slice(0, PROJECT_TITLE_MAX);
  if (next.length === 0) return { kind: 'restore' };
  if (next === current) return { kind: 'skip' };
  return { kind: 'save', value: next };
}

export function planGoalSave(draft: string, current: string | null): GoalSaveAction {
  const next = draft.trim().slice(0, PROJECT_GOAL_MAX_CHARS);
  if (next.length === 0) {
    return (current ?? '').length === 0 ? { kind: 'skip' } : { kind: 'save', value: null };
  }
  if (next === current) return { kind: 'skip' };
  return { kind: 'save', value: next };
}
