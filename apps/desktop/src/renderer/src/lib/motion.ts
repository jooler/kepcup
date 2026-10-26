/**
 * 全局动效时长与 reduced-motion 兜底。
 *
 * CSS 侧（tw-animate-css）靠 app.css 的媒体查询关掉；Svelte 的 JS transition
 * 不会自己读媒体查询，时长经 motionMs 传入——系统开启「减弱动态效果」时为 0，
 * 过渡变成瞬时完成，语义与直接不播放一致。
 */
export const MOTION = {
  /** 抽屉 / 全屏层进场。 */
  enter: 200,
  /** 收起比展开快一点，减少等待感。 */
  exit: 140,
  /** 内容切换的淡入。 */
  content: 140,
} as const;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function motionMs(duration: number): number {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return duration;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches ? 0 : duration;
}
