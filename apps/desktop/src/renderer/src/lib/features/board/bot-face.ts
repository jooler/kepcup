import {
  normalizeBotAvatarMask,
  normalizeBotAvatarPadding,
  type Bot,
  type BotAvatarMask,
} from '@kepcup/shared';
import { resolveAccentColor } from '$lib/avatars/presets';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';

/**
 * 执行者（项目成员）的 Bot 记录：优先取项目会话里的成员数据（改头像 / 名字会即时
 * 反映），退回落通讯录名册。两处查找只写一份，头像与遮罩不会各查各的、查出不同 Bot。
 */
function findBot(botId: string): Bot | null {
  return (
    chat.main.members.find((member) => member.bot.id === botId)?.bot ??
    contacts.bots.find((bot) => bot.id === botId) ??
    null
  );
}

/** 头像值；都没有时返回 null，BotAvatar 退回首字母占位。 */
export function botAvatarOf(botId: string): string | null {
  return findBot(botId)?.avatar ?? null;
}

/** 与 `botAvatarOf` 同源的头像遮罩（缺省 / 未知 = circle）。 */
export function botMaskOf(botId: string): BotAvatarMask {
  return normalizeBotAvatarMask(findBot(botId)?.avatarMask);
}

/** 与 `botAvatarOf` 同源的上传头像内边距（缺省 / 越界 = 0）。 */
export function botPaddingOf(botId: string): number {
  return normalizeBotAvatarPadding(findBot(botId)?.avatarPadding);
}

/**
 * 与 `botAvatarOf` 同源的强调色 id（`bots.accent_color`）：显式值 → 预置头像内嵌色 →
 * 默认。Bot 不存在时返回 undefined（头像退回首字母占位，不需着色）。
 */
export function botAccentColorOf(botId: string): string | undefined {
  const bot = findBot(botId);
  if (bot === null) return undefined;
  return resolveAccentColor(bot.accentColor, bot.avatar).id;
}

/**
 * Bot 名称 / 看板脸跟随的强调色（hex）：与头像形状、是否上传无关。
 * 查不到 Bot 时返回 undefined，名称用默认前景色。
 */
export function botNameColor(botId: string): string | undefined {
  const bot = findBot(botId);
  if (bot === null) return undefined;
  return resolveAccentColor(bot.accentColor, bot.avatar).hex;
}
