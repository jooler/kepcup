import { BUILTIN_AGENT_RUNTIME, type Bot, type BotProfile } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { DEFAULT_AVATAR, presetForName } from '$lib/avatars/presets';

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
      app_connection_ids: [],
      browser_profile: '',
      message_transport: '',
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

/**
 * 在组群输入里回车新建：只有名字和一张预置头像，简介 / 职责 / 性格先空着。
 * 进入访谈状态，但不打开私聊——单聊打开时才问定位，在此之前留在组群输入。
 */
export async function createNamedBot(name: string): Promise<Bot | null> {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const profile = emptyProfile();
  profile.identity.name = trimmed;
  // 名字哈希到预置头像，让同一批新建 Bot 在群头像堆叠里彼此分得开。
  profile.identity.avatar = presetForName(trimmed);
  try {
    const created = (await core.call('bots.create', {
      profile,
      interview: true,
    })) as { bot: Bot };
    await contacts.refresh();
    return created.bot;
  } catch (error) {
    toast.error(t('onboarding.createFailed', { reason: String((error as Error).message ?? '') }));
    return null;
  }
}

/**
 * 侧栏预设：InkCop 写作助理（契约 v0.1 §5）。
 * 消息走本机 Connection 桥（`message_transport: inkcop-local`），不挂 `runtime.agent`
 * （ACP `agent:inkcop` 仍为调试旁路）。创建后直接打开单聊。
 */
export async function createInkCopWritingBot(): Promise<Bot | null> {
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
  profile.runtime.message_transport = 'inkcop-local';
  try {
    const created = (await core.call('bots.create', {
      profile,
      interview: false,
      skipDefaultAgent: true,
    })) as { bot: Bot };
    await Promise.all([contacts.refresh(), chat.refresh()]);
    shell.closeSettings();
    await chat.openDirect(created.bot.id);
    return created.bot;
  } catch (error) {
    toast.error(t('onboarding.createFailed', { reason: String((error as Error).message ?? '') }));
    return null;
  }
}

