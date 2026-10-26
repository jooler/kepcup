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
  setEnabled(ctx: PluginProjectionContext, refs: readonly string[], enabled: boolean): Promise<void>;
  /**
   * Startup: rebuild runtime state for installed+enabled plugins (does not write the
   * ledger). Skills / MCP state lives in the DB / settings — no implementation needed.
   */
  activate?(ctx: PluginProjectionContext): Promise<void>;
  /** Refs whose content was deleted outside the app (`plugins.list`'s `missing` flag). */
  missing?(plugin: PluginIdentity, refs: readonly string[]): string[];
}

/** Fixed order: skills and MCP first, then connectors and mail; uninstall / rollback reverse it. */
export const PLUGIN_PROJECTOR_ORDER: readonly ProjectedKind[] = ['skill', 'mcp', 'connector', 'mail'];
