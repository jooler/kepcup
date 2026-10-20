import type { Bot } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { settingsStore } from '$lib/stores/settings.svelte';
import { emptyProfile } from '$lib/features/bot-setup';
import { presetForName } from '$lib/avatars/presets';

import {
  INKCOP_LOCAL_TRANSPORT,
  inkcopSystemBotId,
  isInkcopLocalBot,
} from './inkcop-collab-prefs';

export {
  INKCOP_LOCAL_TRANSPORT,
  isInkcopLocalBot,
  inkcopCollabEnabled,
  inkcopSystemBotId,
  isHiddenInkcopConversation,
  isHiddenInkcopBot,
} from './inkcop-collab-prefs';

function buildInkcopSystemProfile() {
  const profile = emptyProfile();
  profile.identity.name = 'InkCop';
  profile.identity.bio = '写作助理 · 经本机连接 InkCop';
  profile.identity.avatar = presetForName('InkCop');
  profile.persona = {
    personality: '专业、耐心的写作助理',
    tone: '清晰、简洁、可执行',
    style: '协助润色、改写、结构与表达；先理解意图再动笔',
    values: '尊重原意；不夸大；不确定处标明',
    sample_dialogues: '',
  };
  profile.role = {
    expertise: '中英文写作、编辑与润色',
    responsibilities: '协助用户完成写作任务。知识检索仍直连 LoomVec，不经本桥。',
  };
  profile.runtime.message_transport = INKCOP_LOCAL_TRANSPORT;
  profile.runtime.inkcop_agent_keys = ['main_agent'];
  return profile;
}

/**
 * 确保系统 InkCop Bot 存在并写回 settings.systemBotId。
 * 不自动打开私聊（扩展中心启停用）；需要打开时调用方自行 chat.openDirect。
 */
export async function ensureInkcopSystemBot(): Promise<Bot> {
  await contacts.refresh();
  const settings = settingsStore.settings;
  const storedId = inkcopSystemBotId(settings);
  if (storedId.length > 0) {
    const existing = contacts.bots.find((bot) => bot.id === storedId);
    if (existing && isInkcopLocalBot(existing)) return existing;
  }
  const found = contacts.bots.find((bot) => isInkcopLocalBot(bot));
  if (found) {
    await settingsStore.update({
      inkcopLocalCollab: { enabled: true, systemBotId: found.id },
    });
    return found;
  }
  try {
    const created = (await core.call('bots.create', {
      profile: buildInkcopSystemProfile(),
      interview: false,
      skipDefaultAgent: true,
    })) as { bot: Bot };
    await Promise.all([contacts.refresh(), chat.refresh()]);
    await settingsStore.update({
      inkcopLocalCollab: { enabled: true, systemBotId: created.bot.id },
    });
    return created.bot;
  } catch (error) {
    toast.error(t('onboarding.createFailed', { reason: String((error as Error).message ?? '') }));
    throw error;
  }
}

/** 扩展中心开关：开 = 探测桥 + 确保系统 Bot；关 = 只改 flag（隐藏不删）。 */
export async function setInkcopCollabEnabled(enabled: boolean): Promise<{
  enabled: boolean;
  online: boolean;
  tip?: string;
  bot?: Bot;
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
    online = false;
    tip = error instanceof Error ? error.message : String(error);
  }
  const bot = await ensureInkcopSystemBot();
  const next = await settingsStore.update({
    inkcopLocalCollab: { enabled: true, systemBotId: bot.id },
  });
  return { enabled: next.inkcopLocalCollab.enabled, online, tip, bot };
}
