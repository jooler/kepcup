import type {
  PluginContributionKind,
  PluginConsentConnector,
  PluginConsentMail,
  PluginConsentMcp,
  PluginConsentSkill,
  PluginField,
  PluginManifest,
} from '@kepcup/shared';
import {
  pluginConnectorContributionSchema,
  pluginMailContributionSchema,
  pluginMcpContributionSchema,
  pluginSkillContributionSchema,
} from '@kepcup/shared';
import type { ConsentItems } from './permissions.js';
import type {
  PluginProjector,
  PluginProjectorsDeps,
  ProjectedKind,
} from './projectors/index.js';
import { ConnectorsProjector } from './projectors/connectors.js';
import { MailProjector } from './projectors/mail.js';
import { McpProjector } from './projectors/mcp.js';
import { SkillsProjector } from './projectors/skills.js';

/**
 * Capability kind registry (D105, todo/plugin-platform README §2.1): the single place a
 * contribution kind is described. Projector order, manifest contribution presence, the
 * consent-item mapping and summary count keys all DERIVE from {@link CAPABILITY_KINDS} —
 * adding a capability kind means registering one adapter here (plus the additive shared
 * schema fields), never editing the registry or the projectors barrel.
 *
 * Instance landing (`materializer`) is registered per-core on the PluginInstanceService
 * (`instances.ts#registerMaterializer`) — adapters only declare that instances exist
 * (`hasInstances`) and the kind's built-in form fields.
 */

/** One consent entry of any kind — the union the inspect output arrays hold. */
export type ConsentItem =
  | PluginConsentSkill
  | PluginConsentConnector
  | PluginConsentMcp
  | PluginConsentMail;

/** Where this kind's items live in `ConsentItems` / `PluginSummary['counts']` (plural keys of the fixed shared contracts). */
export type CapabilityConsentKey = 'skills' | 'connectors' | 'mcp' | 'mail';

export interface CapabilityKindAdapter {
  readonly kind: ProjectedKind;
  /** Schema of ONE entry of the manifest's `contributions[kind]` array (shared source). */
  readonly contributionSchema: import('zod').ZodType;
  /** Consent output / summary counts key (fixed shared contracts). */
  readonly consentKey: CapabilityConsentKey;
  /** Can users create instances of this kind on the plugin card? */
  readonly hasInstances: boolean;
  /**
   * Kind built-in instance form fields (NOT manifest-declared); a plugin's
   * `instanceFields` append after these. Mail's built-ins land with its materializer (P3).
   */
  instanceFields(): PluginField[];
  /** Manifest-level: does this manifest carry contributions of this kind? */
  hasContribution(manifest: PluginManifest): boolean;
  /**
   * Maps one projector inspection's items to this kind's consent entries (the projector
   * owns the file reads; the adapter owns what the consent card gets).
   */
  consentItems(inspection: { items: unknown }): ConsentItem[];
  /** The projection engine of this kind (one per registry wiring). */
  createProjector(deps: PluginProjectorsDeps): PluginProjector;
}

function defineCapabilityKind(adapter: CapabilityKindAdapter): CapabilityKindAdapter {
  return adapter;
}

/**
 * The registry, in projection order (skills and MCP first, then connectors and mail;
 * uninstall / rollback reverse it). Coverage tests derive from this array.
 */
export const CAPABILITY_KINDS: readonly CapabilityKindAdapter[] = [
  defineCapabilityKind({
    kind: 'skill',
    contributionSchema: pluginSkillContributionSchema,
    consentKey: 'skills',
    hasInstances: false,
    instanceFields: () => [],
    hasContribution: (manifest) => manifest.contributions.skills.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: (deps) => new SkillsProjector(deps.skills),
  }),
  defineCapabilityKind({
    kind: 'mcp',
    contributionSchema: pluginMcpContributionSchema,
    consentKey: 'mcp',
    hasInstances: false,
    instanceFields: () => [],
    hasContribution: (manifest) => manifest.contributions.mcp.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: (deps) => new McpProjector(deps.mcp),
  }),
  defineCapabilityKind({
    kind: 'connector',
    contributionSchema: pluginConnectorContributionSchema,
    consentKey: 'connectors',
    hasInstances: false,
    instanceFields: () => [],
    hasContribution: (manifest) => manifest.contributions.connectors.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: (deps) => new ConnectorsProjector(deps.connectors),
  }),
  defineCapabilityKind({
    kind: 'mail',
    contributionSchema: pluginMailContributionSchema,
    consentKey: 'mail',
    // P3 lands the materializer + built-in instance fields; the registry declares it now.
    hasInstances: true,
    instanceFields: () => [],
    hasContribution: (manifest) => manifest.contributions.mail.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: (deps) => new MailProjector(deps.mail ?? {}),
  }),
] satisfies readonly CapabilityKindAdapter[];

export function capabilityKindOf(kind: PluginContributionKind): CapabilityKindAdapter {
  const adapter = CAPABILITY_KINDS.find((candidate) => candidate.kind === kind);
  if (adapter === undefined) {
    throw new Error(`capability kind not registered: ${kind}`);
  }
  return adapter;
}

/** The single per-kind switch in the registry: where an inspection's items land. */
export function mergeConsentItems(
  items: ConsentItems,
  key: CapabilityConsentKey,
  values: readonly ConsentItem[],
): void {
  switch (key) {
    case 'skills':
      items.skills.push(...(values as PluginConsentSkill[]));
      break;
    case 'connectors':
      items.connectors.push(...(values as PluginConsentConnector[]));
      break;
    case 'mcp':
      items.mcp.push(...(values as PluginConsentMcp[]));
      break;
    case 'mail':
      items.mail.push(...(values as PluginConsentMail[]));
      break;
  }
}
