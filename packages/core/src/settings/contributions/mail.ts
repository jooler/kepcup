import { sanitizeDisplayText, type PluginSummary, type SettingOption } from '@kepcup/shared';
import { snapshot, type AdapterDeps, type ItemAdapter } from '../adapters.js';
import type { SettingAdapterContribution } from './types.js';

/**
 * 邮件组：邮件插件（`mail.plugin`）与已配置邮箱（`mail.mailbox`）的只读适配器。
 * 两个条目的写入都在渲染层组件里经原 RPC 完成（插件 config / 启停、邮箱绑定 / 暂停）：
 * 插件 config 与启停是异步的（`plugins.setConfig` / `setEnabled`），邮箱账号的更新也要测连，
 * 都不适合放进设置写锁里的同步写入；卡片保存后由 `completeCard` 核对。
 */

function clean(text: string, max = 60): string {
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

/** 已安装且声明了 mail 实例能力的插件。 */
function mailPlugins(deps: AdapterDeps): PluginSummary[] {
  return (deps.plugins?.list() ?? []).filter((plugin) => plugin.providesInstances.includes('mail'));
}

function pluginOptions(plugins: readonly PluginSummary[]): SettingOption[] {
  return plugins.map((plugin) => ({
    value: plugin.id,
    label: clean(plugin.name),
  }));
}

export const mailPluginAdapter = (deps: AdapterDeps): ItemAdapter => ({
  read: (_item, target, focus) => {
    if (deps.plugins === undefined) {
      return snapshot('unknown', null, '插件模块未就绪');
    }
    const candidates = mailPlugins(deps);
    if (candidates.length === 0) {
      return snapshot('unconfigured', null, '还没有安装邮件插件');
    }
    const bot = target.botId !== null ? deps.bots.get(target.botId) : null;
    const enabledIds = new Set(bot?.profile.runtime.plugin_ids ?? []);
    const focused = str(focus?.plugin);
    const selected =
      candidates.find((plugin) => plugin.id === focused) ??
      candidates.find((plugin) => enabledIds.has(plugin.id)) ??
      candidates[0]!;
    const forBot = enabledIds.has(selected.id);
    const count = selected.instanceCounts.mail;
    const summary = !selected.enabled
      ? `「${clean(selected.name, 30)}」已停用；${count} 个邮箱`
      : forBot
        ? `「${clean(selected.name, 30)}」已交给这个 Bot；${count} 个邮箱`
        : `「${clean(selected.name, 30)}」还没有交给这个 Bot；${count} 个邮箱`;
    return snapshot(
      selected.enabled ? 'configured' : 'partial',
      { plugin: selected.id, enabled: forBot },
      summary,
    );
  },
  options: (field) => (field.name === 'plugin' ? pluginOptions(mailPlugins(deps)) : []),
  normalize: (_item, values) => {
    if (deps.plugins === undefined) {
      return { ok: false, message: '插件模块未就绪，暂时不能修改邮件插件' };
    }
    if (!('plugin' in values)) return { ok: true, values };
    const pluginId = str(values.plugin);
    if (pluginId === undefined) return { ok: false, message: '缺少邮件插件 id' };
    if (!mailPlugins(deps).some((plugin) => plugin.id === pluginId)) {
      return { ok: false, message: `没有这个邮件插件：${pluginId}` };
    }
    return { ok: true, values: { ...values, plugin: pluginId } };
  },
});

export const mailMailboxAdapter = (deps: AdapterDeps): ItemAdapter => ({
  read: (_item, target, focus) => {
    if (deps.mail === undefined) {
      return snapshot('unknown', null, '邮件模块未就绪');
    }
    const accounts = deps.mail.list();
    if (accounts.length === 0) {
      return snapshot('unconfigured', null, '还没有配置好的邮箱');
    }
    const botId = target.botId;
    const focused = str(focus?.account);
    const selected =
      accounts.find((account) => account.id === focused) ??
      accounts.find((account) => botId !== null && account.botIds.includes(botId)) ??
      accounts[0]!;
    const paused = selected.status === 'paused';
    const bots = selected.botIds.length;
    const summary = `${clean(selected.label || selected.address, 40)}：${
      bots === 0 ? '没有交给任何 Bot' : `交给 ${bots} 个 Bot`
    }${paused ? '；已暂停收信' : ''}`;
    return snapshot(
      'configured',
      { account: selected.id, bots: [...selected.botIds], paused },
      summary,
    );
  },
  options: (field) => {
    if (deps.mail === undefined) return [];
    const accounts = deps.mail.list();
    if (field.name === 'account') {
      return accounts.map((account) => ({
        value: account.id,
        label: clean(`${account.label || account.address} <${account.address}>`),
      }));
    }
    if (field.name === 'bots') {
      return (deps.bots.listActive?.() ?? []).map((bot) => ({
        value: bot.id,
        label: clean(bot.name),
      }));
    }
    return [];
  },
  normalize: (_item, values) => {
    if (deps.mail === undefined) {
      return { ok: false, message: '邮件模块未就绪，暂时不能修改邮箱绑定' };
    }
    const next = { ...values };
    if ('account' in next) {
      const accountId = str(next.account);
      if (accountId === undefined) return { ok: false, message: '缺少邮箱 id' };
      if (!deps.mail.list().some((account) => account.id === accountId)) {
        return { ok: false, message: `没有这个邮箱：${accountId}` };
      }
      next.account = accountId;
    }
    if ('bots' in next) {
      const botIds = asStringList(next.bots);
      if (botIds === undefined) return { ok: false, message: 'bots 应为 Bot id 列表' };
      const unknown = botIds.find((id) => {
        const bot = deps.bots.get(id);
        return bot === null || bot.status !== 'active';
      });
      if (unknown !== undefined) return { ok: false, message: `没有这个 Bot：${unknown}` };
      next.bots = botIds;
    }
    return { ok: true, values: next };
  },
});

/**
 * 两个条目都没有同步写入（渲染层卡片经原 RPC 保存）；这里登记读 / 可选值 / 校验。
 */
export const mailContribution: SettingAdapterContribution = {
  name: 'mail',
  adapters: {
    'mail.plugin': mailPluginAdapter,
    'mail.mailbox': mailMailboxAdapter,
  },
};
