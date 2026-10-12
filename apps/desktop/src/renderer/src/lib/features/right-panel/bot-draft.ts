import type { BotProfile } from '@kepcup/shared';

/**
 * 右栏 Profile 草稿是否要用服务端最新 profile 覆盖本地。
 *
 * 同 Bot 的 `bot.updated` / `conversation.updated` 会频繁换新的 bot 对象引用
 * （发消息、run 状态都会推 conversation.updated）。若一律 `draft = clone(bot.profile)`，
 * 防抖自动保存窗口内的未落盘改动（含主模型）会被冲掉，表现为「Bot 设置里改了模型，
 * 请求仍走旧模型」。
 *
 * - 换 Bot / 尚无草稿：必须重载
 * - 同 Bot 且本地有未保存改动：保留草稿
 * - 同 Bot 且本地干净、服务端相对最近保存有变化：接受服务端
 * - 同 Bot 且本地干净、服务端无变化：保持（避免 effect 写入自身死循环）
 */
export function shouldReloadBotDraft(input: {
  sameBot: boolean;
  draft: BotProfile | null;
  savedProfile: BotProfile | null;
  serverProfile: BotProfile;
}): 'reload' | 'keep' {
  if (!input.sameBot) return 'reload';
  if (input.draft === null || input.savedProfile === null) return 'reload';
  if (JSON.stringify(input.draft) !== JSON.stringify(input.savedProfile)) return 'keep';
  if (JSON.stringify(input.serverProfile) !== JSON.stringify(input.savedProfile)) return 'reload';
  return 'keep';
}

/** 相对最近保存，是否只改了引擎相关字段（主模型 / 轻量 / agent）——这类应立即落盘。 */
export function isEngineOnlyChange(saved: BotProfile, draft: BotProfile): boolean {
  if (
    saved.runtime.model === draft.runtime.model &&
    saved.runtime.light_model === draft.runtime.light_model &&
    JSON.stringify(saved.runtime.agent) === JSON.stringify(draft.runtime.agent)
  ) {
    return false;
  }
  const savedRest = { ...saved, runtime: { ...saved.runtime, model: '', light_model: '', agent: null } };
  const draftRest = { ...draft, runtime: { ...draft.runtime, model: '', light_model: '', agent: null } };
  return JSON.stringify(savedRest) === JSON.stringify(draftRest);
}
