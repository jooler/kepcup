import type { Component } from 'svelte';
import type { PluginConfig, StreamdownControlsConfig } from 'streamdown-svelte';

/** Markdown 渲染的统一控件配置：表格内容不需要导出下载，工具条只留复制 / 全屏。 */
export const MARKDOWN_CONTROLS: StreamdownControlsConfig = { table: { download: false } };

export interface MarkdownComponentProps {
  content: string;
  controls?: StreamdownControlsConfig;
  plugins?: PluginConfig;
}

/**
 * Lazily loads the markdown pipeline (streamdown-svelte + shiki + katex,
 * docs/design/12-ui-layout.md 消息渲染). P13 任务 7 evidence: these libraries
 * dominate the renderer's eager entry chunk (~3MB of ~4MB parsed code) while
 * the app's live JS heap is only ~16MB — importing them at startup costs
 * renderer working set and cold-boot time for a capability most sessions use
 * only after a bot answers. A module-level singleton loads the chunk once;
 * every message bubble re-renders when it arrives.
 */
class LazyMarkdown {
  component = $state<Component<MarkdownComponentProps> | null>(null);
  /**
   * 图表插件在锁定 chunk 之后才创建（包本体按需加载的前提不变）。
   * Mermaid 代码块（```mermaid）默认只会退化成普通代码块，必须显式挂上
   * plugins.mermaid 才走 Mermaid 组件渲染；mermaid 库本身仍由该组件在
   * 首次出现图表时才动态 import，不随消息列表一起加载。
   */
  plugins = $state<PluginConfig | undefined>(undefined);
  #started = false;

  /** Idempotent; safe to call from every bot bubble's effect. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void import('streamdown-svelte').then((m) => {
      this.plugins = { mermaid: m.createMermaidPlugin() };
      this.component = m.Streamdown as Component<MarkdownComponentProps>;
    });
  }
}

export const lazyMarkdown = new LazyMarkdown();
