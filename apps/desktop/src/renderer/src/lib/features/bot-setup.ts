import { BUILTIN_AGENT_RUNTIME, type Bot, type BotProfile } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { DEFAULT_AVATAR } from '$lib/avatars/presets';

export function emptyProfile(): BotProfile {
  return {
    identity: { name: '', bio: '', avatar: DEFAULT_AVATAR },
    persona: { personality: '', tone: '', style: '', values: '', sample_dialogues: '' },
    role: { expertise: '', responsibilities: '' },
    boundaries: [],
    runtime: {
      model: '',
      light_model: '',
      network_policy: 'open',
      network_allowlist: [],
      mcp_server_ids: [],
      agent: { ...BUILTIN_AGENT_RUNTIME },
    },
    // P10 guardrail defaults — mirrors botBehaviorSchema.prefault({}) (proactive
    // on, no quiet hours, the MAX_PROACTIVE_PER_DAY default cap).
    behavior: { proactive: true, quiet_hours: null, max_proactive_per_day: null },
  };
}

/**
 * 对话式新建 Bot（参考 Grok Bot）：不弹长表单，创建后直接进入与该 Bot 的
 * 对话，由 Bot 主动提问、根据回答自行完善自己的 Profile（见 core 的
 * setup interview：bots.create interview + bots.interview.start）。
 * 成功后关闭设置弹框（通讯录里的入口在弹框内）。
 */
export async function createBotConversational(): Promise<Bot | null> {
  try {
    const created = (await core.call('bots.create', {
      profile: emptyProfile(),
      interview: true,
    })) as { bot: Bot };
    const started = (await core.call('bots.interview.start', {
      id: created.bot.id,
    })) as { conversationId: string };
    await Promise.all([contacts.refresh(), chat.refresh()]);
    shell.closeSettings();
    await chat.select(started.conversationId);
    return created.bot;
  } catch (error) {
    toast.error(t('onboarding.createFailed', { reason: String((error as Error).message ?? '') }));
    return null;
  }
}
