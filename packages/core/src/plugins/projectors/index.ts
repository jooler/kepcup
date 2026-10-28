import type { McpbUserConfigValue, PluginConflict, PluginManifest } from '@kepcup/shared';
import type { PluginItemKind } from '@kepcup/shared';

/**
 * Plugin projectors (D104, docs/design/51-plugin-system.md §4): one projector per
 * contribution kind projects a plugin's contributions into the existing services
 * (skills / ConnectorCatalog / settings.mcpServers / mail templates). The registry
 * orchestrates them; the ledger (`plugin_items`) is written BEFORE each projected
 * item, and every `unproject` is idempotent so rollback / recovery can replay it.
 */

export type ProjectedKind = 'skill' | 'connector' | 'mcp' | 'mail';

export interface PluginIdentity {
  id: string;
  version: string;
  origin: 'marketplace' | 'local';
  tier: 'verified' | 'community' | 'developer';
}

/** Ledger handle bound to one plugin. Add before writing; unproject / rollback via the ledger. */
export interface PluginLedger {
  add(kind: PluginItemKind, ref: string): void;
  remove(kind: PluginItemKind, ref: string): void;
  list(kind: PluginItemKind): string[];
}

export interface PluginProjectionContext {
  plugin: PluginIdentity;
  manifest: PluginManifest;
  /** Absolute path of the extracted tree: staging dir on inspect, final dir on project / activate. */
  dir: string;
  /** Embedded MCPB user_config values, keyed by the mcp contribution id; install-time only. */
  userConfig: Readonly<Record<string, Record<string, McpbUserConfigValue>>>;
  ledger: PluginLedger;
  /**
   * Refs this plugin currently owns per kind (from the ledger); inspect conflict checks
   * EXCLUDE them — an update naturally collides with its own previous projection. Install
   * passes an empty set per kind.
   */
  owned: Readonly<Record<ProjectedKind, ReadonlySet<string>>>;
}

export interface ProjectorInspection<T> {
  items: T[];
  conflicts: PluginConflict[];
  blockers: string[];
}

export interface PluginProjector<T = unknown> {
  readonly kind: ProjectedKind;
  /**
   * Read-only, writes nothing. User-visible problems go into blockers / conflicts —
   * never thrown; only a programming error throws.
   */
  inspect(ctx: PluginProjectionContext): Promise<ProjectorInspection<T>>;
  /**
   * Writes. `ctx.ledger.add(kind, ref)` BEFORE each item. Throws on failure; the
   * registry rolls back through the ledger.
   */
  project(ctx: PluginProjectionContext): Promise<void>;
  /** Removes exactly `refs`. Must be idempotent (missing = success). */
  unproject(plugin: PluginIdentity, refs: readonly string[], ledger: PluginLedger): Promise<void>;
  /**
   * Hide / restore; does not touch the projected items in the ledger
   * (`disabled_connection` is the connectors projector's own bookkeeping).
   */
  setEnabled(
    ctx: PluginProjectionContext,
    refs: readonly string[],
    enabled: boolean,
  ): Promise<void>;
  /**
   * Startup: rebuild runtime state for installed+enabled plugins (does not write the
   * ledger). Skills / MCP state lives in the DB / settings — no implementation needed.
   */
  activate?(ctx: PluginProjectionContext): Promise<void>;
  /** Refs whose content was deleted outside the app (`plugins.list`'s `missing` flag). */
  missing?(plugin: PluginIdentity, refs: readonly string[]): string[];
  /**
   * Update (D104 P1-2): moves runtime state from the oldCtx version to the newCtx version,
   * keeping user state (enabled / policies / connections). Re-entrant: after a failure the
   * registry calls it again with the contexts swapped (unless `rollbackUpdate` exists).
   */
  update(oldCtx: PluginProjectionContext, newCtx: PluginProjectionContext): Promise<void>;
  /**
   * Records state a reverse `update` cannot reconstruct precisely (the MCP server list);
   * returns the string stored in `update_snapshot`, or null when compensation by reverse
   * `update` alone is exact.
   */
  beginUpdate?(plugin: PluginIdentity): Promise<string | null>;
  /** After the update committed: release the old version's leftovers (old package trees). */
  commitUpdate?(plugin: PluginIdentity, snapshot: string | null): Promise<void>;
  /**
   * Update failed / crash recovery: restore exactly `snapshot`. A projector implementing
   * this is NEVER compensated via a reverse `update`.
   */
  rollbackUpdate?(plugin: PluginIdentity, snapshot: string | null): Promise<void>;
}

/** Fixed order: derived from the capability kind registry (D105 `kinds.ts`); uninstall / rollback reverse it. */
export const PLUGIN_PROJECTOR_ORDER: readonly ProjectedKind[] = CAPABILITY_KINDS.map(
  (adapter) => adapter.kind,
);

/** The install-time context's `owned` (nothing projected yet). */
export function emptyOwned(): Readonly<Record<ProjectedKind, ReadonlySet<string>>> {
  return { skill: new Set(), connector: new Set(), mcp: new Set(), mail: new Set() };
}

// --- barrel -------------------------------------------------------------------
// The registry (kinds.ts) owns the concrete projector classes (runtime values); this
// barrel only re-exports the set / types. Projectors take types from here (erased at
// build time), so kinds.ts must never import this module at runtime — it doesn't.

import { CAPABILITY_KINDS } from '../kinds.js';

import type { ConnectorsProjectorDeps } from './connectors.js';
import type { MailProjectorDeps } from './mail.js';
import type { PluginMcpDeps } from './mcp.js';
import type { SkillsProjectorDeps } from './skills.js';

export type { ConnectorsProjectorDeps, MailProjectorDeps, PluginMcpDeps, SkillsProjectorDeps };

/** Dependencies for the registry-order projector set (`start.ts` wires them once). */
export interface PluginProjectorsDeps {
  skills: SkillsProjectorDeps;
  mcp: PluginMcpDeps;
  connectors: ConnectorsProjectorDeps;
  mail?: MailProjectorDeps | undefined;
}

/**
 * Builds one projector per registered capability kind, in {@link PLUGIN_PROJECTOR_ORDER}.
 * The coverage test derives from `CAPABILITY_KINDS`: a new contribution kind in
 * `pluginContributionKindSchema` without a registered adapter fails the test.
 */
export function createPluginProjectors(deps: PluginProjectorsDeps): readonly PluginProjector[] {
  return CAPABILITY_KINDS.map((adapter) => adapter.createProjector(deps));
}
