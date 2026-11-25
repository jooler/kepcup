import {
  BUILTIN_AGENT_RUNTIME,
  type Bot,
  type BotProfile,
  type TeamBotView,
} from '@kepcup/shared';
import { toast } from 'svelte-sonner';
import { t } from '$lib/i18n';
import { core } from '$lib/rpc/client.svelte';
import { connections, type SourceId } from '$lib/rpc/connections.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { DEFAULT_AVATAR, presetForName } from '$lib/avatars/presets';
import { teamBots, type TeamBotCreateInput } from '$lib/features/team/team-bots.svelte';

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
 *
 * 本机路径（D128 修订版 → member-bots B4）：**本机**私有 Bot 恒在本机客户端
 * 创建（bots.create 本机路径，本入口）；团队服务器上的成员侧创建走下面的
 * `createTeamBotConversational`（team.bots.create，服务端编排访谈）。
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

// --- 团队面（member-bots B4 子域 A）---------------------------------------------------
//
// 本机路径的语义零变化：以上三个入口仍恒走 core。团队服务器的成员侧创建 /
// 访谈作答按会话所属来源路由（见 features/chats/interview-routing.ts：
// local → core.call 即现行为；team → 该来源连接），B2 服务端对成员访谈会话
// 做 owner 判定（botInterview resolver）。

export type TeamBotCreateResult =
  | { ok: true; bot: TeamBotView }
  | { ok: false; code: string };

/**
 * 团队版对话式建 Bot（2026-11「+」菜单重构后的直建入口，原 TeamCreateBotDialog
 * 已随对话框一并移除）：`team.bots.create { interview: true }` 在服务端建 Bot、
 * 开直聊会话并启动访谈（B-11）；客户端经同一来源幂等 openDirect 拿到该会话并
 * 跳转（团队来源切片）。错误码原样返回（调用方 toast，BOT_LIMIT_REACHED 等）。
 */
export async function createTeamBotConversational(
  source: SourceId,
  input: TeamBotCreateInput,
): Promise<TeamBotCreateResult> {
  try {
    const bot = await teamBots.createBot(source, input);
    const opened = (await connections.get(source).call('conversations.openDirect', {
      botId: bot.id,
    })) as { conversation: { id: string } };
    await chat.select({ source, id: opened.conversation.id });
    return { ok: true, bot };
  } catch (error) {
    return { ok: false, code: errorCodeOf(error) };
  }
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: string } | undefined)?.code;
  return typeof code === 'string' ? code : 'INTERNAL';
}
