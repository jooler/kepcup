import {
  sanitizeDisplayText,
  type PluginInstanceSummary,
  type PluginSummary,
} from '@kepcup/shared';
import { snapshot, type AdapterDeps, type ItemAdapter } from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * MCP 组：插件工具服务实例（`mcp.instance`）的只读适配器。写入在渲染层卡片里经原 RPC
 * 完成（`plugins.instances.create` / `update`：异步、凭据进 secrets、落地 mcpServers 后
 * 还要对账），不适合放进设置写锁；卡片保存后由 `completeCard` 核对。授权给哪个 Bot
 * 不在这里——那是 `bot.mcp-servers` 条目（`mcp_server_ids` 勾选）。
 */

function clean(text: string, max = 60): string {
  return sanitizeDisplayText(text, max);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** 已安装且声明了 mcp 实例能力的插件（腾讯文档 / 飞书 / 语雀这类工具插件）。 */
function instancePlugins(deps: AdapterDeps): PluginSummary[] {
  return (deps.plugins?.list() ?? []).filter((plugin) => plugin.providesInstances.includes('mcp'));
}

function instancesOf(deps: AdapterDeps, pluginId: string): PluginInstanceSummary[] {
  return (deps.plugins?.instances?.(pluginId) ?? []).filter((entry) => entry.kind === 'mcp');
}

/** 没给 focus 时的缺省插件：优先这个 Bot 已启用的，再退第一个候选（同 mail.plugin）。 */
function defaultPlugin(deps: AdapterDeps, target: { botId: string | null }): PluginSummary | null {
  const candidates = instancePlugins(deps);
  if (candidates.length === 0) return null;
  const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
  const enabledIds = new Set(bot?.profile.runtime.plugin_ids ?? []);
  return (
    candidates.find((plugin) => enabledIds.has(plugin.id) && plugin.enabled) ??
    candidates.find((plugin) => plugin.enabled) ??
    candidates[0]!
  );
}

export const mcpInstanceAdapter = (deps: AdapterDeps): ItemAdapter => ({
  // Bot 的 values 只寻址（哪个插件 / 哪个实例），token 等凭据不在 values 里：实例已配置时
  // 「改一下 token」的提议值也和现状相同，不能被「已经是这个值」短路，要照常出待填卡。
  requiresForm: () => true,
  // 「我已设置好」的硬证据：寻址到的实例里，插件声明的必填字段都已落值（敏感字段看已存
  // secret 键，非敏感看 values）。核对不了（模块未就绪 / 插件不在）回 null，交给宿主兜底。
  verifyComplete: (_item, proposed, snap) => {
    if (deps.plugins === undefined) return null;
    const pluginId = str(proposed?.plugin) ?? str(snap.values?.plugin);
    if (pluginId === undefined) return null;
    const plugin = instancePlugins(deps).find((entry) => entry.id === pluginId);
    if (plugin === undefined) return null;
    const instances = instancesOf(deps, plugin.id);
    if (instances.length === 0) return false;
    const wanted = str(proposed?.instance) ?? str(snap.values?.instance);
    const targets =
      wanted === undefined ? instances : instances.filter((entry) => entry.id === wanted);
    if (targets.length === 0) return false;
    return targets.every((entry) =>
      plugin.instanceFields.every((field) => {
        if (!field.required) return true;
        if (field.sensitive === true) return entry.storedSensitiveKeys.includes(field.key);
        const value = entry.values[field.key];
        return typeof value === 'string'
          ? value.trim().length > 0
          : value !== undefined && value !== null;
      }),
    );
  },
  read: (_item, target, focus) => {
    if (deps.plugins === undefined) {
      return snapshot('unknown', null, '插件模块未就绪');
    }
    const candidates = instancePlugins(deps);
    if (candidates.length === 0) {
      return snapshot('unconfigured', null, '还没有安装提供工具服务的插件');
    }
    const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
    const enabledIds = new Set(bot?.profile.runtime.plugin_ids ?? []);
    const focused = str(focus?.plugin);
    const plugin =
      candidates.find((entry) => entry.id === focused) ??
      candidates.find((entry) => enabledIds.has(entry.id)) ??
      candidates[0]!;
    const instances = instancesOf(deps, plugin.id);
    const focusedInstance = str(focus?.instance);
    const selected =
      instances.find((entry) => entry.id === focusedInstance) ?? instances[0] ?? null;
    const name = clean(plugin.name, 30);
    const disabled = plugin.enabled ? '' : `「${name}」已停用；`;
    const summary = selected
      ? `${disabled}「${name}」有 ${instances.length} 个工具服务（当前 ${clean(selected.title, 30)}）`
      : `${disabled}「${name}」还没有添加工具服务`;
    return snapshot(
      plugin.enabled ? (selected !== null ? 'configured' : 'unconfigured') : 'partial',
      { plugin: plugin.id, ...(selected !== null ? { instance: selected.id } : {}) },
      summary,
    );
  },
  options: (field, _item, target) => {
    if (field.name === 'plugin') {
      return instancePlugins(deps).map((plugin) => ({
        value: plugin.id,
        label: clean(plugin.name),
      }));
    }
    if (field.name === 'instance') {
      const plugin = defaultPlugin(deps, target);
      return plugin === null
        ? []
        : instancesOf(deps, plugin.id).map((entry) => ({
            value: entry.id,
            label: clean(entry.title),
          }));
    }
    return [];
  },
  normalize: (_item, values) => {
    if (deps.plugins === undefined) {
      return { ok: false, message: '插件模块未就绪，暂时不能修改工具服务' };
    }
    const next = { ...values };
    // 空串实例 = 不指名（新建），当没给处理。
    const emptyish = (value: unknown): string | undefined => {
      const text = str(value);
      return text !== undefined && text.length > 0 ? text : undefined;
    };
    // instance 只在有了插件之后才有意义；单独给 instance 时按实例反查属主插件。
    if (!('plugin' in next) && 'instance' in next) {
      const instanceId = emptyish(next.instance);
      const owner =
        instanceId === undefined
          ? undefined
          : instancePlugins(deps).find((plugin) =>
              instancesOf(deps, plugin.id).some((entry) => entry.id === instanceId),
            );
      if (owner === undefined) return { ok: false, message: `没有这个工具服务：${instanceId ?? ''}` };
      next.plugin = owner.id;
    }
    if ('instance' in next && emptyish(next.instance) === undefined) {
      delete next.instance;
    }
    if ('plugin' in next) {
      const pluginId = str(next.plugin);
      if (pluginId === undefined) return { ok: false, message: '缺少插件 id' };
      if (!instancePlugins(deps).some((plugin) => plugin.id === pluginId)) {
        return { ok: false, message: `没有这个提供工具服务的插件：${pluginId}` };
      }
      next.plugin = pluginId;
      const instanceId = 'instance' in next ? emptyish(next.instance) : undefined;
      if (
        instanceId !== undefined &&
        !instancesOf(deps, pluginId).some((entry) => entry.id === instanceId)
      ) {
        return { ok: false, message: `「${clean(pluginId, 40)}」没有这个工具服务：${instanceId}` };
      }
    }
    return { ok: true, values: next };
  },
});

/**
 * 没有同步写入（渲染层卡片经原 RPC 保存）；这里登记读 / 可选值 / 校验。
 */
export const mcpContribution: SettingAdapterContribution = {
  name: 'mcp',
  adapters: {
    'mcp.instance': mcpInstanceAdapter,
  },
};
