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
  type ProviderInfo,
  type Settings,
  type SettingFieldSpec,
  type SettingItem,
  type SettingItemStatus,
  type SettingOption,
  type SettingValues,
  type UnattendedState,
} from '@kepcup/shared';
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

export type NormalizeResult = { ok: true; values: SettingValues } | { ok: false; message: string };

export interface ItemAdapter {
  read(item: SettingItem, target: SettingTargetRef): ItemSnapshot;
  /** 动态可选值（`options` 不是 static 的字段）；缺省 = 没有可列的选项。 */
  options?(field: SettingFieldSpec, item: SettingItem, target: SettingTargetRef): SettingOption[];
  /** 校验并规范化 Bot / 卡片给的非敏感值（如模型引用补全厂商前缀）。缺省 = 原样接受。 */
  normalize?(item: SettingItem, values: SettingValues, target: SettingTargetRef): NormalizeResult;
  /** 写入（在写锁内、CAS 之后调用）。缺省 = 这一项不能由宿主写，只能出卡 / 跳转。 */
  write?(item: SettingItem, write: ItemWrite, target: SettingTargetRef): void;
  /** 这次修改需要用户自填敏感字段（缺 Key、新厂商……）→ 至少 form。 */
  needsSensitiveInput?(item: SettingItem, proposed: SettingValues, snapshot: ItemSnapshot): boolean;
  /** 这次修改是不是放宽方向（只对带 `wideningMode` 的条目有意义）；缺省 = 未知（按放宽处理）。 */
  valuesWiden?(item: SettingItem, before: SettingValues | null, proposed: SettingValues): boolean;
}

export interface AdapterDeps {
  settings: { get(): Settings; update(patch: Partial<Settings>): Settings };
  secrets: { hasValue(name: string): boolean; setValue(name: string, value: string): void };
  providers: { list(): ProviderInfo[]; setKey(provider: string, key: string): void };
  bots: {
    get(id: string): Bot | null;
    update(id: string, profile: Bot['profile']): Bot;
  };
  conversations?: { get(id: string): { title: string | null; type: string } | null };
  unattended?: { effective(): UnattendedState; disable(reason?: string): UnattendedState };
  agentCatalog?: () => readonly AgentCatalogEntry[];
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
  const botOf = (target: SettingTargetRef): Bot => {
    const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
    if (bot === null) throw new AppError('NOT_FOUND', 'Bot 不存在');
    return bot;
  };
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
    write: (_item, { next }, target) => {
      const bot = botOf(target);
      const profile = {
        ...bot.profile,
        runtime: { ...bot.profile.runtime, [key]: str(next.model) ?? '' },
      };
      const updated = deps.bots.update(bot.id, profile);
      deps.publish('bot.updated', { bot: updated });
    },
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
    write: (_item, { next }) => deps.settings.update({ defaultAgentId: str(next.agent) ?? '' }),
  };
}

function externalAgentsAdapter(deps: AdapterDeps): ItemAdapter {
  return {
    read: () => {
      const agents = deps.settings.get().agents;
      const enabled = Object.entries(agents)
        .filter(([, value]) => value.enabled)
        .map(([id]) => id);
      return enabled.length > 0
        ? snapshot(
            'configured',
            { agent: enabled[0]!, enabled: true },
            `已启用：${enabled.map((id) => clean(id, 30)).join('、')}`,
            { login: true },
          )
        : snapshot('unconfigured', { agent: '', enabled: false }, '没有启用的外部智能体', {
            login: false,
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
    'models.embedding-local': readOnlyAdapter(() => {
      const source = deps.settings.get().embedding.source;
      return source === ''
        ? snapshot('unconfigured', { source: '' }, '未配置（记忆检索退化为全文搜索）')
        : snapshot('configured', { source }, source === 'local' ? '本地模型' : '厂商接口');
    }),
    'models.concurrency': readOnlyAdapter(() => {
      const limit = deps.settings.get().providerConcurrency.default;
      return snapshot('configured', { provider: 'default', limit }, `默认每家 ${limit} 个并发`);
    }),
    'search.provider': webSearchAdapter(deps),
    'mcp.servers': readOnlyAdapter(() => {
      const servers = deps.settings.get().mcpServers;
      const enabled = servers.filter((server) => server.enabled !== false).length;
      return servers.length === 0
        ? snapshot('unconfigured', null, '没有安装 MCP 服务')
        : snapshot('configured', null, `已安装 ${servers.length} 个，启用 ${enabled} 个`);
    }),
    'connections.taint-guard': taintGuardAdapter(deps),
    'agents.external': externalAgentsAdapter(deps),
    'agents.default': agentsDefaultAdapter(deps),
    'bot.model': botModelAdapter(deps, 'model'),
    'bot.light-model': botModelAdapter(deps, 'light_model'),
    'bot.browser-profile': readOnlyAdapter((target) => {
      const profileId = botField(deps, target, (bot) => bot.profile.runtime.browser_profile);
      if (profileId === null) return snapshot('unknown', null, 'Bot 不存在');
      if (profileId.length === 0) return snapshot('configured', { profile: '' }, '私有资料');
      const shared = deps.settings
        .get()
        .browserProfiles.find((profile) => profile.id === profileId);
      return snapshot(
        'configured',
        { profile: profileId },
        `共享资料「${clean(shared?.name ?? profileId, 30)}」`,
      );
    }),
    'bot.network': readOnlyAdapter((target) => {
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
    }),
    'bot.mcp-servers': readOnlyAdapter((target) => {
      const ids = botField(deps, target, (bot) => bot.profile.runtime.mcp_server_ids);
      if (ids === null) return snapshot('unknown', null, 'Bot 不存在');
      return snapshot(
        ids.length > 0 ? 'configured' : 'unconfigured',
        null,
        `启用 ${ids.length} 个 MCP 服务`,
      );
    }),
    'bot.apps': readOnlyAdapter((target) => {
      const ids = botField(deps, target, (bot) => bot.profile.runtime.app_connection_ids);
      if (ids === null) return snapshot('unknown', null, 'Bot 不存在');
      return snapshot(
        ids.length > 0 ? 'configured' : 'unconfigured',
        null,
        `授权了 ${ids.length} 个连接`,
      );
    }),
    'bot.agent': readOnlyAdapter((target) => {
      const agent = botField(deps, target, (bot) => bot.profile.runtime.agent);
      if (agent === null) return snapshot('unknown', null, 'Bot 不存在');
      return agent.id.length === 0
        ? snapshot('configured', { agent: '' }, '内置引擎')
        : snapshot(
            'configured',
            { agent: agent.id, permission: agent.permission },
            `外部智能体 ${clean(agent.id, 30)}`,
          );
    }),
    'group.title': readOnlyAdapter((target) => {
      const conversation =
        target.conversationId !== null
          ? (deps.conversations?.get(target.conversationId) ?? null)
          : null;
      if (conversation === null || conversation.type !== 'group') {
        return snapshot('unknown', null, '当前不是群聊');
      }
      return snapshot(
        'configured',
        { title: clean(conversation.title ?? '', 60) },
        clean(conversation.title ?? '（未命名）', 60),
      );
    }),
    'general.launch-at-login': launchAtLoginAdapter(deps),
    'background.tasks': backgroundTasksAdapter(deps),
    'background.budget': budgetAdapter(deps),
    'unattended.enable': unattendedAdapter(deps, 'enable'),
    'unattended.disable': unattendedAdapter(deps, 'disable'),
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
