import {
  PROJECT_MEMBER_PREVIEW_MAX,
  normalizeBotAccentColor,
  normalizeBotAvatarMask,
  normalizeBotAvatarPadding,
  type Bot,
  type BotAccentColor,
  type BotAvatarMask,
} from '@kepcup/shared';

/**
 * 群头像堆叠用的成员预览（`Conversation.memberPreviews`）。
 *
 * core 的 `ProjectsService.memberPreviews` 与桌面端本地重建（`reloadMembers` /
 * `syncMemberPreviews` / `bot.updated`）必须产出同一形状：漏一个展示字段，同一个
 * 头像就会在侧栏和详情里不一致（例如遮罩退回圆形、强调色退回默认），直到下一次
 * 整份会话重新拉取。
 */
export interface MemberPreview {
  id: string;
  name: string;
  avatar: string | null;
  avatarMask: BotAvatarMask;
  avatarPadding: number;
  /** Bot 强调色；缺省 = 未显式设置（渲染端回退到预置头像内嵌色）。 */
  accentColor?: BotAccentColor;
}

/** 预览需要的 Bot 字段子集：core 下发的 `Bot` 直接可用，测试可用最小对象。 */
export type PreviewBot = Pick<Bot, 'id' | 'name' | 'avatar'> & {
  avatarMask?: BotAvatarMask | null;
  avatarPadding?: number | null;
  accentColor?: BotAccentColor | null;
};

/** 单个 Bot → 预览（遮罩 / 边距按读侧规则归一：缺省 = circle / 0）。 */
export function memberPreviewOf(bot: PreviewBot): MemberPreview {
  const accentColor = normalizeBotAccentColor(bot.accentColor);
  return {
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar ?? null,
    avatarMask: normalizeBotAvatarMask(bot.avatarMask),
    avatarPadding: normalizeBotAvatarPadding(bot.avatarPadding),
    ...(accentColor !== null ? { accentColor } : {}),
  };
}

/** 成员视图 → 预览列表（与 core 下发同一上限，多出来的头像一个也画不下）。 */
export function memberPreviewsOf(members: ReadonlyArray<{ bot: PreviewBot }>): MemberPreview[] {
  return members.slice(0, PROJECT_MEMBER_PREVIEW_MAX).map((member) => memberPreviewOf(member.bot));
}

/** `bot.updated`：只换掉同一个 Bot 的展示字段，顺序与其它成员不动。 */
export function withUpdatedBot(
  previews: ReadonlyArray<PreviewBot>,
  bot: PreviewBot,
): MemberPreview[] {
  return previews.map((preview) => memberPreviewOf(preview.id === bot.id ? bot : preview));
}
