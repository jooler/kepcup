/** 一个成员头像在堆叠容器里的位置。x/y 是中心点占容器边长的百分比。 */
export interface GroupAvatarSlot {
  x: number;
  y: number;
  /** 直径，占容器边长的百分比。 */
  size: number;
  z: number;
}

/**
 * 群头像堆叠：
 * - 2 个并排
 * - 3 个品字形（上一下二）
 * - 4 个田字
 * - 5 个及以上按种子随机位置、随机层叠；直径相对差异不超过 20%
 *
 * 种子相同则布局稳定，避免每次渲染都跳。
 */
export function groupAvatarSlots(count: number, seed: string): GroupAvatarSlot[] {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 50, y: 50, size: 100, z: 1 }];
  if (count === 2) {
    return [
      { x: 34, y: 50, size: 58, z: 1 },
      { x: 68, y: 50, size: 58, z: 2 },
    ];
  }
  if (count === 3) {
    return [
      { x: 50, y: 32, size: 52, z: 3 },
      { x: 30, y: 70, size: 52, z: 1 },
      { x: 70, y: 70, size: 52, z: 2 },
    ];
  }
  if (count === 4) {
    return [
      { x: 30, y: 30, size: 48, z: 1 },
      { x: 70, y: 30, size: 48, z: 2 },
      { x: 30, y: 70, size: 48, z: 3 },
      { x: 70, y: 70, size: 48, z: 4 },
    ];
  }

  const rng = mulberry32(hashString(seed));
  const slots: GroupAvatarSlot[] = [];
  for (let i = 0; i < count; i += 1) {
    // 1.00–1.20：最大比最小多 20%。
    const scale = 1 + rng() * 0.2;
    const size = 48 * scale;
    slots.push({
      x: 28 + rng() * 44,
      y: 28 + rng() * 44,
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
