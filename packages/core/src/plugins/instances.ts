import {
  AppError,
  newId,
  type PluginField,
  type PluginFieldValue,
  type PluginInstanceKind,
  type PluginInstanceSummary,
} from '@kepcup/shared';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { SqliteDatabase } from '../infra/db.js';
import { capabilityKindOf } from './kinds.js';
import type { PluginRegistry } from './registry.js';
import type { PluginStore } from './store.js';

/**
 * Plugin instances (D105, todo/plugin-platform README §2.2 / §4.3): user-created
 * capability units (mailbox accounts first — mail lands P3). Non-sensitive values live
 * in `plugin_instances.config_json`, sensitive ones in secrets under
 * `plugin:{pluginId|/ → :}:instance:{instanceId}:{fieldKey}`. Every mutation runs on the
 * PluginRegistry's mutex (injected reference — never a second lock), and deletes tear
 * domain data down through the kind's registered materializer BEFORE the row goes.
 */

// --- secret naming --------------------------------------------------------------

/**
 * Secret names allow only `[a-z0-9:_-]`, plugin ids contain `/` and `.`: this escaping
 * (`_`→`__`, `.`→`_`, `/`→`:`) keeps the mapping injective and the names greppable.
 */
export function pluginSecretScope(pluginId: string): string {
  const encoded = pluginId.replaceAll('_', '__').replaceAll('.', '_').replace('/', ':');
  return `plugin:${encoded}`;
}

export function pluginConfigSecretName(pluginId: string, key: string): string {
  return `${pluginSecretScope(pluginId)}:config:${key}`;
}

export function pluginInstanceSecretName(
  pluginId: string,
  instanceId: string,
  key: string,
): string {
  return `${pluginSecretScope(pluginId)}:instance:${instanceId}:${key}`;
}

// --- field value validation -------------------------------------------------------

export interface SplitFieldValues {
  /** Non-sensitive values → config_json. */
  nonSensitive: Record<string, PluginFieldValue>;
  /** Sensitive values → secrets (serialized when not already strings). */
  sensitive: Record<string, string>;
}

function isEmptyValue(value: PluginFieldValue | undefined): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function checkScalar(field: PluginField, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length > 10_000) throw new AppError('INVALID_INPUT', `${field.title} 过长`);
    return;
  }
  if (typeof value === 'boolean') {
    if (field.type !== 'boolean') {
      throw new AppError('INVALID_INPUT', `${field.title} 只接受文本`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (field.type !== 'number') throw new AppError('INVALID_INPUT', `${field.title} 只接受数字`);
    if (field.min !== undefined && value < field.min) {
      throw new AppError('INVALID_INPUT', `${field.title} 不能小于 ${field.min}`);
    }
    if (field.max !== undefined && value > field.max) {
      throw new AppError('INVALID_INPUT', `${field.title} 不能大于 ${field.max}`);
    }
    return;
  }
  throw new AppError('INVALID_INPUT', `${field.title} 的值类型不合法`);
}

/**
 * Validates submitted values against declared fields and splits them. Semantics shared
 * by plugin config and instances: unknown keys are rejected; a sensitive field absent
 * from the submission keeps its stored secret (`hasStoredSecret`); a required field must
 * resolve to a submitted value, a declared default, or (sensitive) a stored secret.
 */
export function validatePluginFieldValues(
  fields: readonly PluginField[],
  submitted: Readonly<Record<string, PluginFieldValue>>,
  options: { hasStoredSecret: (key: string) => boolean },
): SplitFieldValues {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  for (const key of Object.keys(submitted)) {
    if (!byKey.has(key)) throw new AppError('INVALID_INPUT', `未声明的配置项：${key}`);
  }
  const split: SplitFieldValues = { nonSensitive: {}, sensitive: {} };
  for (const field of fields) {
    const raw = submitted[field.key];
    if (isEmptyValue(raw)) {
      const satisfied =
        !field.required ||
        !isEmptyValue(field.default) ||
        (field.sensitive && options.hasStoredSecret(field.key));
      if (!satisfied) {
        throw new AppError('INVALID_INPUT', `请填写必填配置项：${field.title}`);
      }
      continue;
    }
    if (field.multiple) {
      if (!Array.isArray(raw)) throw new AppError('INVALID_INPUT', `${field.title} 接受多个值`);
      for (const item of raw) checkScalar(field, item);
    } else {
      if (Array.isArray(raw)) throw new AppError('INVALID_INPUT', `${field.title} 只接受单个值`);
      checkScalar(field, raw);
    }
    if (field.sensitive) {
      split.sensitive[field.key] = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } else {
      split.nonSensitive[field.key] = raw as PluginFieldValue;
    }
  }
  return split;
}

// --- store ------------------------------------------------------------------------

export interface PluginInstanceRow {
  id: string;
  pluginId: string;
  kind: PluginInstanceKind;
  title: string;
  configJson: string;
  createdAt: number;
  updatedAt: number;
}

interface InstanceDbRow {
  id: string;
  plugin_id: string;
  kind: string;
  title: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

function instanceFromRow(row: InstanceDbRow): PluginInstanceRow {
  return {
    id: row.id,
    pluginId: row.plugin_id,
    kind: row.kind as PluginInstanceKind,
    title: row.title,
    configJson: row.config_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PluginInstanceStore {
  readonly #db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.#db = db;
  }

  list(pluginId: string): PluginInstanceRow[] {
    const rows = this.#db
      .prepare('select * from plugin_instances where plugin_id = ? order by created_at asc, id asc')
      .all(pluginId) as InstanceDbRow[];
    return rows.map(instanceFromRow);
  }

  get(id: string): PluginInstanceRow | null {
    const row = this.#db.prepare('select * from plugin_instances where id = ?').get(id) as
      | InstanceDbRow
      | undefined;
    return row === undefined ? null : instanceFromRow(row);
  }

  insert(row: PluginInstanceRow): void {
    this.#db
      .prepare(
        `insert into plugin_instances (id, plugin_id, kind, title, config_json, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.pluginId,
        row.kind,
        row.title,
        row.configJson,
        row.createdAt,
        row.updatedAt,
      );
  }

  update(id: string, patch: { title?: string; configJson?: string; updatedAt: number }): void {
    const columns: string[] = ['updated_at = ?'];
    const values: Array<string | number> = [patch.updatedAt];
    if (patch.title !== undefined) {
      columns.push('title = ?');
      values.push(patch.title);
    }
    if (patch.configJson !== undefined) {
      columns.push('config_json = ?');
      values.push(patch.configJson);
    }
    this.#db.prepare(`update plugin_instances set ${columns.join(', ')} where id = ?`).run(
      ...values,
      id,
    );
  }

  delete(id: string): void {
    this.#db.prepare('delete from plugin_instances where id = ?').run(id);
  }

  /** Live instance count per instantiable kind (drives `PluginSummary.instanceCounts`). */
  countsOf(pluginId: string): { mail: number; mcp: number } {
    const rows = this.#db
      .prepare(
        "select kind, count(*) as n from plugin_instances where plugin_id = ? and kind in ('mail','mcp') group by kind",
      )
      .all(pluginId) as Array<{ kind: string; n: number }>;
    const counts = { mail: 0, mcp: 0 };
    for (const row of rows) {
      if (row.kind === 'mail' || row.kind === 'mcp') counts[row.kind] = row.n;
    }
    return counts;
  }
}

// --- materializer -------------------------------------------------------------------

export interface InstanceMaterializerContext {
  pluginId: string;
  instanceId: string;
  kind: PluginInstanceKind;
  title: string;
  /** Submitted values (sensitive ones included — materializers land credentials). */
  values: Readonly<Record<string, PluginFieldValue>>;
}

export interface InstanceMaterializer {
  /** Land domain data for a NEW instance (the plugin_instances row already exists). */
  create(ctx: InstanceMaterializerContext): Promise<{ title?: string }>;
  /** Update domain data after an edit; may return a new title. */
  update(ctx: InstanceMaterializerContext): Promise<{ title?: string }>;
  /** Tear domain data down; MUST be idempotent (missing domain rows = success). */
  remove(ctx: { pluginId: string; instanceId: string; kind: PluginInstanceKind; title: string }): Promise<void>;
}

// --- service --------------------------------------------------------------------------

export interface PluginInstanceServiceDeps {
  registry: PluginRegistry;
  pluginStore: PluginStore;
  store: PluginInstanceStore;
  secrets: {
    hasValue(name: string): boolean;
    setValue(name: string, value: string): void;
    removeValue(name: string): void;
  };
  clock: Clock;
  logger: CoreLogger;
  events: { emit(name: 'plugins.changed', payload: { ids: string[] }): void };
  audit?: { recordSystem(action: string, detail: Record<string, unknown>): unknown } | undefined;
}

export class PluginInstanceService {
  readonly #deps: PluginInstanceServiceDeps;
  readonly #materializers = new Map<PluginInstanceKind, InstanceMaterializer>();

  constructor(deps: PluginInstanceServiceDeps) {
    this.#deps = deps;
  }

  /** One materializer per instantiable kind; mail lands P3, custom-mcp P4-M2. */
  registerMaterializer(kind: PluginInstanceKind, materializer: InstanceMaterializer): void {
    if (!capabilityKindOf(kind).hasInstances) {
      throw new AppError('PLUGIN_INVALID', `能力类型 ${kind} 不支持实例`);
    }
    this.#materializers.set(kind, materializer);
  }

  list(pluginId: string): PluginInstanceSummary[] {
    return this.#deps.store.list(pluginId).map((row) => this.#summaryOf(row));
  }

  create(
    pluginId: string,
    values: Readonly<Record<string, PluginFieldValue>>,
    kindHint?: PluginInstanceKind,
  ): Promise<PluginInstanceSummary> {
    return this.#deps.registry.runExclusive(() => this.#createLocked(pluginId, values, kindHint));
  }

  async #createLocked(
    pluginId: string,
    values: Readonly<Record<string, PluginFieldValue>>,
    kindHint: PluginInstanceKind | undefined,
  ): Promise<PluginInstanceSummary> {
    const { row, manifest } = await this.#pluginForInstances(pluginId);
    const kind = this.#resolveKind(manifest.instances ?? [], kindHint);
    const materializer = this.#materializerOf(kind);
    const fields = await this.#fieldsOf(pluginId, kind);
    const split = validatePluginFieldValues(fields, values, {
      hasStoredSecret: () => false,
    });
    const now = this.#deps.clock.now();
    const instanceId = newId('pli');
    this.#deps.store.insert({
      id: instanceId,
      pluginId,
      kind,
      title: row.id,
      configJson: JSON.stringify(split.nonSensitive),
      createdAt: now,
      updatedAt: now,
    });
    const instance = this.#deps.store.get(instanceId)!;
    try {
      const result = await materializer.create({
        pluginId,
        instanceId,
        kind,
        title: instance.title,
        values: { ...split.nonSensitive, ...split.sensitive },
      });
      if (result.title !== undefined && result.title !== instance.title) {
        this.#deps.store.update(instanceId, { title: result.title, updatedAt: now });
      }
    } catch (error) {
      // Compensate: no domain data, no row (a crash in between leaves the row for the
      // kind's materializer to reconcile — P3 adds that recovery).
      this.#deps.store.delete(instanceId);
      throw error;
    }
    this.#writeInstanceSecrets(pluginId, instanceId, split.sensitive);
    this.#deps.audit?.recordSystem('plugin_instance_create', { pluginId, instanceId, kind });
    this.#deps.events.emit('plugins.changed', { ids: [pluginId] });
    return this.#summaryOf(this.#deps.store.get(instanceId)!);
  }

  update(
    id: string,
    values: Readonly<Record<string, PluginFieldValue>>,
  ): Promise<PluginInstanceSummary> {
    return this.#deps.registry.runExclusive(() => this.#updateLocked(id, values));
  }

  async #updateLocked(
    id: string,
    values: Readonly<Record<string, PluginFieldValue>>,
  ): Promise<PluginInstanceSummary> {
    const instance = this.#deps.store.get(id);
    if (instance === null) throw new AppError('NOT_FOUND', `没有这个实例：${id}`);
    const manifest = await this.#deps.registry.manifestOf(instance.pluginId);
    if (manifest === null) {
      throw new AppError('PLUGIN_INVALID', '插件内容不可读，无法修改实例');
    }
    const fields = await this.#fieldsOf(instance.pluginId, instance.kind);
    const split = validatePluginFieldValues(fields, values, {
      hasStoredSecret: (key) =>
        this.#deps.secrets.hasValue(
          pluginInstanceSecretName(instance.pluginId, instance.id, key),
        ),
    });
    const merged = { ...this.#storedValues(instance), ...split.nonSensitive };
    const now = this.#deps.clock.now();
    this.#deps.store.update(id, { configJson: JSON.stringify(merged), updatedAt: now });
    const current = this.#deps.store.get(id)!;
    const materializer = this.#materializers.get(instance.kind);
    if (materializer !== undefined) {
      const result = await materializer.update({
        pluginId: instance.pluginId,
        instanceId: instance.id,
        kind: instance.kind,
        title: current.title,
        values: { ...merged, ...split.sensitive },
      });
      if (result.title !== undefined && result.title !== current.title) {
        this.#deps.store.update(id, { title: result.title, updatedAt: now });
      }
    }
    this.#writeInstanceSecrets(instance.pluginId, instance.id, split.sensitive);
    this.#deps.audit?.recordSystem('plugin_instance_update', {
      pluginId: instance.pluginId,
      instanceId: instance.id,
      kind: instance.kind,
    });
    this.#deps.events.emit('plugins.changed', { ids: [instance.pluginId] });
    return this.#summaryOf(this.#deps.store.get(id)!);
  }

  delete(id: string): Promise<void> {
    return this.#deps.registry.runExclusive(() => this.#deleteLocked(id, false));
  }

  async #deleteLocked(id: string, bestEffort: boolean): Promise<void> {
    const instance = this.#deps.store.get(id);
    if (instance === null) return;
    const materializer = this.#materializers.get(instance.kind);
    if (materializer !== undefined) {
      try {
        await materializer.remove({
          pluginId: instance.pluginId,
          instanceId: instance.id,
          kind: instance.kind,
          title: instance.title,
        });
      } catch (error) {
        // Direct deletes surface the failure (retryable); the uninstall cascade only
        // logs — uninstall must complete either way.
        if (!bestEffort) throw error;
        this.#deps.logger.warn(
          {
            pluginId: instance.pluginId,
            instanceId: instance.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'plugin instance teardown: materializer remove failed (continuing)',
        );
      }
    }
    this.#removeInstanceSecrets(instance.pluginId, instance.id, instance.kind);
    this.#deps.store.delete(instance.id);
    this.#deps.audit?.recordSystem('plugin_instance_delete', {
      pluginId: instance.pluginId,
      instanceId: instance.id,
      kind: instance.kind,
    });
    if (!bestEffort) this.#deps.events.emit('plugins.changed', { ids: [instance.pluginId] });
  }

  /**
   * Registry uninstall hook (README §2.2: 卸载 = 级联删除全部实例): materializer teardown
   * first (idempotent, best effort), then the rows; FK CASCADE covers the rest.
   */
  async deleteAllOf(pluginId: string): Promise<void> {
    const instances = this.#deps.store.list(pluginId);
    if (instances.length === 0) return;
    for (const instance of instances) {
      await this.#deleteLocked(instance.id, true);
    }
    this.#deps.events.emit('plugins.changed', { ids: [pluginId] });
  }

  // --- internals -----------------------------------------------------------------

  async #pluginForInstances(
    pluginId: string,
  ): Promise<{
    row: { id: string };
    manifest: NonNullable<Awaited<ReturnType<PluginRegistry['manifestOf']>>>;
  }> {
    const row = this.#deps.pluginStore.get(pluginId);
    if (row === null) throw new AppError('NOT_FOUND', `没有已安装的插件：${pluginId}`);
    if (row.state !== 'installed') {
      throw new AppError('INVALID_INPUT', `插件当前状态（${row.state}）不允许添加实例`);
    }
    if (!row.enabled) throw new AppError('INVALID_INPUT', '插件已停用，请先启用再添加实例');
    const manifest = await this.#deps.registry.manifestOf(pluginId);
    if (manifest === null) {
      throw new AppError('PLUGIN_INVALID', '插件内容不可读，无法管理实例');
    }
    return { row, manifest };
  }

  #resolveKind(declared: readonly PluginInstanceKind[], hint: PluginInstanceKind | undefined): PluginInstanceKind {
    if (declared.length === 0) {
      throw new AppError('INVALID_INPUT', '该插件没有声明可添加的实例能力');
    }
    const kind = hint ?? (declared.length === 1 ? declared[0]! : undefined);
    if (kind === undefined) {
      throw new AppError('INVALID_INPUT', '该插件提供多种实例能力，请指定类型');
    }
    if (!declared.includes(kind)) {
      throw new AppError('INVALID_INPUT', `该插件不提供 ${kind} 实例`);
    }
    return kind;
  }

  #materializerOf(kind: PluginInstanceKind): InstanceMaterializer {
    const adapter = capabilityKindOf(kind);
    if (!adapter.hasInstances) {
      throw new AppError('PLUGIN_INVALID', `能力类型 ${kind} 不支持实例`);
    }
    const materializer = this.#materializers.get(kind);
    if (materializer === undefined) {
      // P1: mail/mcp materializers land in P3 / P4-M2 — until then create stops here.
      throw new AppError('INVALID_INPUT', '该能力类型的实例创建尚未在本版本开放');
    }
    return materializer;
  }

  /** Kind built-in fields (manifest-declared instance fields append from P3 mail). */
  async #fieldsOf(pluginId: string, kind: PluginInstanceKind): Promise<PluginField[]> {
    void pluginId;
    return [...capabilityKindOf(kind).instanceFields()];
  }

  #storedValues(instance: PluginInstanceRow): Record<string, PluginFieldValue> {
    try {
      return JSON.parse(instance.configJson) as Record<string, PluginFieldValue>;
    } catch {
      return {};
    }
  }

  #writeInstanceSecrets(pluginId: string, instanceId: string, sensitive: Record<string, string>): void {
    for (const [key, value] of Object.entries(sensitive)) {
      this.#deps.secrets.setValue(pluginInstanceSecretName(pluginId, instanceId, key), value);
    }
  }

  #removeInstanceSecrets(pluginId: string, instanceId: string, kind: PluginInstanceKind): void {
    // Only declared field keys can have stored secrets; removeValue on a missing name is a no-op.
    const fields = capabilityKindOf(kind).instanceFields();
    for (const field of fields) {
      const name = pluginInstanceSecretName(pluginId, instanceId, field.key);
      if (this.#deps.secrets.hasValue(name)) this.#deps.secrets.removeValue(name);
    }
  }

  #summaryOf(instance: PluginInstanceRow): PluginInstanceSummary {
    const fields = capabilityKindOf(instance.kind).instanceFields();
    const storedSensitiveKeys = fields
      .filter((field) =>
        this.#deps.secrets.hasValue(
          pluginInstanceSecretName(instance.pluginId, instance.id, field.key),
        ),
      )
      .map((field) => field.key);
    return {
      id: instance.id,
      pluginId: instance.pluginId,
      kind: instance.kind,
      title: instance.title,
      values: this.#storedValues(instance),
      storedSensitiveKeys,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    };
  }
}
