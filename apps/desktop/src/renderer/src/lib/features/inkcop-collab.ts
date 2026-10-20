import { core } from '$lib/rpc/client.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';

export { INKCOP_LOCAL_TRANSPORT, inkcopCollabEnabled } from './inkcop-collab-prefs';

/**
 * 扩展中心开关：开 = 写 enabled + 探测桥；关 = 只关 flag。
 * 不创建/隐藏任何系统 Bot；智能体关联在各 Bot 详情里完成。
 */
export async function setInkcopCollabEnabled(enabled: boolean): Promise<{
  enabled: boolean;
  online: boolean;
  tip?: string;
}> {
  if (!enabled) {
    const next = await settingsStore.update({
      inkcopLocalCollab: { enabled: false },
    });
    return { enabled: next.inkcopLocalCollab.enabled, online: false };
  }
  let online = false;
  let tip: string | undefined;
  try {
    const health = (await core.call('inkcop.health', {})) as {
      online: boolean;
      tip?: string;
    };
    online = health.online === true;
    tip = health.tip;
  } catch (error) {
    tip = error instanceof Error ? error.message : String(error);
  }
  const next = await settingsStore.update({
    inkcopLocalCollab: { enabled: true },
  });
  return { enabled: next.inkcopLocalCollab.enabled, online, tip };
}
