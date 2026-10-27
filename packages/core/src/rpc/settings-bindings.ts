import type { z } from 'zod';
import {
  AppError,
  CAPABILITY_SETTING_IDS,
  itemIdsForBotPaths,
  itemIdsForServiceMethod,
  itemIdsForSettingsPaths,
  settingsCardInputSchema,
  settingsCardsCompleteInputSchema,
  settingsCardsCompleteOutputSchema,
  settingsCardsDismissOutputSchema,
  settingsCardsUndoOutputSchema,
  settingsItemsApplyInputSchema,
  settingsItemsApplyOutputSchema,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { SettingsCatalogHost } from '../settings/host.js';
import type { RpcMethodSpec } from './server.js';

/**
 * 设置目录的 RPC（todo/conversational-app-setup.md §4.1 / §6）：`settings.items.apply`（卡片 /
 * 设置页按条目保存，条目级 CAS）与设置卡的三个动作；以及让设置页原有保存路径补发
 * `settings.changed{itemIds}` 的包装。
 */

function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return { input, output, handle: handle as (value: unknown) => Promise<unknown> };
}

function requireHost(services: CoreServices): SettingsCatalogHost {
  if (!services.settingsCatalog) throw new AppError('NOT_IMPLEMENTED', '设置目录未就绪');
  return services.settingsCatalog;
}

export function bindSettingsCatalogMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  return {
    'settings.items.apply': method(
      settingsItemsApplyInputSchema,
      settingsItemsApplyOutputSchema,
      async (input) =>
        requireHost(services).applyItem({
          itemId: input.itemId,
          values: input.values,
          expected: input.expected,
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
        }),
    ),
    'settings.cards.dismiss': method(
      settingsCardInputSchema,
      settingsCardsDismissOutputSchema,
      async (input) => requireHost(services).dismissCard(input.messageId),
    ),
    'settings.cards.complete': method(
      settingsCardsCompleteInputSchema,
      settingsCardsCompleteOutputSchema,
      async (input) =>
        requireHost(services).completeCard(
          input.messageId,
          input.auto === true ? { auto: true } : {},
        ),
    ),
    'settings.cards.recheck': method(
      settingsCardInputSchema,
      settingsCardsCompleteOutputSchema,
      async (input) => requireHost(services).recheckCard(input.messageId),
    ),
    'settings.cards.undo': method(
      settingsCardInputSchema,
      settingsCardsUndoOutputSchema,
      async (input) => requireHost(services).undoCard(input.messageId),
    ),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `settings.update` 前后真正变化的点路径（对象字段下钻一层：`capabilityModels.image`、
 * `apps.taintGuard`），只看本次 patch 带的顶层键。
 */
export function changedSettingsPaths(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const paths: string[] = [];
  for (const key of keys) {
    const before = previous[key];
    const after = next[key];
    if (isPlainObject(before) && isPlainObject(after)) {
      for (const sub of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[sub]) !== JSON.stringify(after[sub])) paths.push(`${key}.${sub}`);
      }
    } else if (JSON.stringify(before) !== JSON.stringify(after)) {
      paths.push(key);
    }
  }
  return paths;
}


/**
 * 设置页原有的保存路径（专用 RPC）成功后受影响的目录条目（§4.1「设置页原有的保存路径也补发」）。
 * `settings.update` / `bots.update` 按前后差异在各自 handler 里算，不在这里。
 */
const KEY_ITEMS = itemIdsForSettingsPaths([
  'customProviders',
  'vendorProviders',
  'defaultMainModel',
  'defaultLightModel',
]);
const EXTRA_METHOD_ITEMS: Readonly<Record<string, readonly string[]>> = {
  // 厂商 Key 决定模型与能力模型是否可用。
  'providers.setKey': [...KEY_ITEMS, ...Object.values(CAPABILITY_SETTING_IDS)],
  'providers.removeKey': [...KEY_ITEMS, ...Object.values(CAPABILITY_SETTING_IDS)],
  'websearch.setKey': itemIdsForSettingsPaths(['webSearch']),
  'websearch.removeKey': itemIdsForSettingsPaths(['webSearch']),
  'embedding.configure': itemIdsForSettingsPaths(['embedding']),
  'mcp.setSecret': itemIdsForSettingsPaths(['mcpServers']),
  'mcp.removeSecret': itemIdsForSettingsPaths(['mcpServers']),
  'mcp.removeServer': itemIdsForSettingsPaths(['mcpServers']),
  // D104：插件安装 / 卸载 / 启停间接改了 `mcpServers`（内嵌 MCPB / http server），补发 settings.changed。
  'plugins.install': itemIdsForSettingsPaths(['mcpServers']),
  'plugins.uninstall': itemIdsForSettingsPaths(['mcpServers']),
  'plugins.setEnabled': itemIdsForSettingsPaths(['mcpServers']),
  'agents.enable': itemIdsForSettingsPaths(['agents']),
  'agents.disable': itemIdsForSettingsPaths(['agents']),
  'agents.login': itemIdsForSettingsPaths(['agents']),
  'agents.logout': itemIdsForSettingsPaths(['agents']),
  'agents.uninstall': itemIdsForSettingsPaths(['agents']),
};

/** 某个 RPC 成功后要补发的条目 id（没有 = 空）。 */
export function itemIdsForMethod(name: string): string[] {
  return [...new Set([...(EXTRA_METHOD_ITEMS[name] ?? []), ...itemIdsForServiceMethod(name)])];
}

/**
 * 包装已绑定的方法：成功返回后按 {@link itemIdsForMethod} 补发 `settings.changed`。失败不发；
 * 补发失败不影响原方法的结果。
 */
export function withSettingsChangedEvents(
  methods: Record<string, RpcMethodSpec>,
  publishChanged: (itemIds: readonly string[]) => void,
): Record<string, RpcMethodSpec> {
  const wrapped: Record<string, RpcMethodSpec> = {};
  for (const [name, spec] of Object.entries(methods)) {
    const itemIds = itemIdsForMethod(name);
    wrapped[name] =
      itemIds.length === 0
        ? spec
        : {
            ...spec,
            handle: async (value: unknown) => {
              const result = await spec.handle(value);
              try {
                publishChanged(itemIds);
              } catch {
                // 广播失败不影响已经完成的保存。
              }
              return result;
            },
          };
  }
  return wrapped;
}

export { itemIdsForBotPaths, itemIdsForSettingsPaths };
export { changedBotRuntimePaths } from '../settings/bot-profile-update.js';
