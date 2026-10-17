/**
 * New-project compose bar (ProjectComposeBar) pure logic: the candidate pool,
 * candidate filtering, the Enter decision, and the two-round selection state
 * transitions (round 1 picks the lead, round 2 picks the members). The
 * component has no DOM test environment, so every decision lives here and is
 * covered by unit tests; real interaction is e2e (rewritten in WP8).
 */

export interface ComposeCandidate {
  id: string;
  name: string;
}

export type ComposePhase = 'lead' | 'members';

export interface ComposeState {
  phase: ComposePhase;
  /** Round-1 pick. Lives outside `memberIds`; both are merged only at commit. */
  leadId: string | null;
  /** Round-2 picks. Does NOT include the lead. */
  memberIds: string[];
}

/**
 * Candidate pool: the roster without butlers (butlers never join a project).
 * `bots` must carry `systemRole`.
 */
export function composePool<T extends ComposeCandidate & { systemRole?: string | null }>(
  bots: readonly T[],
): T[] {
  return bots.filter((bot) => bot.systemRole == null);
}

/**
 * Candidates for the current round: drop `excludedIds` (the members round
 * excludes the lead and the chosen members; the lead round only excludes
 * butlers, which the pool already dropped), filter by case-insensitive
 * substring of the query, keep roster order.
 */
export function composeCandidates<T extends ComposeCandidate>(
  bots: readonly T[],
  excludedIds: readonly string[],
  query: string,
): T[] {
  const excluded = new Set(excludedIds);
  const needle = query.trim().toLowerCase();
  return bots.filter((bot) => {
    if (excluded.has(bot.id)) return false;
    return needle.length === 0 || bot.name.toLowerCase().includes(needle);
  });
}

export type ComposeEnterAction =
  /** Lead round: pick an existing Bot as the lead (arrow highlight or exact name). */
  | { kind: 'selectLead'; botId: string }
  /** Members round: add an existing Bot. */
  | { kind: 'add'; botId: string }
  /**
   * Members round: the typed name is the lead or a chosen member — never
   * create a duplicate-name Bot, just clear the input.
   */
  | { kind: 'alreadySelected'; botId: string }
  /** Create an empty-profile Bot named after the input (lead in round 1, member in round 2). */
  | { kind: 'create'; name: string }
  /** Members round, empty Enter with at least one valid member: create the project. */
  | { kind: 'commit' }
  /** Lead round, empty Enter: ask for a lead first. */
  | { kind: 'needLead' }
  /** Members round, empty Enter without a valid member: ask for members. */
  | { kind: 'needMembers' };

/**
 * What Enter does, per round:
 * 1. An arrow-highlighted candidate (highlight ≥ 0) wins over typed text —
 *    picked as lead in round 1, added in round 2;
 * 2. With input, a Bot whose name matches exactly (trimmed, case-insensitive)
 *    is picked; in round 2 "already picked" = members ∪ lead (no duplicate-name
 *    Bots); otherwise a new Bot is created;
 * 3. Empty input: round 1 asks for a lead; round 2 commits when at least one
 *    member is still in the pool (lead + members ≥ 2, matching projects.create).
 */
export function composeEnterAction(input: {
  phase: ComposePhase;
  query: string;
  /** The candidate pool (butlers already removed). */
  bots: readonly ComposeCandidate[];
  leadId: string | null;
  memberIds: readonly string[];
  /** The candidates for the current round (result of composeCandidates). */
  candidates: readonly ComposeCandidate[];
  /** Arrow-highlighted candidate index; -1 = no arrow selection. */
  highlight: number;
}): ComposeEnterAction {
  const picked = input.highlight >= 0 ? input.candidates[input.highlight] : undefined;
  if (picked !== undefined) {
    return input.phase === 'lead'
      ? { kind: 'selectLead', botId: picked.id }
      : { kind: 'add', botId: picked.id };
  }

  const text = input.query.trim();
  if (text.length > 0) {
    const needle = text.toLowerCase();
    const same = input.bots.filter((bot) => bot.name.trim().toLowerCase() === needle);
    if (input.phase === 'lead') {
      const lead = same[0];
      return lead !== undefined
        ? { kind: 'selectLead', botId: lead.id }
        : { kind: 'create', name: text };
    }
    const pickedIds = new Set(input.memberIds);
    if (input.leadId !== null) pickedIds.add(input.leadId);
    const unpicked = same.find((bot) => !pickedIds.has(bot.id));
    if (unpicked !== undefined) return { kind: 'add', botId: unpicked.id };
    const already = same.find((bot) => pickedIds.has(bot.id));
    if (already !== undefined) return { kind: 'alreadySelected', botId: already.id };
    return { kind: 'create', name: text };
  }

  if (input.phase === 'lead') return { kind: 'needLead' };
  const memberCount = input.memberIds.filter((id) =>
    input.bots.some((bot) => bot.id === id),
  ).length;
  return memberCount >= 1 ? { kind: 'commit' } : { kind: 'needMembers' };
}

/**
 * Round-1 pick: move to the members round. Picking a Bot that was already a
 * member promotes it to lead and removes it from `memberIds`.
 */
export function composeSelectLead(state: ComposeState, botId: string): ComposeState {
  return {
    phase: 'members',
    leadId: botId,
    memberIds: state.memberIds.filter((id) => id !== botId),
  };
}

/** Back to round 1 to re-pick the lead; the chosen members are kept. */
export function composeBackToLead(state: ComposeState): ComposeState {
  return { phase: 'lead', leadId: null, memberIds: state.memberIds };
}

/** Add a member; a no-op when the Bot is already the lead or a member. */
export function composeAddMember(state: ComposeState, botId: string): ComposeState {
  if (state.leadId === botId || state.memberIds.includes(botId)) return state;
  return { ...state, memberIds: [...state.memberIds, botId] };
}

/** Remove a member. */
export function composeRemoveMember(state: ComposeState, botId: string): ComposeState {
  return { ...state, memberIds: state.memberIds.filter((id) => id !== botId) };
}

/** Arrow-key highlight movement: -1 (none) ↔ 0 … length-1, no wrapping. */
export function stepHighlight(current: number, direction: 'up' | 'down', length: number): number {
  if (length === 0) return -1;
  if (direction === 'down') return Math.min(length - 1, current + 1);
  return Math.max(-1, Math.min(length - 1, current) - 1);
}
