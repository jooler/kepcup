import { GROUP_MEMBER_PREVIEW_MAX } from '@kepcup/shared';

/** 一个成员头像在堆叠容器里的位置。x/y 是中心点占容器边长的百分比。 */
export interface GroupAvatarSlot {
  x: number;
  y: number;
  /** 直径，占容器边长的百分比。 */
  size: number;
  z: number;
}

/** 群头像马赛克里代表「当前用户」的固定 id（不入库，仅 UI）。 */
export const GROUP_AVATAR_USER_ID = '__user__';

/**
 * 群头像堆叠：
 * - 2 个并排（略放大、可重叠）
 * - 3 个品字形（上一下二）
 * - 4 个田字
 * - 5 个及以上按种子随机位置、随机层叠；直径相对差异不超过 20%
 * 所有瓦片都落在容器范围内（容器不裁切，字影只允许溢出 1px 量级）。
 *
 * 种子相同则布局稳定，避免每次渲染都跳。count 超过 GROUP_MEMBER_PREVIEW_MAX（与 core
 * 下发的成员预览同一上限）时只给前这么多个位置：再多既看不清，也白白多渲染元素。
 */
export function groupAvatarSlots(total: number, seed: string): GroupAvatarSlot[] {
  const count = Math.min(total, GROUP_MEMBER_PREVIEW_MAX);
  if (count <= 0) return [];
  if (count === 1) return [{ x: 50, y: 50, size: 100, z: 1 }];
  if (count === 2) {
    return [
      { x: 36, y: 50, size: 72, z: 1 },
      { x: 64, y: 50, size: 72, z: 2 },
    ];
  }
  if (count === 3) {
    return [
      { x: 50, y: 33, size: 66, z: 3 },
      { x: 33, y: 67, size: 66, z: 1 },
      { x: 67, y: 67, size: 66, z: 2 },
    ];
  }
  if (count === 4) {
    return [
      { x: 32, y: 32, size: 60, z: 1 },
      { x: 68, y: 32, size: 60, z: 2 },
      { x: 32, y: 68, size: 60, z: 3 },
      { x: 68, y: 68, size: 60, z: 4 },
    ];
  }

  const rng = mulberry32(hashString(seed));
  const slots: GroupAvatarSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    // 1.00–1.20：最大比最小多 20%。
    const scale = 1 + rng() * 0.2;
    const size = 58 * scale;
    // 中心点按直径收在 [size/2, 100 - size/2]：瓦片不再被容器裁切，越界就会压到相邻元素。
    slots.push({
      x: size / 2 + rng() * (100 - size),
      y: size / 2 + rng() * (100 - size),
      size,
      z: i,
    });
  }
  const order = slots.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  for (let z = 0; z < order.length; z += 1) slots[order[z]!]!.z = z;
  return slots;
}

/**
 * 马赛克里实际画出的头像：当前用户排第一，其后是 Bot（成员里若混入用户 id 会被忽略），
 * 总数封顶 GROUP_MEMBER_PREVIEW_MAX。没有任何 Bot（成员未知）时返回空数组，
 * 调用方据此画默认群图标——只剩一个「用户」头像既不像群也不是成员信息。
 */
export function groupAvatarFaces<T extends { id: string }>(
  members: readonly T[],
  user: T | null,
): T[] {
  const bots = members.filter((member) => member.id !== GROUP_AVATAR_USER_ID);
  if (bots.length === 0) return [];
  return (user === null ? bots : [user, ...bots]).slice(0, GROUP_MEMBER_PREVIEW_MAX);
}

/**
 * 字影投影：1px 朝向群头像中心（字素 alpha 投影，不是瓦片容器 box-shadow）。
 * 中心位无方向时略向下。
 */
export function shadowOffsetTowardCenter(slot: Pick<GroupAvatarSlot, 'x' | 'y'>): {
  x: number;
  y: number;
} {
  const dx = 50 - slot.x;
  const dy = 50 - slot.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 1 };
  return { x: dx / len, y: dy / len };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
