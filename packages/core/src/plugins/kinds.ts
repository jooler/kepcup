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
   * The FULL instance form field list for one plugin: kind built-ins first, then the
   * manifest's declared `instanceFields` (mail, P3). Non-instantiable kinds return [].
   * This is the single source shared by instance-value validation
   * (`PluginInstanceService`) and the `PluginSummary.instanceFields` safe projection.
   */
  instanceFields(manifest: PluginManifest): PluginField[];
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
    hasInstances: true,
    instanceFields: mailInstanceFields,
    hasContribution: (manifest) => manifest.contributions.mail.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: () => new MailProjector(),
  }),
] satisfies readonly CapabilityKindAdapter[];

/**
 * Mail instance form fields (P3, todo/plugin-platform P3-mail.md §3.1): the kind's
 * built-ins (address / username / password) come first; a GENERIC contribution
 * (hosts declared empty) appends the six endpoint fields as required per-instance
 * entries, a VENDOR one locks its endpoints (never form fields); the manifest's
 * `instanceFields` append last (dup / builtin-key clashes are rejected by the schema).
 * Titles are core-derived zh text — the same posture as every other core-derived
 * user-facing string (P1 review disposition P1-6).
 */
function mailInstanceFields(manifest: PluginManifest): PluginField[] {
  const contribution = manifest.contributions.mail[0];
  const fields: PluginField[] = [
    {
      key: 'address',
      type: 'string',
      title: '邮箱地址',
      description: '',
      required: true,
      sensitive: false,
      multiple: false,
    },
    {
      key: 'username',
      type: 'string',
      title: '登录用户名',
      description: '不填则使用邮箱地址',
      required: false,
      sensitive: false,
      multiple: false,
    },
    {
      key: 'password',
      type: 'string',
      title: '授权码',
      description: '在邮箱服务商设置里生成的授权码，不是网页登录密码',
      required: true,
      sensitive: true,
      multiple: false,
    },
  ];
  if (contribution !== undefined && contribution.imap.host === '') {
    fields.push(
      {
        key: 'imapHost',
        type: 'string',
        title: '收信（IMAP）服务器',
        description: '例如 imap.example.com',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'imapPort',
        type: 'number',
        title: 'IMAP 端口',
        description: '通常是 993',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'imapSecure',
        type: 'string',
        title: 'IMAP 加密方式',
        description: 'ssl 或 starttls，通常是 ssl',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'smtpHost',
        type: 'string',
        title: '发信（SMTP）服务器',
        description: '例如 smtp.example.com',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'smtpPort',
        type: 'number',
        title: 'SMTP 端口',
        description: '通常是 465',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'smtpSecure',
        type: 'string',
        title: 'SMTP 加密方式',
        description: 'ssl 或 starttls，通常是 ssl',
        required: true,
        sensitive: false,
        multiple: false,
      },
    );
  }
  fields.push(...(contribution?.instanceFields ?? []));
  return fields;
}

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
