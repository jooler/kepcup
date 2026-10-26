import { parsePresetAvatar } from '$lib/avatars/presets';
import { chat } from '$lib/stores/chat.svelte';
import { contacts } from '$lib/stores/contacts.svelte';

/**
 * 执行者的头像：优先取项目会话里的成员数据（改头像会即时反映），
 * 退回落通讯录名册。都没有时返回 null，BotAvatar 退回首字母占位。
 */
export function botAvatarOf(botId: string): string | null {
  return (
    chat.main.members.find((member) => member.bot.id === botId)?.bot.avatar ??
    contacts.bots.find((bot) => bot.id === botId)?.avatar ??
    null
  );
}

/**
 * Bot 名称跟随自己预置头像的填充色（与头像同色）。上传头像 / 首字母占位
 * 没有可用的颜色，返回 undefined，名称用默认前景色。
 */
export function botNameColor(avatar: string | null): string | undefined {
  return parsePresetAvatar(avatar)?.color.hex;
}
