import { core } from '$lib/rpc/client.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';

export { INKCOP_LOCAL_TRANSPORT, inkcopCollabEnabled } from './inkcop-collab-prefs';

/**
 * 扩展中心开关：开 = 写 enabled + 探测桥；关 = 只关 flag。
 * 不创建/隐藏任何系统 Bot；智能体关联在各 Bot 详情里完成。
 * 密钥 / baseUrl 由扩展中心凭据区单独保存。
 */
export async function setInkcopCollabEnabled(enabled: boolean): Promise<{
  enabled: boolean;
  online: boolean;
  authError?: boolean;
  tip?: string;
  discoveredApiKey?: string;
  discoveredBaseUrl?: string;
}> {
  const current = settingsStore.settings?.inkcopLocalCollab;
  if (!enabled) {
    const next = await settingsStore.update({
      inkcopLocalCollab: {
        enabled: false,
        apiKey: current?.apiKey ?? '',
        baseUrl: current?.baseUrl ?? '',
      },
    });
    return { enabled: next.inkcopLocalCollab.enabled, online: false };
  }
  let online = false;
  let authError = false;
  let tip: string | undefined;
  let discoveredApiKey: string | undefined;
  let discoveredBaseUrl: string | undefined;
  try {
    const health = (await core.call('inkcop.health', {})) as {
      online: boolean;
      authError?: boolean;
      tip?: string;
      discoveredApiKey?: string;
      discoveredBaseUrl?: string;
    };
    online = health.online === true;
    authError = health.authError === true;
    tip = health.tip;
    discoveredApiKey = health.discoveredApiKey;
    discoveredBaseUrl = health.discoveredBaseUrl;
  } catch (error) {
    tip = error instanceof Error ? error.message : String(error);
  }
  const next = await settingsStore.update({
    inkcopLocalCollab: {
      enabled: true,
      apiKey: current?.apiKey ?? '',
      baseUrl: current?.baseUrl ?? '',
    },
  });
  return {
    enabled: next.inkcopLocalCollab.enabled,
    online,
    authError,
    tip,
    discoveredApiKey,
    discoveredBaseUrl,
  };
}
