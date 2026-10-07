/**
 * 预置 Bot 头像（参考 Grok Bot 的「形状 × 单色 + 白色眼睛」风格）。
 *
 * `bots.avatar` 的取值约定（identity.avatar / bots 列，core 原样存储）：
 * - `preset:{shapeId}:{colorId}` —— 纯渲染端 SVG，不落盘；
 * - `upload:{fileName}` —— 上传图片，文件在 core 侧 `bots/{id}/avatar/`；
 * - null / 其它 —— 退回首字母占位。
 *
 * 形状用少量手调参数（圆、圆并集、圆角多边形）拼出 13 种轮廓；全部
 * 100×100 viewBox 的静态 SVG 片段，由 BotPresetAvatar 着色并叠加眼睛。
 */

type Pt = readonly [number, number];

const f = (n: number): string => String(Math.round(n * 100) / 100);

/** 圆角多边形：每个顶点用二次贝塞尔倒圆。 */
function roundedPolygon(points: Pt[], radius: number): string {
  const n = points.length;
  let d = '';
  for (let i = 0; i < n; i++) {
    const prev = points[(i + n - 1) % n]!;
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const len1 = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
    const len2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
    const r1 = Math.min(radius, len1 / 2);
    const r2 = Math.min(radius, len2 / 2);
    const entry: Pt = [
      cur[0] - ((cur[0] - prev[0]) / len1) * r1,
      cur[1] - ((cur[1] - prev[1]) / len1) * r1,
    ];
    const exit: Pt = [
      cur[0] + ((next[0] - cur[0]) / len2) * r2,
      cur[1] + ((next[1] - cur[1]) / len2) * r2,
    ];
    d += `${i === 0 ? 'M' : 'L'}${f(entry[0])} ${f(entry[1])} Q${f(cur[0])} ${f(cur[1])} ${f(exit[0])} ${f(exit[1])} `;
  }
  return `${d}Z`;
}

/** 顶点列表：中心 (cx,cy)、外接半径 R、起始角（度，-90 朝上）。 */
function regularPoints(
  cx: number,
  cy: number,
  radius: number,
  count: number,
  startDeg: number,
): Pt[] {
  return Array.from({ length: count }, (_, i) => {
    const a = ((startDeg + (i * 360) / count) * Math.PI) / 180;
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;
  });
}

/** 星形顶点：外内半径交替。 */
function starPoints(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  spikes: number,
  startDeg: number,
): Pt[] {
  const points: Pt[] = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((startDeg + (i * 180) / spikes) * Math.PI) / 180;
    points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return points;
}

const circles = (list: Array<readonly [number, number, number]>): string =>
  list.map(([cx, cy, r]) => `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}"/>`).join('');

export interface AvatarPresetShape {
  id: string;
  label: string;
  /** 100×100 viewBox 内的静态 SVG 片段（不带 fill，由父级 g 着色）。 */
  markup: string;
  /** 眼睛组的微调（大多数形状居中即可）。 */
  eyeDy?: number;
}

export const AVATAR_SHAPES: AvatarPresetShape[] = [
  { id: 'orb', label: '圆球', markup: '<circle cx="50" cy="51" r="39"/>' },
  {
    id: 'cloud',
    label: '云朵',
    markup:
      circles([
        [34, 55, 19],
        [53, 45, 22],
        [69, 56, 15],
      ]) + '<rect x="16" y="52" width="68" height="24" rx="12"/>',
    eyeDy: 4,
  },
  {
    id: 'tile',
    label: '方圆',
    markup: `<g transform="rotate(14 50 51)"><path d="${roundedPolygon(
      regularPoints(50, 51, 42, 4, -90),
      13,
    )}"/></g>`,
  },
  {
    id: 'spark',
    label: '星形',
    markup: `<path d="${roundedPolygon(starPoints(50, 51, 45, 17, 4, -90), 9)}"/>`,
  },
  {
    id: 'clover',
    label: '四叶',
    markup: circles([
      [36, 39, 17],
      [64, 39, 17],
      [36, 65, 17],
      [64, 65, 17],
      [50, 52, 19],
    ]),
  },
  {
    id: 'heart',
    label: '爱心',
    markup:
      '<path d="M50 84 C24 66 12 50 14 35 C16 20 30 13 41 20 C45 22.5 48 26 50 30 C52 26 55 22.5 59 20 C70 13 84 20 86 35 C88 50 76 66 50 84 Z"/>',
    eyeDy: 3,
  },
  {
    id: 'blossom',
    label: '花朵',
    markup:
      circles([
        [50, 28, 14],
        [69.9, 39.5, 14],
        [69.9, 62.5, 14],
        [50, 74, 14],
        [30.1, 62.5, 14],
        [30.1, 39.5, 14],
      ]) + '<circle cx="50" cy="51" r="17"/>',
  },
  {
    id: 'drop',
    label: '水滴',
    markup: '<path d="M50 9 C56 29 81 39 81 61 A31 31 0 1 1 19 61 C19 39 44 29 50 9 Z"/>',
    eyeDy: 5,
  },
  {
    id: 'pill',
    label: '胶囊',
    markup:
      '<g transform="rotate(32 50 51)"><rect x="16" y="32" width="68" height="38" rx="19"/></g>',
  },
  {
    id: 'cone',
    label: '三角',
    markup: `<g transform="rotate(-8 50 51)"><path d="${roundedPolygon(
      [
        [50, 11],
        [88, 81],
        [12, 81],
      ],
      14,
    )}"/></g>`,
    eyeDy: 2,
  },
  {
    id: 'pentagon',
    label: '五边',
    markup: `<path d="${roundedPolygon(regularPoints(50, 53, 41, 5, -90), 12)}"/>`,
    eyeDy: -1,
  },
  {
    id: 'splat',
    label: '泼墨',
    markup: circles([
      [50, 51, 25],
      [31, 42, 14],
      [68, 38, 12],
      [67, 63, 13],
      [34, 66, 12],
      [51, 30, 12],
      [52, 72, 10],
    ]),
  },
  {
    id: 'hex',
    label: '六边',
    markup: `<path d="${roundedPolygon(regularPoints(50, 51, 42, 6, -90), 11)}"/>`,
  },
];

export interface AvatarPresetColor {
  id: string;
  label: string;
  /**
   * 填充色（任意 CSS color，可为 var() 主题变量引用）。第一种「黑白」引用
   * --avatar-mono（app.css 定义）：亮色风格渲染为黑、暗色风格渲染为白，
   * 所有 Bot 头像与用户气泡同步翻转。
   */
  hex: string;
  /** 填充色之上的前景色（眼睛 / 用户气泡文字）；缺省白色。 */
  contrast?: string;
}

/**
 * 取色对齐截图 2 的两行色板。第一种「黑白」即曾被去掉的黑色——改为随主题
 * 动态取色（亮色黑 / 暗色白）后，暗色下不再不可见，恢复为第一位；
 * Reset 回第一种（黑白）。
 */
export const AVATAR_COLORS: AvatarPresetColor[] = [
  {
    id: 'mono',
    label: '黑白',
    hex: 'var(--avatar-mono)',
    contrast: 'var(--avatar-mono-contrast)',
  },
  { id: 'brown', label: '棕褐', hex: '#8d6e5b' },
  { id: 'red', label: '绯红', hex: '#e5484d' },
  { id: 'orange', label: '活力橙', hex: '#ee6b2e' },
  { id: 'amber', label: '琥珀', hex: '#f2a33c' },
  { id: 'green', label: '草木绿', hex: '#46a758' },
  { id: 'teal', label: '青碧', hex: '#2fa89e' },
  { id: 'blue', label: '晴空蓝', hex: '#3f7fe0' },
  { id: 'purple', label: '紫罗兰', hex: '#8e5ad8' },
  { id: 'pink', label: '桃粉', hex: '#e055a8' },
  { id: 'gray', label: '石灰', hex: '#9ba1a6' },
];

const shapeById = new Map(AVATAR_SHAPES.map((shape) => [shape.id, shape]));
const colorById = new Map(AVATAR_COLORS.map((color) => [color.id, color]));

export function formatPresetAvatar(shapeId: string, colorId: string): string {
  return `preset:${shapeId}:${colorId}`;
}

/** Reset 语义：预置第一个形状 + 第一种颜色。 */
export const DEFAULT_AVATAR = formatPresetAvatar(AVATAR_SHAPES[0]!.id, AVATAR_COLORS[0]!.id);

export interface ParsedPresetAvatar {
  shape: AvatarPresetShape;
  color: AvatarPresetColor;
}

export function parsePresetAvatar(value: string | null | undefined): ParsedPresetAvatar | null {
  if (!value?.startsWith('preset:')) return null;
  const [, shapeId, colorId] = value.split(':');
  const shape = shapeById.get(shapeId ?? '');
  const color = colorById.get(colorId ?? '');
  if (!shape || !color) return null;
  return { shape, color };
}

/** 填充色之上的前景（眼睛 / 用户气泡文字）：动态色取对比变量，其余一律白。 */
export function avatarColorForeground(color: AvatarPresetColor): string {
  return color.contrast ?? '#ffffff';
}

/** `upload:{fileName}` 的文件名；非上传值返回 null。 */
export function parseUploadedAvatar(value: string | null | undefined): string | null {
  if (!value?.startsWith('upload:')) return null;
  const file = value.slice('upload:'.length);
  return file.length > 0 && !file.includes('/') ? file : null;
}
