import type { Bot, BotProfile } from '@kepcup/shared';

/**
 * 适配器写 Bot Profile 的入口（D88）：与 `bots.update` / `profile_change` 同一写入路径，
 * 由宿主实现（写库 + `bot.updated` 推送）。
 */
export interface HandoverBotWriter {
  get(botId: string): Bot | null;
  /** 读最新 Profile → `mutate` → 写回并推送。 */
  updateProfile(botId: string, mutate: (profile: BotProfile) => BotProfile): Bot;
}

/** 撤掉 Bot 的某个 MCP server / 连接后中断它用到的运行中任务（W3，同 `bots.update`）。 */
export type RevokeMcp = (serverId: string, botIds: string[]) => void;

/** `{type}:{rest}` 里的 rest；前缀不符 = null。 */
export function keyId(key: string, prefix: string): string | null {
  return key.startsWith(`${prefix}:`) ? key.slice(prefix.length + 1) : null;
}
