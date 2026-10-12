import type { BotProfile } from '@kepcup/shared';

/** 结构相等（与键顺序无关），用于草稿 / 已保存 / 服务端 profile 的比较。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => deepEqual(item, b[index]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && deepEqual(left[key], right[key]))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 三方合并：`base` 是最近保存的版本，`mine` 是本地草稿，`theirs` 是服务端最新。
 * 本地没碰过的字段取服务端的值，本地改过的保留草稿；两边都是对象且本地改过时
 * 向下一层继续按字段合并（`depth` 层），避免「改了模型就丢掉 Bot 自己更新的别的字段」。
 */
function merge3(base: unknown, mine: unknown, theirs: unknown, depth: number): unknown {
  if (deepEqual(base, mine)) return theirs;
  if (deepEqual(base, theirs)) return mine;
  if (depth > 0 && isPlainObject(base) && isPlainObject(mine) && isPlainObject(theirs)) {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const value = merge3(base[key], mine[key], theirs[key], depth - 1);
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  return mine;
}

export type DraftReconcile = { action: 'keep' } | { action: 'replace'; draft: BotProfile };

/**
 * 右栏 Profile 草稿如何对待服务端推来的最新 profile。
 *
 * 同 Bot 的 `bot.updated` / `conversation.updated` 会频繁换新的 bot 对象引用
 * （发消息、run 状态都会推 conversation.updated）。若一律用服务端覆盖草稿，
 * 防抖自动保存窗口内的未落盘改动（含主模型）会被冲掉，表现为「Bot 设置里改了
 * 模型，请求仍走旧模型」。
 *
 * - 换 Bot / 尚无草稿：用服务端版本重载
 * - 服务端相对最近保存没有变化：保持（避免 effect 写入自身死循环）
 * - 服务端有变化且本地干净：接受服务端
 * - 服务端有变化且本地有未保存改动：按字段三方合并——本地改过的保留，其余跟随
 *   服务端（如 Bot 经 save_profile 更新了别的字段），调用方再把合并结果自动保存
 */
export function reconcileBotDraft(input: {
  sameBot: boolean;
  draft: BotProfile | null;
  savedProfile: BotProfile | null;
  serverProfile: BotProfile;
}): DraftReconcile {
  const { draft, savedProfile, serverProfile } = input;
  if (!input.sameBot || draft === null || savedProfile === null) {
    return { action: 'replace', draft: serverProfile };
  }
  if (deepEqual(serverProfile, savedProfile)) return { action: 'keep' };
  if (deepEqual(draft, savedProfile)) return { action: 'replace', draft: serverProfile };
  return {
    action: 'replace',
    draft: merge3(savedProfile, draft, serverProfile, 2) as BotProfile,
  };
}

/** 相对最近保存，是否只改了引擎相关字段（主模型 / 轻量 / agent）——这类应立即落盘。 */
export function isEngineOnlyChange(saved: BotProfile, draft: BotProfile): boolean {
  const same =
    saved.runtime.model === draft.runtime.model &&
    saved.runtime.light_model === draft.runtime.light_model &&
    deepEqual(saved.runtime.agent, draft.runtime.agent);
  if (same) return false;
  // 把草稿的引擎字段换回已保存的值后与已保存版本一致 = 只改了引擎字段。
  const engineReverted: BotProfile = {
    ...draft,
    runtime: {
      ...draft.runtime,
      model: saved.runtime.model,
      light_model: saved.runtime.light_model,
      agent: saved.runtime.agent,
    },
  };
  return deepEqual(engineReverted, saved);
}
