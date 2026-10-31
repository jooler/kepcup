import { normalizeBotAvatarMask, type Bot, type BotAvatarMask } from '@kepcup/shared';
import { parsePresetAvatar } from '$lib/avatars/presets';
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

/**
 * Bot 名称跟随自己预置头像的填充色（与头像同色）。上传头像 / 首字母占位
 * 没有可用的颜色，返回 undefined，名称用默认前景色。
 */
export function botNameColor(avatar: string | null): string | undefined {
  return parsePresetAvatar(avatar)?.color.hex;
}
