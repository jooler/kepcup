import { BUILTIN_AGENT_RUNTIME, type Bot, type BotProfile } from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { teamContext } from '$lib/features/team/team-context.svelte';
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
      inkcop_agent_keys: [],
      capability_entries: [],
      background_model: '',
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
/**
 * 新建 Bot 的目标来源（T7 步骤 5）：团队上下文（web 团队端点 = teamContext；
 * 桌面融合视图 = 第一个已连接的团队来源）下「新建 Bot」走
 * `team.bots.createPrivate`（私有 Bot，62.03 D128）；共享 Bot 的创建入口
 * 维持 T5 隐藏（bot-create surface）。非团队上下文返回 null（本机路径）。
 */
export function teamBotCreateSource(): SourceId | null {
  for (const source of connections.sources()) {
    if (source !== 'local' && connections.get(source).status === 'connected') return source;
  }
  return teamContext.active ? 'local' : null;
}

export async function createBotConversational(): Promise<Bot | null> {
  const teamSource = teamBotCreateSource();
  if (teamSource !== null) return createPrivateTeamBot(teamSource);
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
 * 团队上下文的「新建 Bot」（T7）：team.bots.createPrivate 建私有 Bot，
 * 再经该团队连接开直聊（每 (成员, Bot) 一条）并跳过去。
 */
async function createPrivateTeamBot(source: SourceId): Promise<Bot | null> {
  const conn = connections.get(source);
  try {
    const created = (await conn.callTeam('team.bots.createPrivate', {
      profile: emptyProfile(),
    })) as { bot: Bot };
    const opened = (await conn.call('conversations.openDirect', {
      botId: created.bot.id,
    })) as { conversation: { id: string } };
    shell.closeSettings();
    await chat.select({ source, id: opened.conversation.id });
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
