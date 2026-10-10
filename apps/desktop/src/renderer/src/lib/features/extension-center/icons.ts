import * as Lucide from '@lucide/svelte';
import type { Component } from 'svelte';

/**
 * catalog.json 里的 icon 是 lucide 的 kebab-case 图标名（file-text /
 * table-2 / presentation …）。运行时映射到组件；未知名字回退 Puzzle，
 * 让新增的 catalog 条目永远可渲染。
 */
export function presetIcon(name: string): Component<{ class?: string }> {
  const pascal = name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const candidate = (Lucide as unknown as Record<string, unknown>)[pascal];
  if (typeof candidate === 'function' || (candidate !== null && typeof candidate === 'object')) {
    return candidate as Component<{ class?: string }>;
  }
  return Lucide.Puzzle as unknown as Component<{ class?: string }>;
}
