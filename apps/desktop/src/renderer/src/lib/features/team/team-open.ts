/**
 * 团队 Bot / 成员 / 项目组的打开动作（侧栏团队分组与通讯录共用）。
 *
 * 团队来源的 `conversations.openDirect` / `team.dm.open` 必须走该来源连接；
 * 失败统一返回 false，由调用方 toast（不伪造会话）。
 */
import type { SourceId } from '$lib/rpc/connections.svelte';
import { connections } from '$lib/rpc/connections.svelte';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';

/** 打开与团队 Bot 的直聊（每 (Bot, 成员) 一条，服务端幂等）。 */
export async function openTeamBotChat(source: SourceId, botId: string): Promise<boolean> {
  try {
    const result = (await connections.get(source).call('conversations.openDirect', {
      botId,
    })) as { conversation: { id: string } };
    await chat.select({ source, id: result.conversation.id });
    return true;
  } catch {
    return false;
  }
}

/** 打开与团队成员（好友）的 dm；self 会话由 `memberId` 缺省表达。 */
export async function openTeamMemberChat(
  source: SourceId,
  memberId: string,
): Promise<boolean> {
  const ref = await contacts.openTeamDm(source, memberId);
  if (ref === null) return false;
  await chat.select(ref);
  return true;
}
