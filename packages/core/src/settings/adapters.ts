import {
  AppError,
  CAPABILITY_SETTING_IDS,
  VENDOR_DESCRIPTORS,
  chatModelOptions,
  isVendorId,
  sanitizeDisplayText,
  vendorsForCapability,
  webSearchProviderSchema,
  type AgentCatalogEntry,
  type CapabilityModelKey,
  type McpServer,
  type McpToolPolicy,
  type ProviderInfo,
  type Settings,
  type SettingFieldSpec,
  type SettingItem,
  type SettingItemStatus,
  type SettingOption,
  type SettingValues,
  type UnattendedState,
} from '@kepcup/shared';
import { homedir } from 'node:os';
import { providerSecretName } from '../agent/models.js';
import type { Bot } from '@kepcup/shared';

/**
 * 设置目录条目的 core 适配器（todo/conversational-app-setup.md §4.1）：读（脱敏后的当前状态）、
 * 写（调用设置页用的同一批 core 服务）、可选值、档位裁定要的两个判断（是否需要用户自填敏感
 * 字段、本次是不是放宽方向）。
 *
 * 约定：
 * - 读永不返回密钥、本机路径、用户画像原文；敏感字段只回「已配置 / 未配置」；用户自填的名称一律
 *   过 `sanitizeDisplayText`。
 * - 写只改本条目的字段：settings 里的整对象（capabilityModels / webSearch / agents /
 *   backgroundTasks / apps / providerConcurrency）一律在**最新**设置上按字段合并后写回，不发整对象；
 *   CAS（比对 `expected`）由 `SettingsCatalogHost` 在写锁里先做。
 * - 没有写入实现的条目（`write` 缺省）只能出卡 / 跳转，由用户在设置页完成。
 */

/** 条目作用对象（scope 决定哪个有意义）。 */
export interface SettingTargetRef {
  botId: string | null;
  conversationId: string | null;
  projectId: string | null;
}

/** 条目的当前状态（脱敏）。 */
export interface ItemSnapshot {
  status: SettingItemStatus;
  /** 非敏感字段的当前值；渲染层 / 只读条目为 null（core 看不到或没有值）。 */
  values: SettingValues | null;
  /** 敏感字段 → 是否已配置。 */
  secrets: Readonly<Record<string, boolean>>;
  /** 一句人话（≤ 80 字）：「已配置：阿里云百炼 · qwen-image」。 */
  summary: string;
}

/** 一次写入：非敏感字段的完整新值（已与当前值合并）+ 本次给出的敏感字段。 */
export interface ItemWrite {
  next: SettingValues;
  secrets: Readonly<Record<string, string>>;
}

/**
 * 写入的收尾（写锁之外做）：要一并补发 `settings.changed` 的条目，以及写之后的异步副作用
 * （中断任务、关闭浏览器页面）。写锁里只放同步的「读 → 比对 → 写」关键区。
 */
export interface ItemWriteEffects {
  changedItemIds?: readonly string[];
  /** 返回的字符串是各步的失败说明（宿主记日志）；抛出同样只记日志，不影响已完成的写入。 */
  afterUnlock?: () => Promise<readonly string[] | void> | readonly string[] | void;
}

export type NormalizeResult = { ok: true; values: SettingValues } | { ok: false; message: string };

export interface ItemAdapter {
  /**
   * `focus`：条目内「按键寻址」时的键（如 agents.external 的 `agent`）——有就读这一个键对应的值，
   * CAS 只比对它，兄弟键（别的智能体）的并发修改不算冲突。宿主传本次的建议值 / 期望值。
   */
  read(item: SettingItem, target: SettingTargetRef, focus?: SettingValues): ItemSnapshot;
  /** 动态可选值（`options` 不是 static 的字段）；缺省 = 没有可列的选项。 */
  options?(field: SettingFieldSpec, item: SettingItem, target: SettingTargetRef): SettingOption[];
  /** 校验并规范化 Bot / 卡片给的非敏感值（如模型引用补全厂商前缀）。缺省 = 原样接受。 */
  normalize?(item: SettingItem, values: SettingValues, target: SettingTargetRef): NormalizeResult;
  /**
   * 写入（在写锁内、CAS 之后调用；必须是同步的）。缺省 = 这一项不能由宿主写，只能出卡 / 跳转。
   * 返回的收尾由宿主在释放写锁之后执行。
   */
  write?(item: SettingItem, write: ItemWrite, target: SettingTargetRef): void | ItemWriteEffects;
  /**
   * 只用于 Bot 的提议（`settings_change`）：把 Bot 给的值整理成「建议值」——例如群成员只能加、
   * 不能借预填移除。用户在卡上亲手保存（`settings.items.apply`）不经过这里。
   */
  proposal?(item: SettingItem, values: SettingValues, snapshot: ItemSnapshot): SettingValues;
  /** 这次修改需要用户自填敏感字段（缺 Key、新厂商……）→ 至少 form。 */
  needsSensitiveInput?(item: SettingItem, proposed: SettingValues, snapshot: ItemSnapshot): boolean;
  /** 这次修改是不是放宽方向（只对带 `wideningMode` 的条目有意义）；缺省 = 未知（按放宽处理）。 */
  valuesWiden?(item: SettingItem, before: SettingValues | null, proposed: SettingValues): boolean;
}

/** 一条目录连接工具的当前策略（用户覆盖 + 有效结果）。`policy === null` 表示按风险档默认。 */
export interface CatalogToolPolicyView {
  policy: McpToolPolicy | null;
  enabled: boolean;
  approval: 'auto' | 'ask';
}

export interface AdapterDeps {
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  secrets: { hasValue(name: string): boolean; setValue(name: string, value: string): void };
  providers: { list(): ProviderInfo[]; setKey(provider: string, key: string): void };
  bots: {
    get(id: string): Bot | null;
    /** 群成员选项。缺省时卡片仍用通讯录，读适配器不列可选值。 */
    listActive?(): readonly Bot[];
  };
  /**
   * 写 Bot 配置的唯一入口：生产装配为 `applyBotProfileUpdate`（与 `bots.update` RPC 同一个函数：
   * 浏览器资料 / 外部智能体校验、`bot.updated`，写后中断任务与收回 MCP / 连接授权）。
   * 适配器不直接调 `bots.update`。
   */
  botProfiles: {
    apply(
      botId: string,
      profile: Bot['profile'],
    ): {
      bot: Bot;
      changedItemIds: readonly string[];
      /** 锁外收尾；返回各步的失败说明。 */
      settle(): Promise<readonly string[] | void>;
    };
  };
  /**
   * 已安装 MCP 服务变化后的撤销（与 `settings.update` 同一套 `mcpRevocationsBetween`）：停用正在
   * 用的服务会中断任务。缺省时 `mcp.servers` 不能由宿主写。
   */
  mcpServers?: {
    revokeChanges(previous: readonly McpServer[], next: readonly McpServer[]): void;
  };
  conversations?: {
    get(id: string): { title: string | null; type: string } | null;
    memberBotIds?(id: string): readonly string[];
  };
  /** 群名。与设置页 `groups.rename` 同一方法；缺省时不能由宿主写。 */
  groups?: {
    rename(conversationId: string, title: string): void;
  };
  /** 项目保护规则与端口（只读；写入留在项目设置组件）。 */
  projects?: {
    get(id: string): {
      /** 项目目录（只用于把规则里的绝对路径脱敏成 `<project>/…`，不进快照）。 */
      path?: string | null;
      protectRules: { denyRead: readonly string[]; denyWrite: readonly string[] };
      allowedPorts: ReadonlyArray<readonly [number, number]> | null;
    } | null;
  };
  /** 用户家目录（只用于脱敏：规则里的家目录路径显示成 `~/…`）；缺省取 `os.homedir()`。 */
  homeDir?: string;
  /**
   * 目录连接的逐工具策略（只读）。写入留在 `apps.connections.setToolPolicy`：
   * 那条 RPC 在策略变严时会中断正在使用该连接的任务，写锁里只调服务方法会丢掉这段。
   */
  appConnections?: {
    list(): ReadonlyArray<{ id: string; label: string }>;
    peekTool(connectionId: string, toolName: string): CatalogToolPolicyView | null;
  };
  unattended?: { effective(): UnattendedState; disable(reason?: string): UnattendedState };
  agentCatalog?: () => readonly AgentCatalogEntry[];
  /**
   * 本地向量来源。与设置页 `embedding.configure` 同一方法（重置维度并排队重建）；
   * 缺省时只写 `settings.embedding.source`。
   */
  embedding?: {
    configure(input: { source: 'local' | 'provider' }): void;
  };
  /**
   * 技能启停，与设置页 `skills.enable` / `skills.disable` 同一方法。`scope`：`private` = 这个 Bot
   * 自己的技能（bot_skills 行）；`public` = 公共技能（所有 Bot 共用，启停是全局的）。
   */
  skills?: {
    list(botId: string): ReadonlyArray<{ name: string; status: string; scope?: string }>;
    enable(botId: string, name: string): void;
    disable(botId: string, name: string): void;
  };
  /**
   * 工具链安装行与系统项检测（只读概要）。写入留在环境页和原来的安装审批；
   * 适配器只数状态，不把安装记录 id 放进快照。
   */
  environment?: {
    listInstalls(): ReadonlyArray<{ status: string }>;
    systemStatuses(): ReadonlyArray<{ available: boolean }>;
  };
  /**
   * 沙箱最近一次可用性（只读）。还没检测过为 null。
   * read 只读这个，不调用 `probe`，也不调用 `sandbox.wslPrepare`。
   */
  sandbox?: {
    lastAvailability(): { available: boolean } | null;
  };
  /**
   * 命令白名单（只读概要）。`allowlist.list` 是同步的。
   * 适配器只数启用和停用，不把条目 id 或命令模式放进快照。
   * 不提供 write：添加和启停留在组件，走原来的 `allowlist.add` / `allowlist.update`。
   */
  allowlist?: {
    list(): ReadonlyArray<{ enabled: boolean; builtin?: boolean }>;
  };
  /** Bot 改动后广播（bot.updated）/ 开机启动变化（platform.autostart）。 */
  publish(event: string, payload: unknown): void;
}

const SUMMARY_MAX = 80;
const NAME_MAX = 60;

function clean(text: string, max = NAME_MAX): string {
  return sanitizeDisplayText(text, max);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** 多值字段：数组，或模型写成的换行 / 逗号分隔字符串。 */
function asStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === 'string') return asStringList(value.split(/[\n,]/));
  return undefined;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

const NETWORK_RANK: Readonly<Record<string, number>> = { none: 0, allowlist: 1, open: 2 };
const PERMISSION_RANK: Readonly<Record<string, number>> = { read_only: 0, ask: 1, workspace: 2 };

function requireBot(deps: AdapterDeps, target: SettingTargetRef): Bot {
  const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
  if (bot === null) throw new AppError('NOT_FOUND', 'Bot 不存在');
  return bot;
}

/**
 * Bot runtime 的条目写入：在最新 Profile 上只改本条目的字段，经 `botProfiles.apply`（与
 * `bots.update` RPC 同一条路径）写入；写后的任务中断 / 授权收回交给宿主在锁外执行。
 */
function writeRuntime(
  deps: AdapterDeps,
  target: SettingTargetRef,
  patch: (runtime: Bot['profile']['runtime']) => Bot['profile']['runtime'],
): ItemWriteEffects {
  const bot = requireBot(deps, target);
  const update = deps.botProfiles.apply(bot.id, {
    ...bot.profile,
    runtime: patch(bot.profile.runtime),
  });
  return { changedItemIds: update.changedItemIds, afterUnlock: () => update.settle() };
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function snapshot(
  status: SettingItemStatus,
  values: SettingValues | null,
  summary: string,
  secrets: Record<string, boolean> = {},
): ItemSnapshot {
  return { status, values, secrets, summary: clean(summary, SUMMARY_MAX) };
}

function staticOptions(field: SettingFieldSpec): SettingOption[] {
  return field.options === 'static' ? [...(field.staticOptions ?? [])] : [];
}

/** 模型引用 → 展示名（「厂商 · 模型」）；不认得就原样（清洗后）。 */
export function modelRefLabel(ref: string, providers: readonly ProviderInfo[]): string {
  if (ref.length === 0) return '';
  const option = chatModelOptions(providers).find((entry) => entry.ref === ref);
  if (option !== undefined) return clean(option.label);
  const slash = ref.indexOf('/');
  if (slash > 0 && isVendorId(ref.slice(0, slash))) {
    return clean(
      `${VENDOR_DESCRIPTORS[ref.slice(0, slash) as keyof typeof VENDOR_DESCRIPTORS].name} · ${ref.slice(slash + 1)}`,
    );
  }
  return clean(ref);
}

// --- 对话模型（默认主 / 轻量、组件审查、本 Bot 的模型）-------------------------------

/** 模型引用的厂商部分没有 Key（或厂商不存在）→ 需要用户先接入厂商（form）。 */
function modelNeedsKey(ref: string, providers: readonly ProviderInfo[]): boolean {
  if (ref.length === 0) return false;
  const slash = ref.indexOf('/');
  if (slash <= 0) return true;
  const provider = providers.find((entry) => entry.id === ref.slice(0, slash));
  return provider === undefined || !provider.hasKey;
}

function normalizeChatModel(
  values: SettingValues,
  providers: readonly ProviderInfo[],
  allowEmpty: boolean,
): NormalizeResult {
  if (!('model' in values)) return { ok: true, values };
  const ref = str(values.model);
  if (ref === undefined) return { ok: false, message: 'model 应为「厂商/模型」形式的字符串' };
  if (ref.length === 0) {
    return allowEmpty
      ? { ok: true, values: { ...values, model: '' } }
      : { ok: false, message: 'model 不能为空' };
  }
  // 只给了模型 id：在已登记的模型里找唯一匹配。
  if (!ref.includes('/')) {
    const matches = providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.id === ref)
        .map((model) => `${provider.id}/${model.id}`),
    );
    if (matches.length === 1) return { ok: true, values: { ...values, model: matches[0]! } };
    return {
      ok: false,
      message: `找不到唯一的模型「${clean(ref)}」：请用 settings_read 给出的可选值（「厂商/模型」形式）`,
    };
  }
  const slash = ref.indexOf('/');
  const provider = providers.find((entry) => entry.id === ref.slice(0, slash));
  if (provider === undefined) {
    return {
      ok: false,
      message: `没有厂商「${clean(ref.slice(0, slash))}」：要接入新厂商请改 models.provider`,
    };
  }
  if (!provider.models.some((model) => model.id === ref.slice(slash + 1))) {
    return {
      ok: false,
      message: `厂商「${clean(provider.name)}」下没有模型「${clean(ref.slice(slash + 1))}」：请用 settings_read 给出的可选值`,
    };
  }
  return { ok: true, values: { ...values, model: ref } };
}

function chatModelOptionsOf(deps: AdapterDeps): SettingOption[] {
  return chatModelOptions(deps.providers.list()).map((option) => ({
    value: option.ref,
    label: clean(option.label),
  }));
}

/** settings 里一个对话模型字段（defaultMainModel / defaultLightModel / widgetReviewModel）。 */
function settingsModelAdapter(
  deps: AdapterDeps,
  key: 'defaultMainModel' | 'defaultLightModel' | 'widgetReviewModel',
  emptyMeaning: string | null,
): ItemAdapter {
  return {
    read: () => {
      const ref = deps.settings.get()[key];
      const providers = deps.providers.list();
      if (ref.length === 0) {
        return snapshot(
          emptyMeaning !== null ? 'configured' : 'unconfigured',
          { model: '' },
          emptyMeaning ?? '未配置',
        );
      }
      const label = modelRefLabel(ref, providers);
      return modelNeedsKey(ref, providers)
        ? snapshot('partial', { model: ref }, `${label}（厂商缺 Key）`)
        : snapshot('configured', { model: ref }, label);
    },
    options: (field) => (field.type === 'model' ? chatModelOptionsOf(deps) : staticOptions(field)),
    normalize: (_item, values) =>
      normalizeChatModel(values, deps.providers.list(), emptyMeaning !== null),
    write: (_item, { next }) => {
      const ref = str(next.model) ?? '';
      deps.settings.update({ [key]: ref } as Partial<Settings>);
    },
    needsSensitiveInput: (_item, proposed) =>
      modelNeedsKey(str(proposed.model) ?? '', deps.providers.list()),
  };
}

/** 本 Bot 的主 / 轻量模型（runtime.model / runtime.light_model；'' = 跟随默认）。 */
function botModelAdapter(deps: AdapterDeps, key: 'model' | 'light_model'): ItemAdapter {
  return {
    read: (_item, target) => {
      const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
      if (bot === null) return snapshot('unknown', null, 'Bot 不存在');
      const ref = bot.profile.runtime[key];
      const providers = deps.providers.list();
      if (ref.length === 0) {
        return snapshot(
          'configured',
          { model: '' },
          key === 'model' ? '跟随默认主模型' : '跟随默认轻量模型',
        );
      }
      const label = modelRefLabel(ref, providers);
      return modelNeedsKey(ref, providers)
        ? snapshot('partial', { model: ref }, `${label}（厂商缺 Key）`)
        : snapshot('configured', { model: ref }, label);
    },
    options: (field) => (field.type === 'model' ? chatModelOptionsOf(deps) : staticOptions(field)),
    normalize: (_item, values) => normalizeChatModel(values, deps.providers.list(), true),
    write: (_item, { next }, target) =>
      writeRuntime(deps, target, (runtime) => ({ ...runtime, [key]: str(next.model) ?? '' })),
    needsSensitiveInput: (_item, proposed) =>
      modelNeedsKey(str(proposed.model) ?? '', deps.providers.list()),
  };
}

// --- 能力模型（capabilityModels.{能力}）-------------------------------------------

function capabilityOf(item: SettingItem): CapabilityModelKey | null {
  const entry = Object.entries(CAPABILITY_SETTING_IDS).find(([, id]) => id === item.id);
  return entry === undefined ? null : (entry[0] as CapabilityModelKey);
}

function capabilityAdapter(deps: AdapterDeps): ItemAdapter {
  const keyed = (vendor: string): boolean =>
    vendor.length > 0 && deps.secrets.hasValue(providerSecretName(vendor));
  return {
    read: (item) => {
      const capability = capabilityOf(item)!;
      const config = deps.settings.get().capabilityModels[capability];
      if (config === null) {
        return snapshot('unconfigured', { provider: '', model: '' }, '未配置', { apiKey: false });
      }
      const hasKey = keyed(config.vendor);
      const label = `${VENDOR_DESCRIPTORS[config.vendor].name} · ${config.model}`;
      return snapshot(
        hasKey ? 'configured' : 'partial',
        { provider: config.vendor, model: `${config.vendor}/${config.model}` },
        hasKey ? label : `${label}（缺 API Key）`,
        { apiKey: hasKey },
      );
    },
    options: (field, item) => {
      const capability = capabilityOf(item)!;
      const vendors = vendorsForCapability(capability);
      if (field.name === 'provider') {
        return vendors.map((vendor) => ({
          value: vendor.id,
          label: `${vendor.name}${keyed(vendor.id) ? '' : '（未配 Key）'}`,
        }));
      }
      if (field.name === 'model') {
        // 已有 Key 的厂商排前面。
        const ordered = [...vendors].sort((a, b) => Number(keyed(b.id)) - Number(keyed(a.id)));
        return ordered.flatMap((vendor) =>
          vendor.presets[capability].map((model) => ({
            value: `${vendor.id}/${model}`,
            label: `${vendor.name} · ${model}`,
          })),
        );
      }
      return [];
    },
    normalize: (item, values) => {
      const capability = capabilityOf(item)!;
      const current = deps.settings.get().capabilityModels[capability];
      let provider = str(values.provider);
      let model = str(values.model);
      if (model !== undefined && model.includes('/')) {
        const prefix = model.slice(0, model.indexOf('/'));
        if (provider !== undefined && provider.length > 0 && provider !== prefix) {
          return { ok: false, message: 'provider 与 model 的厂商前缀不一致' };
        }
        provider = prefix;
        model = model.slice(model.indexOf('/') + 1);
      }
      if (provider === undefined && model === undefined) return { ok: true, values };
      provider ??= current?.vendor ?? '';
      if (
        !isVendorId(provider) ||
        !VENDOR_DESCRIPTORS[provider].capabilities.includes(capability)
      ) {
        return {
          ok: false,
          message: `厂商「${clean(provider)}」不支持这项能力：可选 ${vendorsForCapability(
            capability,
          )
            .map((vendor) => vendor.id)
            .join(' / ')}`,
        };
      }
      model ??=
        current?.vendor === provider
          ? current.model
          : (VENDOR_DESCRIPTORS[provider].presets[capability][0] ?? '');
      if (model.length === 0) return { ok: false, message: 'model 不能为空' };
      return { ok: true, values: { ...values, provider, model: `${provider}/${model}` } };
    },
    write: (item, { next, secrets }) => {
      const capability = capabilityOf(item)!;
      const vendor = str(next.provider) ?? '';
      const ref = str(next.model) ?? '';
      const model = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
      if (!isVendorId(vendor) || model.length === 0) {
        throw new AppError('INVALID_INPUT', '需要选择厂商与模型');
      }
      const apiKey = str(secrets.apiKey);
      if (apiKey !== undefined && apiKey.length > 0) deps.providers.setKey(vendor, apiKey);
      // 只改这一项能力：在最新设置上合并（兄弟能力的并发修改不被覆盖）。
      const latest = deps.settings.get().capabilityModels;
      deps.settings.update({ capabilityModels: { ...latest, [capability]: { vendor, model } } });
    },
    needsSensitiveInput: (item, proposed, current) => {
      const vendor = str(proposed.provider) ?? str(current.values?.provider) ?? '';
      return vendor.length === 0 || !keyed(vendor);
    },
  };
}

// --- 联网检索 ---------------------------------------------------------------------

function webSearchAdapter(deps: AdapterDeps): ItemAdapter {
  const keyed = (provider: string): boolean =>
    provider.length > 0 && deps.secrets.hasValue(`websearch:${provider}`);
  return {
    read: () => {
      const provider = deps.settings.get().webSearch.provider;
      if (provider === null) {
        return snapshot('unconfigured', { provider: '' }, '未配置', { apiKey: false });
      }
      const hasKey = keyed(provider);
      return snapshot(
        hasKey ? 'configured' : 'partial',
        { provider },
        hasKey ? provider : `${provider}（缺 API Key）`,
        { apiKey: hasKey },
      );
    },
    options: (field) =>
      field.name === 'provider'
        ? webSearchProviderSchema.options.map((provider) => ({
            value: provider,
            label: `${provider}${keyed(provider) ? '' : '（未配 Key）'}`,
          }))
        : [],
    normalize: (_item, values) => {
      const provider = str(values.provider);
      if (provider === undefined) return { ok: true, values };
      return webSearchProviderSchema.safeParse(provider).success
        ? { ok: true, values: { ...values, provider } }
        : { ok: false, message: `检索供应商只能是 ${webSearchProviderSchema.options.join(' / ')}` };
    },
    write: (_item, { next, secrets }) => {
      const parsed = webSearchProviderSchema.safeParse(str(next.provider));
      if (!parsed.success) throw new AppError('INVALID_INPUT', '需要选择检索供应商');
      const apiKey = str(secrets.apiKey);
      if (apiKey !== undefined && apiKey.length > 0) {
        deps.secrets.setValue(`websearch:${parsed.data}`, apiKey);
      }
      const latest = deps.settings.get().webSearch;
      deps.settings.update({ webSearch: { ...latest, provider: parsed.data } });
    },
    needsSensitiveInput: (_item, proposed, current) =>
      !keyed(str(proposed.provider) ?? str(current.values?.provider) ?? ''),
  };
}

// --- 厂商与 Key -------------------------------------------------------------------

function providerKeyAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const providers = deps.providers.list();
      const keyedNames = providers
        .filter((provider) => provider.hasKey)
        .map((p) => clean(p.name, 30));
      return keyedNames.length > 0
        ? snapshot('configured', { provider: '' }, `已接入：${keyedNames.join('、')}`, {
            apiKey: true,
          })
        : snapshot('unconfigured', { provider: '' }, '还没有接入任何模型厂商', { apiKey: false });
    },
    options: (field) =>
      field.name === 'provider'
        ? [
            ...Object.values(VENDOR_DESCRIPTORS).map((vendor) => ({
              value: vendor.id,
              label: vendor.name,
            })),
            ...deps.providers
              .list()
              .filter((provider) => !isVendorId(provider.id))
              .map((provider) => ({ value: provider.id, label: clean(provider.name) })),
          ].filter(
            (option, index, all) =>
              all.findIndex((other) => other.value === option.value) === index,
          )
        : [],
    write: (_item, { next, secrets }) => {
      const provider = str(next.provider) ?? '';
      const apiKey = str(secrets.apiKey) ?? '';
      if (provider.length === 0 || apiKey.length === 0) {
        throw new AppError('INVALID_INPUT', '需要选择厂商并填写 API Key');
      }
      deps.providers.setKey(provider, apiKey);
      // 国内厂商：确保有一条厂商配置（对话模型由设置页 / 卡片另行登记）。
      if (isVendorId(provider)) {
        const latest = deps.settings.get().vendorProviders;
        if (!latest.some((entry) => entry.id === provider)) {
          deps.settings.update({ vendorProviders: [...latest, { id: provider, models: [] }] });
        }
      }
    },
    needsSensitiveInput: () => true,
  };
}

// --- 其他 settings 字段 -----------------------------------------------------------

function launchAtLoginAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const enabled = deps.settings.get().launchAtLogin;
      return snapshot('configured', { enabled }, enabled ? '已开启' : '已关闭');
    },
    normalize: (_item, values) =>
      'enabled' in values && bool(values.enabled) === undefined
        ? { ok: false, message: 'enabled 应为 true / false' }
        : { ok: true, values },
    write: (_item, { next }) => {
      const enabled = bool(next.enabled) ?? true;
      const previous = deps.settings.get().launchAtLogin;
      deps.settings.update({ launchAtLogin: enabled });
      if (previous !== enabled) deps.publish('platform.autostart', { enabled });
    },
  };
}

function backgroundTasksAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const settings = deps.settings.get();
      const agentEnabled = settings.backgroundTasks.agentEnabled;
      const agent = settings.backgroundAgentId ?? '';
      return snapshot(
        'configured',
        { agentEnabled, agent },
        agentEnabled
          ? `无内置模型时改用外部智能体${agent.length > 0 ? `（${clean(agent, 30)}）` : '（自动）'}`
          : '不改用外部智能体',
      );
    },
    options: (field) =>
      field.options === 'agents'
        ? (deps.agentCatalog?.() ?? []).map((entry) => ({
            value: entry.id,
            label: clean(entry.name),
          }))
        : staticOptions(field),
    normalize: (_item, values) => {
      const agent = str(values.agent);
      if (agent === undefined || agent.length === 0) return { ok: true, values };
      return (deps.agentCatalog?.() ?? []).some((entry) => entry.id === agent)
        ? { ok: true, values: { ...values, agent } }
        : { ok: false, message: `智能体「${clean(agent)}」不在目录中` };
    },
    write: (_item, { next }) => {
      const latest = deps.settings.get();
      deps.settings.update({
        backgroundTasks: {
          ...latest.backgroundTasks,
          agentEnabled: bool(next.agentEnabled) ?? latest.backgroundTasks.agentEnabled,
        },
        backgroundAgentId: str(next.agent) ?? latest.backgroundAgentId ?? '',
      });
    },
  };
}

function budgetAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const tokens = deps.settings.get().backgroundBudgetTokens;
      return snapshot('configured', { tokens }, tokens === 0 ? '不限' : `每天 ${tokens} tokens`);
    },
    normalize: (_item, values) => {
      if (!('tokens' in values)) return { ok: true, values };
      const tokens = values.tokens;
      return typeof tokens === 'number' && Number.isInteger(tokens) && tokens >= 0
        ? { ok: true, values }
        : { ok: false, message: 'tokens 应为非负整数（0 = 不限）' };
    },
    write: (_item, { next }) => {
      const tokens = next.tokens;
      if (typeof tokens !== 'number') throw new AppError('INVALID_INPUT', '需要填写每日上限');
      deps.settings.update({ backgroundBudgetTokens: tokens });
    },
  };
}

function agentsDefaultAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const agent = deps.settings.get().defaultAgentId;
      return agent.length > 0
        ? snapshot('configured', { agent }, clean(agent, 40))
        : snapshot('unconfigured', { agent: '' }, '未设置');
    },
    options: () =>
      (deps.agentCatalog?.() ?? []).map((entry) => ({ value: entry.id, label: clean(entry.name) })),
    normalize: (_item, values) => {
      const agent = str(values.agent);
      if (agent === undefined || agent.length === 0) return { ok: true, values };
      return (deps.agentCatalog?.() ?? []).some((entry) => entry.id === agent)
        ? { ok: true, values }
        : { ok: false, message: `智能体「${clean(agent)}」不在目录中` };
    },
    write: (_item, { next }) => {
      deps.settings.update({ defaultAgentId: str(next.agent) ?? '' });
    },
  };
}

function externalAgentsAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    // 按智能体寻址（focus.agent）：值是「这一个智能体是否启用」；概况列出全部已启用的。
    // 不给 focus 时值是「已启用的全部智能体」（排序后以逗号连接），CAS 覆盖整个集合。
    read: (_item, _target, focus) => {
      const agents = deps.settings.get().agents;
      const enabled = Object.entries(agents)
        .filter(([, value]) => value.enabled)
        .map(([id]) => id)
        .sort();
      const summary =
        enabled.length > 0
          ? `已启用：${enabled.map((id) => clean(id, 30)).join('、')}`
          : '没有启用的外部智能体';
      const status = enabled.length > 0 ? 'configured' : 'unconfigured';
      const focused = str(focus?.agent);
      if (focused !== undefined && focused.length > 0) {
        const on = agents[focused]?.enabled === true;
        return snapshot(
          on ? 'configured' : status === 'configured' ? 'partial' : 'unconfigured',
          { agent: focused, enabled: on },
          summary,
          {
            login: on,
          },
        );
      }
      return snapshot(status, { agent: enabled.join(','), enabled: enabled.length > 0 }, summary, {
        login: enabled.length > 0,
      });
    },
    options: (field) =>
      field.options === 'agents'
        ? (deps.agentCatalog?.() ?? []).map((entry) => ({
            value: entry.id,
            label: clean(entry.name),
          }))
        : staticOptions(field),
    write: (_item, { next }) => {
      const agent = str(next.agent) ?? '';
      if (agent.length === 0) throw new AppError('INVALID_INPUT', '需要选择智能体');
      if (!(deps.agentCatalog?.() ?? []).some((entry) => entry.id === agent)) {
        throw new AppError('INVALID_INPUT', `智能体「${clean(agent)}」不在目录中`);
      }
      // 只改这一个智能体的 enabled（installedVersion / source 由 core 的 agents.* 维护）。
      const latest = deps.settings.get().agents;
      const previous = latest[agent] ?? {
        enabled: false,
        source: 'managed' as const,
        loadUserConfig: false,
      };
      deps.settings.update({
        agents: { ...latest, [agent]: { ...previous, enabled: bool(next.enabled) ?? true } },
      });
    },
    // 登录由用户在卡片里完成：一律需要用户自己操作。
    needsSensitiveInput: () => true,
  };
}

function taintGuardAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const enabled = deps.settings.get().apps.taintGuard;
      return snapshot('configured', { enabled }, enabled ? '已开启' : '已关闭');
    },
    write: (_item, { next }) => {
      const latest = deps.settings.get().apps;
      deps.settings.update({
        apps: { ...latest, taintGuard: bool(next.enabled) ?? latest.taintGuard },
      });
    },
    valuesWiden: (_item, _before, proposed) => bool(proposed.enabled) === false,
  };
}

function unattendedAdapter(deps: AdapterDeps, kind: 'enable' | 'disable'): ItemAdapter {
  const state = (): UnattendedState | null => deps.unattended?.effective() ?? null;
  return {
    read: () => {
      const current = state();
      if (current === null) return snapshot('unknown', null, '状态未知');
      const values = { enabled: current.enabled };
      return snapshot(
        kind === 'enable' ? (current.enabled ? 'configured' : 'unconfigured') : 'configured',
        values,
        current.enabled ? '无人值守进行中' : '未开启无人值守',
      );
    },
    // 开启只能由用户在设置页亲手完成（风险确认在组件里）；关闭可以由宿主执行。
    ...(kind === 'disable'
      ? {
          write: () => {
            if (deps.unattended === undefined)
              throw new AppError('NOT_IMPLEMENTED', '无人值守服务未就绪');
            deps.unattended.disable('用户在设置卡上关闭');
          },
        }
      : {}),
  };
}

// --- P1：模型并发、本地向量、Bot 配置片段 -------------------------------------------

/** 每家厂商并发上限的取值范围上界（与设置页一致）。 */
const CONCURRENCY_MAX = 16;

function concurrencyAdapter(deps: AdapterDeps): ItemAdapter {
  // 键空间与 `providerConcurrency` 一致：default、已接入的厂商 id、外部智能体（`agent:{id}`）。
  const knownConcurrencyProvider = (provider: string): boolean =>
    provider.length === 0 ||
    provider === 'default' ||
    deps.providers.list().some((entry) => entry.id === provider) ||
    (provider.startsWith('agent:') &&
      (deps.agentCatalog?.() ?? []).some((entry) => `agent:${entry.id}` === provider));
  return {
    read: () => {
      const concurrency = deps.settings.get().providerConcurrency;
      const limit = concurrency.default;
      return snapshot('configured', { provider: 'default', limit }, `默认每家 ${limit} 个并发`);
    },
    options: (field) =>
      field.name === 'provider'
        ? [
            { value: 'default', label: '默认（每家厂商）' },
            ...deps.providers.list().map((provider) => ({
              value: provider.id,
              label: clean(provider.name),
            })),
          ]
        : staticOptions(field),
    normalize: (_item, values) => {
      if ('limit' in values && intIn(values.limit, 1, CONCURRENCY_MAX) === undefined) {
        return { ok: false, message: `limit 应为 1 到 ${CONCURRENCY_MAX} 的整数` };
      }
      if ('provider' in values) {
        const provider = str(values.provider) ?? '';
        if (!knownConcurrencyProvider(provider)) {
          return {
            ok: false,
            message: `没有已接入的厂商「${clean(provider, 40)}」：provider 填 default 或 settings_read 给出的厂商 id`,
          };
        }
        return { ok: true, values: { ...values, provider } };
      }
      return { ok: true, values };
    },
    write: (_item, { next }) => {
      const limit = intIn(next.limit, 1, CONCURRENCY_MAX);
      if (limit === undefined) {
        throw new AppError('INVALID_INPUT', `limit 应为 1 到 ${CONCURRENCY_MAX} 的整数`);
      }
      const provider = str(next.provider) ?? 'default';
      // 写锁里再核对一次：只给已接入的厂商写上限，不让任意字符串进 providerConcurrency。
      if (!knownConcurrencyProvider(provider)) {
        throw new AppError('INVALID_INPUT', `没有已接入的厂商「${clean(provider, 40)}」`);
      }
      const latest = deps.settings.get().providerConcurrency;
      deps.settings.update({
        providerConcurrency:
          provider.length === 0 || provider === 'default'
            ? { ...latest, default: limit }
            : { ...latest, [provider]: limit },
      });
    },
  };
}

function embeddingLocalAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const source = deps.settings.get().embedding.source;
      return source === ''
        ? snapshot('unconfigured', { source: '' }, '未配置（记忆检索退化为全文搜索）')
        : snapshot('configured', { source }, source === 'local' ? '本地模型' : '厂商接口');
    },
    normalize: (_item, values) => {
      if (!('source' in values)) return { ok: true, values };
      const source = str(values.source) ?? '';
      return source === 'local' || source === 'provider'
        ? { ok: true, values: { ...values, source } }
        : { ok: false, message: 'source 应为 local（本地模型）或 provider（厂商接口）' };
    },
    write: (_item, { next }) => {
      const source = str(next.source);
      if (source !== 'local' && source !== 'provider') {
        throw new AppError('INVALID_INPUT', '需要选择本地模型或厂商接口');
      }
      if (deps.embedding !== undefined) {
        deps.embedding.configure({ source });
        return;
      }
      const current = deps.settings.get().embedding;
      deps.settings.update({ embedding: { ...current, source } });
    },
  };
}

function browserProfileAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const profileId = botField(deps, target, (bot) => bot.profile.runtime.browser_profile);
      if (profileId === null) return snapshot('unknown', null, 'Bot 不存在');
      if (profileId.length === 0) return snapshot('configured', { profile: '' }, '私有资料');
      const shared = deps.settings.get().browserProfiles.find((profile) => profile.id === profileId);
      return snapshot(
        'configured',
        { profile: profileId },
        `共享资料「${clean(shared?.name ?? profileId, 30)}」`,
      );
    },
    options: () => [
      { value: '', label: '私有资料' },
      ...deps.settings.get().browserProfiles.map((profile) => ({
        value: profile.id,
        label: clean(profile.name),
      })),
    ],
    normalize: (_item, values) =>
      'profile' in values && str(values.profile) === undefined && typeof values.profile !== 'string'
        ? { ok: false, message: 'profile 应为资料 id，空串表示私有资料' }
        : { ok: true, values },
    // 资料是否存在由 `botProfiles.apply` 的 `assertSelectable` 校验（与 bots.update 同一处）。
    write: (_item, { next }, target) => {
      const profile = str(next.profile) ?? '';
      return writeRuntime(deps, target, (runtime) => ({ ...runtime, browser_profile: profile }));
    },
  };
}

/**
 * 共享浏览器资料的新建。没有 focus 时回有几份；focus 里有 `name` 时，已有同名资料回
 * `{ name }` 且 configured（再建一个同名的不出卡），还没有回空名称、unconfigured。
 * 快照不带资料 id。不提供 write——组件走 `browserProfiles.create`，服务读当前列表再追加
 * （`newId` + `cleanName`）。写锁里整表替换会丢掉这段，也可能覆盖刚建的另一条资料。
 * 重命名要资料 id，目录里没有这个字段；清除和删除会把挂在上面的 Bot 退回私有资料并中断任务，
 * 都留在设置页。
 */
function browserSharedProfilesAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, _target, focus) => {
      const profiles = deps.settings.get().browserProfiles;
      const name = str(focus?.name);
      if (name === undefined || name.length === 0) {
        return snapshot(
          profiles.length === 0 ? 'unconfigured' : 'configured',
          null,
          profiles.length === 0 ? '还没有共享浏览器资料' : `有 ${profiles.length} 份共享资料`,
        );
      }
      const existing = profiles.find((profile) => profile.name === name);
      if (existing === undefined) {
        return snapshot('unconfigured', { name: '' }, '还没有这份共享资料');
      }
      return snapshot('configured', { name }, `已有共享资料「${clean(name, 40)}」`);
    },
  };
}

function networkAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const runtime = botField(deps, target, (bot) => bot.profile.runtime);
      if (runtime === null) return snapshot('unknown', null, 'Bot 不存在');
      const label =
        { none: '不联网', allowlist: '白名单', open: '开放' }[runtime.network_policy] ??
        runtime.network_policy;
      return snapshot(
        'configured',
        {
          policy: runtime.network_policy,
          allowlist: runtime.network_allowlist.map((domain) => clean(domain, 100)),
        },
        label,
      );
    },
    normalize: (_item, values) => {
      const next = { ...values };
      if ('policy' in next) {
        const policy = str(next.policy);
        if (policy !== 'none' && policy !== 'allowlist' && policy !== 'open') {
          return { ok: false, message: 'policy 应为 none / allowlist / open' };
        }
        next.policy = policy;
      }
      if ('allowlist' in next) {
        const allowlist = asStringList(next.allowlist);
        if (allowlist === undefined) return { ok: false, message: 'allowlist 应为域名列表' };
        next.allowlist = allowlist;
      }
      return { ok: true, values: next };
    },
    write: (_item, { next }, target) => {
      const policy = str(next.policy);
      if (policy !== 'none' && policy !== 'allowlist' && policy !== 'open') {
        throw new AppError('INVALID_INPUT', '需要选择网络策略');
      }
      // 白名单只在「白名单」策略下可见（卡片与右栏都只在这一档露出输入框）：别的策略下保持已存的
      // 白名单不动，不存用户在卡上看不到的域名——否则之后切到白名单时它们会悄悄生效。
      const allowlist = policy === 'allowlist' ? (asStringList(next.allowlist) ?? []) : null;
      return writeRuntime(deps, target, (runtime) => ({
        ...runtime,
        network_policy: policy,
        network_allowlist: allowlist ?? runtime.network_allowlist,
      }));
    },
    // 放开网络、或给出任何一个现在没有的域名，都是放宽（与策略无关：策略不是白名单时域名虽然不
    // 生效，也会在之后切到白名单时生效）。看不出方向由宿主按放宽处理。
    valuesWiden: (_item, before, proposed) => {
      const beforePolicy = str(before?.policy) ?? 'none';
      const nextPolicy = str(proposed.policy) ?? beforePolicy;
      if ((NETWORK_RANK[nextPolicy] ?? 0) > (NETWORK_RANK[beforePolicy] ?? 0)) return true;
      if (!('allowlist' in proposed)) return false;
      const nextList = asStringList(proposed.allowlist);
      if (nextList === undefined) return true;
      const known = new Set(asStringList(before?.allowlist) ?? []);
      return nextList.some((domain) => !known.has(domain));
    },
  };
}

function botMcpAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const ids = botField(deps, target, (bot) => bot.profile.runtime.mcp_server_ids);
      if (ids === null) return snapshot('unknown', null, 'Bot 不存在');
      return snapshot(
        ids.length > 0 ? 'configured' : 'unconfigured',
        { servers: [...ids] },
        `启用 ${ids.length} 个 MCP 服务`,
      );
    },
    options: () =>
      deps.settings
        .get()
        .mcpServers.filter((server) => server.enabled !== false)
        .map((server) => ({ value: server.id, label: clean(server.name) })),
    normalize: (_item, values) => {
      if (!('servers' in values)) return { ok: true, values };
      const servers = asStringList(values.servers);
      return servers === undefined
        ? { ok: false, message: 'servers 应为 MCP 服务 id 列表' }
        : { ok: true, values: { ...values, servers } };
    },
    write: (_item, { next }, target) => {
      const servers = asStringList(next.servers);
      if (servers === undefined) throw new AppError('INVALID_INPUT', '需要给出 MCP 服务列表');
      const known = new Set(
        deps.settings
          .get()
          .mcpServers.filter((server) => server.enabled !== false)
          .map((server) => server.id),
      );
      const current = requireBot(deps, target).profile.runtime.mcp_server_ids;
      for (const id of current) known.add(id);
      const unknown = servers.find((id) => !known.has(id));
      if (unknown !== undefined) {
        throw new AppError('INVALID_INPUT', `没有已安装的 MCP 服务「${clean(unknown)}」`);
      }
      return writeRuntime(deps, target, (runtime) => ({ ...runtime, mcp_server_ids: servers }));
    },
  };
}

function botAppsAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const ids = botField(deps, target, (bot) => bot.profile.runtime.app_connection_ids);
      if (ids === null) return snapshot('unknown', null, 'Bot 不存在');
      return snapshot(
        ids.length > 0 ? 'configured' : 'unconfigured',
        { connections: [...ids] },
        `授权了 ${ids.length} 个连接`,
      );
    },
    normalize: (_item, values) => {
      if (!('connections' in values)) return { ok: true, values };
      const connections = asStringList(values.connections);
      return connections === undefined
        ? { ok: false, message: 'connections 应为连接 id 列表' }
        : { ok: true, values: { ...values, connections } };
    },
    write: (_item, { next }, target) => {
      const connections = asStringList(next.connections);
      if (connections === undefined) throw new AppError('INVALID_INPUT', '需要给出连接列表');
      // 连接是否存在由 bots.update 校验（与 Bot 配置表单同一条路径）。
      return writeRuntime(deps, target, (runtime) => ({
        ...runtime,
        app_connection_ids: connections,
      }));
    },
  };
}

function botAgentAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const agent = botField(deps, target, (bot) => bot.profile.runtime.agent);
      if (agent === null) return snapshot('unknown', null, 'Bot 不存在');
      const values = { agent: agent.id, model: agent.model, permission: agent.permission };
      return agent.id.length === 0
        ? snapshot('configured', values, '内置引擎')
        : snapshot('configured', values, `外部智能体 ${clean(agent.id, 30)}`);
    },
    options: (field) => {
      if (field.name === 'agent') {
        return [
          { value: '', label: '内置引擎' },
          ...(deps.agentCatalog?.() ?? []).map((entry) => ({
            value: entry.id,
            label: clean(entry.name),
          })),
        ];
      }
      return staticOptions(field);
    },
    normalize: (_item, values) => {
      const next = { ...values };
      if ('permission' in next) {
        const permission = str(next.permission);
        if (permission !== 'read_only' && permission !== 'ask' && permission !== 'workspace') {
          return { ok: false, message: 'permission 应为 read_only / ask / workspace' };
        }
        next.permission = permission;
      }
      if ('agent' in next && typeof next.agent === 'string') next.agent = next.agent.trim();
      if ('model' in next && typeof next.model === 'string') next.model = next.model.trim();
      return { ok: true, values: next };
    },
    write: (_item, { next }, target) => {
      const bot = requireBot(deps, target);
      const current = bot.profile.runtime.agent;
      // 换成另一个外部智能体时的实验开关与目录校验在 `botProfiles.apply` 里（与 bots.update 同一处）。
      const id = str(next.agent) ?? current.id;
      const permission = str(next.permission) ?? current.permission;
      if (permission !== 'read_only' && permission !== 'ask' && permission !== 'workspace') {
        throw new AppError('INVALID_INPUT', '权限档位无效');
      }
      return writeRuntime(deps, target, (runtime) => ({
        ...runtime,
        agent: {
          ...runtime.agent,
          id,
          model: str(next.model) ?? current.model,
          permission,
        },
      }));
    },
    valuesWiden: (_item, before, proposed) => {
      const beforeId = str(before?.agent) ?? '';
      const nextId = str(proposed.agent) ?? beforeId;
      if (beforeId.length === 0 && nextId.length > 0) return true;
      const beforePermission = str(before?.permission) ?? 'read_only';
      const nextPermission = str(proposed.permission) ?? beforePermission;
      if ((PERMISSION_RANK[nextPermission] ?? 0) > (PERMISSION_RANK[beforePermission] ?? 0)) {
        return true;
      }
      return false;
    },
  };
}

/**
 * 这个 Bot 的技能启停。条目说的是「这个 Bot」：只能启停 Bot 自己的（私有）技能。公共技能没有
 * 这个 Bot 的私有行，`skills.enable` / `disable` 会改公共行、对所有 Bot 生效——这里拒绝并说明
 * 去技能页管理，不让一张「这个 Bot」的卡改全局状态。快照带 `scope`（public / private）。
 */
function botSkillsAdapter(deps: AdapterDeps): ItemAdapter {
  const listed = (botId: string): ReadonlyArray<{ name: string; status: string; scope?: string }> =>
    deps.skills?.list(botId) ?? [];
  const isPublic = (skill: { scope?: string } | undefined): boolean => skill?.scope === 'public';
  const publicRefusal = (name: string): string =>
    `「${clean(name, 40)}」是公共技能，启停会影响所有 Bot，不能在这个 Bot 的设置卡上改；请在技能页（扩展中心「Skills」）管理公共技能`;
  return {
    read: (_item, target, focus) => {
      if (deps.skills === undefined || target.botId === null) {
        return snapshot('unknown', null, '状态未知');
      }
      const skills = listed(target.botId);
      const own = skills.filter((skill) => !isPublic(skill));
      const enabled = own.filter((skill) => skill.status === 'active').map((skill) => skill.name);
      const publicCount = skills.length - own.length;
      const summary = [
        enabled.length > 0
          ? `自己的技能启用 ${enabled.length} 个`
          : own.length > 0
            ? '自己的技能都没有启用'
            : '没有自己的技能',
        ...(publicCount > 0 ? [`另有 ${publicCount} 个公共技能（在技能页管理）`] : []),
      ].join('；');
      const focused = str(focus?.skill);
      if (focused !== undefined && focused.length > 0) {
        const skill = skills.find((entry) => entry.name === focused);
        const on = skill?.status === 'active';
        const scope = skill === undefined ? '' : isPublic(skill) ? 'public' : 'private';
        return snapshot(
          on ? 'configured' : 'unconfigured',
          { skill: focused, enabled: on, scope },
          scope === 'public'
            ? `「${clean(focused, 40)}」是公共技能（${on ? '已启用' : '已停用'}，所有 Bot 共用）`
            : summary,
        );
      }
      return snapshot(own.length > 0 ? 'configured' : 'unconfigured', null, summary);
    },
    options: (_field, _item, target) =>
      target.botId === null
        ? []
        : listed(target.botId).map((skill) => ({
            value: skill.name,
            label: isPublic(skill)
              ? `${clean(skill.name)}（公共技能，只能在技能页管理）`
              : clean(skill.name),
          })),
    normalize: (_item, values, target) => {
      if ('enabled' in values && bool(values.enabled) === undefined) {
        return { ok: false, message: 'enabled 应为 true / false' };
      }
      const name = str(values.skill);
      if (name !== undefined && name.length > 0 && target.botId !== null) {
        const skill = listed(target.botId).find((entry) => entry.name === name);
        if (skill === undefined) {
          return { ok: false, message: `这个 Bot 没有技能「${clean(name, 40)}」` };
        }
        if (isPublic(skill)) return { ok: false, message: publicRefusal(name) };
      }
      return { ok: true, values };
    },
    write: (_item, { next }, target) => {
      if (deps.skills === undefined || target.botId === null) {
        throw new AppError('NOT_IMPLEMENTED', '技能服务未就绪');
      }
      const skill = str(next.skill);
      if (skill === undefined || skill.length === 0) {
        throw new AppError('INVALID_INPUT', '需要选择技能');
      }
      // 写锁里再查一次：读快照之后才变成公共技能（或私有行被删）时同样拒绝，不碰公共行。
      const row = listed(target.botId).find((entry) => entry.name === skill);
      if (row === undefined) {
        throw new AppError('INVALID_INPUT', `这个 Bot 没有技能「${clean(skill, 40)}」`);
      }
      if (isPublic(row)) throw new AppError('INVALID_INPUT', publicRefusal(skill));
      if (bool(next.enabled) === false) deps.skills.disable(target.botId, skill);
      else deps.skills.enable(target.botId, skill);
    },
  };
}

type CatalogPolicy = 'ask' | 'allow' | 'deny';

function catalogPolicyWord(value: unknown): CatalogPolicy | null {
  return value === 'ask' || value === 'allow' || value === 'deny' ? value : null;
}

/** 有效策略 → 目录词。停用是 deny；直接允许（含按风险档默认就是免审批）是 allow。 */
function catalogPolicyOf(tool: Pick<CatalogToolPolicyView, 'enabled' | 'approval'>): CatalogPolicy {
  if (!tool.enabled) return 'deny';
  return tool.approval === 'auto' ? 'allow' : 'ask';
}

/**
 * 放宽：改为直接允许，或把已禁用的工具重新启用。收紧（改为每次询问、停用）返回 false，可以预填。
 * 看不出方向（缺旧值、缺新值、不是目录词）按放宽。
 */
function toolPolicyWidens(before: SettingValues | null, proposed: SettingValues): boolean {
  const next = catalogPolicyWord(proposed.policy);
  const current = catalogPolicyWord(before?.policy);
  if (next === null || current === null) return true;
  if (next === 'allow' && current !== 'allow') return true;
  if (current === 'deny' && next !== 'deny') return true;
  return false;
}

/**
 * 连接的逐工具策略。只读：快照带上 `connection` 和 `tool`（user-only 会清空整份预填，卡片靠
 * before 定位是哪一条）。不提供 write——组件调用 `apps.connections.setToolPolicy`，策略变严时
 * 那条 RPC 会中断正在使用该连接的任务。
 */
function toolPolicyAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, _target, focus) => {
      const connection = str(focus?.connection);
      const tool = str(focus?.tool);
      const located: SettingValues = {};
      if (connection !== undefined && connection.length > 0) located.connection = connection;
      if (tool !== undefined && tool.length > 0) located.tool = tool;
      const hasTarget = located.connection !== undefined && located.tool !== undefined;
      if (!hasTarget) {
        return snapshot(
          'unknown',
          Object.keys(located).length > 0 ? located : null,
          '需要指定连接和工具',
        );
      }
      if (deps.appConnections === undefined) {
        return snapshot('unknown', located, '状态未知');
      }
      const found = deps.appConnections.peekTool(String(located.connection), String(located.tool));
      if (found === null) return snapshot('unconfigured', located, '没有这条工具');
      const policy = catalogPolicyOf(found);
      const word = policy === 'allow' ? '直接允许' : policy === 'deny' ? '已禁用' : '每次询问';
      return snapshot(
        'configured',
        { ...located, policy },
        `「${clean(String(located.tool), 40)}」${word}`,
      );
    },
    options: (field) => {
      if (field.options !== 'connections' || deps.appConnections === undefined) return [];
      return deps.appConnections.list().map((row) => ({
        value: row.id,
        label: clean(row.label.length > 0 ? row.label : row.id),
      }));
    },
    valuesWiden: (_item, before, proposed) => toolPolicyWidens(before, proposed),
  };
}

function groupConversation(
  deps: AdapterDeps,
  target: SettingTargetRef,
): { title: string | null; type: string } | null {
  if (target.conversationId === null) return null;
  return deps.conversations?.get(target.conversationId) ?? null;
}

function groupTitleAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const conversation = groupConversation(deps, target);
      if (conversation === null || conversation.type !== 'group') {
        return snapshot('unknown', null, '当前不是群聊');
      }
      const title = clean(conversation.title ?? '', 60);
      return snapshot('configured', { title }, title.length > 0 ? title : '（未命名）');
    },
    normalize: (_item, values) => {
      if (!('title' in values)) return { ok: true, values };
      const title = str(values.title);
      return title !== undefined && title.length > 0
        ? { ok: true, values: { ...values, title } }
        : { ok: false, message: '群名不能为空' };
    },
    write: (_item, { next }, target) => {
      const title = str(next.title);
      if (title === undefined || title.length === 0) {
        throw new AppError('INVALID_INPUT', '群名不能为空');
      }
      if (target.conversationId === null || deps.groups === undefined) {
        throw new AppError('NOT_IMPLEMENTED', '群服务未就绪');
      }
      deps.groups.rename(target.conversationId, title);
    },
  };
}

function groupMembersAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, target) => {
      const conversationId = target.conversationId;
      if (conversationId === null) return snapshot('unknown', null, '当前不是群聊');
      const conversation = deps.conversations?.get(conversationId) ?? null;
      if (conversation === null || conversation.type !== 'group') {
        return snapshot('unknown', null, '当前不是群聊');
      }
      const ids = deps.conversations?.memberBotIds?.(conversationId);
      if (ids === undefined) return snapshot('unknown', null, '状态未知');
      const names = ids.map((id) => clean(deps.bots.get(id)?.name ?? id, 30));
      const summary =
        names.length === 0 ? '还没有成员' : clean(names.join('、'), SUMMARY_MAX);
      return snapshot('configured', { bots: [...ids] }, summary);
    },
    options: () =>
      (deps.bots.listActive?.() ?? []).map((bot) => ({
        value: bot.id,
        label: clean(bot.name),
      })),
    // Bot 只能提议「拉谁进群」：建议值 = 现有成员 ∪ Bot 给的。移出成员只能由用户在卡上亲手取消
    // 勾选（卡片把「将移出」单独列出来），预填永远不会少掉现有成员。
    proposal: (_item, values, current) => {
      if (!('bots' in values)) return values;
      const existing = Array.isArray(current.values?.bots)
        ? current.values.bots.filter((id): id is string => typeof id === 'string')
        : [];
      const proposed = asStringList(values.bots) ?? [];
      return { ...values, bots: [...new Set([...existing, ...proposed])] };
    },
  };
}

/** 保护规则快照里每类最多列几条（其余只计数）。 */
const PROTECT_PATTERNS_SHOWN = 20;
/** 每条规则形状的长度上限。 */
const PROTECT_PATTERN_MAX = 60;

function isAbsolutePattern(pattern: string): boolean {
  return pattern.startsWith('/') || pattern.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(pattern);
}

function stripPrefix(pattern: string, prefix: string): string | null {
  const normalized = prefix.replace(/[\\/]+$/, '');
  if (normalized.length === 0) return null;
  if (pattern === normalized) return '';
  for (const separator of ['/', '\\']) {
    if (pattern.startsWith(`${normalized}${separator}`)) {
      return pattern.slice(normalized.length + 1);
    }
  }
  return null;
}

/**
 * 一条保护规则的脱敏形状：项目目录下 → `<project>/…`，家目录下 → `~/…`，其余绝对路径只留最后一段
 * （`…/文件名`）；相对的 glob（`*.pem`、`.git/config`）原样。都过 `sanitizeDisplayText` 并截短。
 */
export function redactPathPattern(
  pattern: string,
  projectRoot: string | null,
  homeDir: string | null,
): string {
  let shape = pattern;
  if (projectRoot !== null) {
    const rest = stripPrefix(pattern, projectRoot);
    if (rest !== null) shape = rest.length > 0 ? `<project>/${rest}` : '<project>';
  }
  if (shape === pattern && homeDir !== null) {
    const rest = stripPrefix(pattern, homeDir);
    if (rest !== null) shape = rest.length > 0 ? `~/${rest}` : '~';
  }
  if (shape === pattern && isAbsolutePattern(pattern)) {
    const segments = pattern.split(/[\\/]+/).filter((segment) => segment.length > 0);
    shape = `…/${segments.at(-1) ?? ''}`;
  }
  return clean(shape, PROTECT_PATTERN_MAX);
}

function projectRulesAdapter(deps: AdapterDeps, kind: 'rules' | 'ports'): ItemAdapter {
  return {
    read: (_item, target) => {
      const project = target.projectId !== null ? (deps.projects?.get(target.projectId) ?? null) : null;
      if (project === null) return snapshot('unknown', null, '当前对话没有绑定项目');
      if (kind === 'ports') {
        const ports = (project.allowedPorts ?? []).map(([from, to]) =>
          from === to ? `${from}` : `${from}-${to}`,
        );
        return snapshot(
          'configured',
          { ports },
          ports.length === 0 ? '不限制本机端口' : clean(ports.join('、'), SUMMARY_MAX),
        );
      }
      // 读也要脱敏（方案 §七）：规则可能写成本机绝对路径——只回条数和脱敏后的形状
      // （家目录 → `~`、项目目录 → `<project>`、其余绝对路径只留文件名），每条截短、条数封顶。
      const redact = (patterns: readonly string[]): string[] =>
        patterns
          .slice(0, PROTECT_PATTERNS_SHOWN)
          .map((pattern) => redactPathPattern(pattern, project.path ?? null, deps.homeDir ?? homedir()));
      const { denyRead, denyWrite } = project.protectRules;
      return snapshot(
        'configured',
        { denyRead: redact(denyRead), denyWrite: redact(denyWrite) },
        `禁止读取 ${denyRead.length} 条，禁止写入 ${denyWrite.length} 条`,
      );
    },
  };
}

/**
 * 放宽：从停用改为启用。停用（true → false）返回 false，可以预填。
 * 看不出方向（缺旧值、缺新值、不是布尔）按放宽。
 */
function mcpServerWidens(before: SettingValues | null, proposed: SettingValues): boolean {
  const next = bool(proposed.enabled);
  const current = bool(before?.enabled);
  if (next === undefined || current === undefined) return true;
  return current === false && next === true;
}

/**
 * 已安装 MCP 的启停。有 focus 时快照带上 `server` 和当前 `enabled`（user-only 会清空整份预填，
 * 卡片靠 before 定位是哪一个服务）；没有 focus 时仍回安装概要。
 *
 * 写入（D89 审查修复）：在写锁里读**最新**的 `mcpServers`，只改这一个服务的 `enabled`（兄弟服务、
 * `toolPolicies`、并发新增的服务都不动，CAS 比对 `enabled`），锁外再用 `mcpRevocationsBetween`
 * 收回授权（停用正在用的服务会中断任务，与 `settings.update` 同一套）。启停不改 URL / 认证方式，
 * 所以不需要 `reconcileServers`。卡片的组件经 `settings.items.apply` 走这里，不再从渲染层缓存
 * 整表提交 `settings.update`。启用（放宽）仍是 user-only：只有用户在卡上亲手点才会写。
 */
function mcpServersAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: (_item, _target, focus) => {
      const servers = deps.settings.get().mcpServers;
      const enabledCount = servers.filter((server) => server.enabled === true).length;
      const overview =
        servers.length === 0
          ? '没有安装 MCP 服务'
          : `已安装 ${servers.length} 个，启用 ${enabledCount} 个`;
      const serverId = str(focus?.server);
      if (serverId === undefined || serverId.length === 0) {
        return snapshot(servers.length === 0 ? 'unconfigured' : 'configured', null, overview);
      }
      const server = servers.find((entry) => entry.id === serverId);
      if (server === undefined) {
        return snapshot('unconfigured', { server: serverId }, '没有这个 MCP 服务');
      }
      const on = server.enabled === true;
      return snapshot(
        on ? 'configured' : 'unconfigured',
        { server: serverId, enabled: on },
        `「${clean(server.name, 40)}」${on ? '已启用' : '已停用'}`,
      );
    },
    options: (field) => {
      if (field.options !== 'mcp-servers') return [];
      return deps.settings.get().mcpServers.map((server) => ({
        value: server.id,
        label: clean(server.name),
      }));
    },
    normalize: (_item, values) => {
      if (!('server' in values)) return { ok: true, values };
      const serverId = str(values.server) ?? '';
      return deps.settings.get().mcpServers.some((server) => server.id === serverId)
        ? { ok: true, values: { ...values, server: serverId } }
        : { ok: false, message: `没有已安装的 MCP 服务「${clean(serverId)}」` };
    },
    write: (_item, { next }) => {
      const revoke = deps.mcpServers;
      if (revoke === undefined) throw new AppError('NOT_IMPLEMENTED', 'MCP 模块未就绪');
      const serverId = str(next.server) ?? '';
      const enabled = bool(next.enabled);
      if (serverId.length === 0 || enabled === undefined) {
        throw new AppError('INVALID_INPUT', '需要指定 MCP 服务和启用状态');
      }
      const previous = deps.settings.get().mcpServers;
      if (!previous.some((server) => server.id === serverId)) {
        throw new AppError('INVALID_INPUT', `没有已安装的 MCP 服务「${clean(serverId)}」`);
      }
      const updated = previous.map((server) =>
        server.id === serverId ? { ...server, enabled } : server,
      );
      deps.settings.update({ mcpServers: updated });
      return { afterUnlock: () => revoke.revokeChanges(previous, updated) };
    },
    valuesWiden: (_item, before, proposed) => mcpServerWidens(before, proposed),
  };
}

/**
 * 工具链只读概要。目录没有字段，快照 `values` 保持 null，也不放安装记录 id。
 * 已安装：`status === 'installed'` 的安装行，加上检测为可用的系统项。
 * 失败或缺失：`status === 'failed'` 的安装行，加上检测为不可用的系统项。
 * 正在安装、已卸载不计入。没有失败或缺失时 `configured`（「我已设置好」才能通过）；
 * 有问题时，已经有安装为 `partial`，一项都没有为 `unconfigured`。
 * 不提供 write：安装仍走环境审批，重新检测和重装由组件自己调原来的 RPC。
 */
function environmentToolchainsAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const environment = deps.environment;
      if (environment === undefined) return snapshot('unconfigured', null, '还看不到工具链状态');
      let installed = 0;
      let problems = 0;
      for (const row of environment.listInstalls()) {
        if (row.status === 'installed') installed += 1;
        else if (row.status === 'failed') problems += 1;
      }
      for (const system of environment.systemStatuses()) {
        if (system.available) installed += 1;
        else problems += 1;
      }
      const status = problems > 0 ? (installed > 0 ? 'partial' : 'unconfigured') : 'configured';
      return snapshot(status, null, `已安装 ${installed} 项，失败或缺失 ${problems} 项`);
    },
  };
}

/**
 * 沙箱只读概要。目录没有字段，快照 `values` 保持 null。
 * 只读最近一次可用性：还没检测过是 `unknown`（「还没检测过沙箱」）；
 * 可用为 `configured`，不可用为 `unconfigured`（沙箱仍不可用时「我已设置好」核对不过）。
 * 不放 fixHint、本机路径或修复命令。不提供 write：重新检测和准备向导留在组件。
 */
function environmentSandboxAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const last = deps.sandbox?.lastAvailability() ?? null;
      if (last === null) return snapshot('unknown', null, '还没检测过沙箱');
      return last.available
        ? snapshot('configured', null, '沙箱可用')
        : snapshot('unconfigured', null, '沙箱不可用');
    },
  };
}

/**
 * 命令白名单只读概要。目录没有字段，快照 `values` 保持 null，不放条目 id 或命令模式。
 *
 * 状态恒为 `unknown`：Bot 要的是「某一条命令能不能免审批」，名单里有没有启用的条目（内置条目
 * 默认就是启用的）说明不了这件事。所以：
 * - 任务里 `required:true` 不会因为「已配置」直接放行（只有 `configured` 才会）；
 * - 「已经是想要的值」的短路也不会命中；
 * - 用户点「我已设置好」按用户所说结卡（无法核对）；打开对话时的自动核对（`auto`）只在名单
 *   相对出卡时变过（概要里的条数变了）才结卡。
 * 概要分开数内置与自定义、启用与停用。加一条命令豁免是放宽，保持 user-only，不提供 write。
 */
function environmentAllowlistAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const allowlist = deps.allowlist;
      if (allowlist === undefined) return snapshot('unknown', null, '还看不到命令白名单');
      let customEnabled = 0;
      let customDisabled = 0;
      let builtinEnabled = 0;
      let builtinDisabled = 0;
      for (const entry of allowlist.list()) {
        if (entry.builtin === true) {
          if (entry.enabled) builtinEnabled += 1;
          else builtinDisabled += 1;
        } else if (entry.enabled) customEnabled += 1;
        else customDisabled += 1;
      }
      return snapshot(
        'unknown',
        null,
        `自定义启用 ${customEnabled} 条、停用 ${customDisabled} 条；内置启用 ${builtinEnabled} 条、停用 ${builtinDisabled} 条`,
      );
    },
  };
}

// --- 只读概要（没有写入实现的 core 条目）-------------------------------------------

function readOnlyAdapter(read: (target: SettingTargetRef) => ItemSnapshot): ItemAdapter {
  return { read: (_item, target) => read(target) };
}

function botField<T>(deps: AdapterDeps, target: SettingTargetRef, pick: (bot: Bot) => T): T | null {
  const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
  return bot === null ? null : pick(bot);
}

const RENDERER_ADAPTER: ItemAdapter = {
  read: () => snapshot('unknown', null, '状态未知（只在本机界面可见）'),
};

const READONLY_ITEM_ADAPTER: ItemAdapter = {
  read: () => snapshot('readonly', null, '只能在设置中查看'),
};

/** 经专门工具的条目：只给一句话，修改一律改用该工具。 */
function viaToolAdapter(tool: string): ItemAdapter {
  return { read: () => snapshot('configured', null, `由 ${tool} 工具管理`) };
}

/**
 * 全部条目的适配器（按 id）。没登记的 core 条目回落到「状态以设置页为准」的只读概要——
 * 新增目录条目不会因此崩，但应在这里补上读法。
 */
export function buildItemAdapters(deps: AdapterDeps): (item: SettingItem) => ItemAdapter {
  const capability = capabilityAdapter(deps);
  const byId: Record<string, ItemAdapter> = {
    'models.default-main': settingsModelAdapter(deps, 'defaultMainModel', null),
    'models.default-light': settingsModelAdapter(deps, 'defaultLightModel', null),
    'models.widget-review': settingsModelAdapter(deps, 'widgetReviewModel', '跟随 Bot 主模型'),
    'models.provider': providerKeyAdapter(deps),
    'models.embedding-local': embeddingLocalAdapter(deps),
    'models.concurrency': concurrencyAdapter(deps),
    'search.provider': webSearchAdapter(deps),
    'mcp.servers': mcpServersAdapter(deps),
    'connections.taint-guard': taintGuardAdapter(deps),
    'connections.tool-policy': toolPolicyAdapter(deps),
    'agents.external': externalAgentsAdapter(deps),
    'agents.default': agentsDefaultAdapter(deps),
    'bot.model': botModelAdapter(deps, 'model'),
    'bot.light-model': botModelAdapter(deps, 'light_model'),
    'bot.browser-profile': browserProfileAdapter(deps),
    'browser.shared-profiles': browserSharedProfilesAdapter(deps),
    'bot.network': networkAdapter(deps),
    'bot.mcp-servers': botMcpAdapter(deps),
    'bot.apps': botAppsAdapter(deps),
    'bot.skills': botSkillsAdapter(deps),
    'bot.agent': botAgentAdapter(deps),
    'group.title': groupTitleAdapter(deps),
    'group.members': groupMembersAdapter(deps),
    'project.protect-rules': projectRulesAdapter(deps, 'rules'),
    'project.ports': projectRulesAdapter(deps, 'ports'),
    'general.launch-at-login': launchAtLoginAdapter(deps),
    'background.tasks': backgroundTasksAdapter(deps),
    'background.budget': budgetAdapter(deps),
    'unattended.enable': unattendedAdapter(deps, 'enable'),
    'unattended.disable': unattendedAdapter(deps, 'disable'),
    'environment.toolchains': environmentToolchainsAdapter(deps),
    'environment.sandbox': environmentSandboxAdapter(deps),
    'environment.allowlist': environmentAllowlistAdapter(deps),
    'developer.mode': readOnlyAdapter(() => {
      const enabled = deps.settings.get().apps.developerMode;
      return snapshot('configured', null, enabled ? '已开启' : '未开启');
    }),
  };
  const fallback: ItemAdapter = { read: () => snapshot('configured', null, '详情以设置页为准') };
  return (item) => {
    if (item.readOnly) return READONLY_ITEM_ADAPTER;
    if (item.owner === 'renderer') return RENDERER_ADAPTER;
    if (item.id.startsWith('capability.')) return capability;
    const adapter = byId[item.id];
    if (adapter !== undefined) return adapter;
    if (item.write.via !== 'catalog') return viaToolAdapter(item.write.via.tool);
    return fallback;
  };
}
