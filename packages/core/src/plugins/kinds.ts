import type {
  CapabilityModelEntry,
  PluginContributionKind,
  PluginConsentConnector,
  PluginConsentIm,
  PluginConsentMail,
  PluginConsentMcp,
  PluginConsentSkill,
  PluginField,
  PluginInstanceKind,
  PluginMcpContribution,
  PluginManifest,
} from '@kepcup/shared';
import {
  capabilityModelEntrySchema,
  mcpHeaderFieldKey,
  pluginConnectorContributionSchema,
  pluginImContributionSchema,
  pluginMailContributionSchema,
  pluginMcpContributionSchema,
  pluginSkillContributionSchema,
} from '@kepcup/shared';
import { MEDIA_ENGINES } from '../media/engines.js';
import type { ConsentItems } from './permissions.js';
import type {
  PluginProjector,
  PluginProjectorsDeps,
  ProjectedKind,
} from './projectors/index.js';
import { CapabilityModelsProjector } from './projectors/capability-models.js';
import { ConnectorsProjector } from './projectors/connectors.js';
import { ImProjector } from './projectors/im.js';
import { MailProjector } from './projectors/mail.js';
import { McpProjector } from './projectors/mcp.js';
import { SkillsProjector } from './projectors/skills.js';

import type { ZodType } from 'zod';

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
  | PluginConsentMail
  | PluginConsentIm
  | CapabilityModelEntry;

/**
 * Where this kind's items live in `ConsentItems` (plural keys of the fixed shared
 * contracts). `'capabilityModels'` exists only in ConsentItems — `PluginSummary['counts']`
 * keeps its five fixed keys (D124 entries surface via `plugins.listCapabilityEntries`,
 * not the plugin-card count badges).
 */
export type CapabilityConsentKey = 'skills' | 'connectors' | 'mcp' | 'mail' | 'im' | 'capabilityModels';

export interface CapabilityKindAdapter {
  readonly kind: ProjectedKind;
  /** Schema of ONE entry of the manifest's `contributions[kind]` array (shared source). */
  readonly contributionSchema: ZodType;
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
 * D124：能力模型条目 kind 适配器（60 号文档 §1/§2）——固定契约具名常量
 * （todo/capability-model-plugins/README.md「固定契约」），投影顺序末位，
 * 卸载 / 回滚反序。条目 = 纯数据声明，绑定第一方引擎（安装期
 * PLUGIN_ENGINE_UNKNOWN 校验）；实例 = 厂商账号（materializer 落地）。
 */
export const capabilityModelKind: CapabilityKindAdapter = defineCapabilityKind({
  kind: 'capability-model',
  contributionSchema: capabilityModelEntrySchema,
  consentKey: 'capabilityModels',
  hasInstances: true,
  instanceFields: capabilityModelInstanceFields,
  hasContribution: (manifest) => (manifest.contributions.capabilityModels ?? []).length > 0,
  consentItems: (inspection) => inspection.items as ConsentItem[],
  createProjector: () => new CapabilityModelsProjector(),
});

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
    hasInstances: true,
    instanceFields: mcpInstanceFields,
    hasContribution: (manifest) => manifest.contributions.mcp.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: (d) => new McpProjector(d.mcp),
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
  defineCapabilityKind({
    kind: 'im',
    contributionSchema: pluginImContributionSchema,
    consentKey: 'im',
    hasInstances: true,
    instanceFields: imInstanceFields,
    hasContribution: (manifest) => manifest.contributions.im.length > 0,
    consentItems: (inspection) => inspection.items as ConsentItem[],
    createProjector: () => new ImProjector(),
  }),
  capabilityModelKind,
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
        title: '收信服务器',
        description: '例如 imap.example.com',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'imapPort',
        type: 'number',
        title: '收信端口',
        description: '通常是 993',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'imapSecure',
        type: 'string',
        title: '收信加密方式',
        description: '填 ssl 或 starttls，通常 ssl',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'smtpHost',
        type: 'string',
        title: '发信服务器',
        description: '例如 smtp.example.com',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'smtpPort',
        type: 'number',
        title: '发信端口',
        description: '通常是 465',
        required: true,
        sensitive: false,
        multiple: false,
      },
      {
        key: 'smtpSecure',
        type: 'string',
        title: '发信加密方式',
        description: '填 ssl 或 starttls，通常 ssl',
        required: true,
        sensitive: false,
        multiple: false,
      },
    );
  }
  fields.push(...(contribution?.instanceFields ?? []));
  return fields;
}

/**
 * IM instance form fields (D107, 54 号文档 §2)：`qrcode` 建号（首发）没有表单——
 * token 走扫码确认（core 内存 pending → secrets），内置字段为空；`secret` 建号
 * （wecom-app 等后置插件）由清单声明 sensitive 字段作为密钥，内置 `bot_token`
 * 只为 secret 插件保留兜底。manifest 的 `instanceFields` 追加在后（schema 已查重
 * 并拒绝与内置键冲突）。
 */
function imInstanceFields(manifest: PluginManifest): PluginField[] {
  const contribution = manifest.contributions.im[0];
  const fields: PluginField[] = [];
  if (contribution !== undefined && contribution.setup === 'secret') {
    fields.push({
      key: 'bot_token',
      type: 'string',
      title: 'Bot 凭据',
      description: '由 IM 服务商颁发的 Bot 访问凭据',
      required: true,
      sensitive: true,
      multiple: false,
    });
  }
  fields.push(...(contribution?.instanceFields ?? []));
  return fields;
}

/**
 * MCP instance form fields (P4-M2): built-ins come first — `label` (optional display
 * name) plus the generic-template `url` (required, only when the http template declares
 * `url: ''`); each locked header template contributes a required sensitive value field
 * (header value never lives in the manifest); the manifest's `instanceFields` append
 * last (dup / builtin-key clashes are rejected by the schema). A manifest without
 * `instances: ['mcp']` has no instance form (fixed-projection contributions only).
 * Titles are core-derived zh text — the same posture as every other core-derived
 * user-facing string (P1 review disposition P1-6).
 */
function mcpInstanceFields(manifest: PluginManifest): PluginField[] {
  if (manifest.instances?.includes('mcp') !== true) return [];
  const contribution = manifest.contributions.mcp.find(
    (entry): entry is Extract<PluginMcpContribution, { kind: 'http' }> => entry.kind === 'http',
  );
  const fields: PluginField[] = [
    {
      key: 'label',
      type: 'string',
      title: '备注名',
      description: '选填，默认使用插件名',
      required: false,
      sensitive: false,
      multiple: false,
    },
  ];
  if (contribution === undefined || contribution.url === '') {
    fields.push({
      key: 'url',
      type: 'string',
      title: 'MCP 服务地址',
      description: 'https:// 开头的公网 MCP 端点地址',
      required: true,
      // A URL can itself be the credential (vendor plugins set `urlSensitive`).
      sensitive: contribution?.urlSensitive === true,
      multiple: false,
    });
  }
  for (const header of contribution?.headers ?? []) {
    fields.push({
      key: mcpHeaderFieldKey(header),
      type: 'string',
      title: header.name,
      // 声明了凭据方案（如 `scheme: 'bearer'`）的 header 由插件补前缀，用户只粘裸凭据。
      description:
        header.scheme === 'bearer'
          ? `${header.name} 请求头的值：粘贴服务商发放的 token 即可，Bearer 前缀由插件自动补`
          : `${header.name} 请求头的值，按服务商要求整值粘贴（要 Bearer 前缀就连前缀一起写，如 Bearer <token>）`,
      required: true,
      sensitive: true,
      multiple: false,
    });
  }
  fields.push(...(contribution?.instanceFields ?? []));
  return fields;
}

/**
 * Capability-model instance form fields (D124, 60 号文档 §2)：实例 = 厂商账号，
 * 凭据表单由引擎声明——该插件条目 `engine` 并集对应的 `MEDIA_ENGINES[engine].
 * credentialFields` 去重（保序：条目声明序；同名键以首个引擎的声明为准）。
 * 引擎在安装期已校验（PLUGIN_ENGINE_UNKNOWN），这里对未知引擎防御性跳过
 * （旧版本清单 / 手工构造的 manifest 不至于让实例表单崩溃）。
 */
function capabilityModelInstanceFields(manifest: PluginManifest): PluginField[] {
  const fields: PluginField[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.contributions.capabilityModels ?? []) {
    // D125 过渡：执行型条目不填 engine（61 §2），凭据表单由 PluginHost 接管（D125-P2），
    // 这里不贡献实例字段；数据型条目（有 engine）行为不变。
    if (entry.engine === undefined) continue;
    const engine = MEDIA_ENGINES[entry.engine];
    if (engine === undefined) continue;
    for (const field of engine.credentialFields) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  }
  return fields;
}

/**
 * Kind id → adapter. Accepts both the contribution kinds and the instance kinds
 * (D124: `'capability-model'` is an instance kind that is not a contribution kind of
 * the fixed five-kind union, yet carries a full adapter).
 */
export function capabilityKindOf(kind: PluginContributionKind | PluginInstanceKind): CapabilityKindAdapter {
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
    case 'im':
      items.im.push(...(values as PluginConsentIm[]));
      break;
    case 'capabilityModels':
      items.capabilityModels.push(...(values as CapabilityModelEntry[]));
      break;
  }
}
