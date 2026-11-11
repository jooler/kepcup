import type { Component } from 'svelte';
import type { PluginConfig, StreamdownComponents, StreamdownControlsConfig } from 'streamdown-svelte';

/** Markdown 渲染的统一控件配置：表格内容不需要导出下载，工具条只留复制 / 全屏。 */
export const MARKDOWN_CONTROLS: StreamdownControlsConfig = { table: { download: false } };

export interface MarkdownComponentProps {
  content: string;
  controls?: StreamdownControlsConfig;
  plugins?: PluginConfig;
  /** 关掉流式残缺语法补全（用户消息是完整文本，不需要 remend）。 */
  parseIncompleteMarkdown?: boolean;
  /** 元素级覆盖（用户气泡用它把 @提及链接渲染成胶囊）。 */
  components?: StreamdownComponents;
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
   * 公式与图表插件在锁定 chunk 之后才创建（包本体按需加载的前提不变）。
   * Streamdown 的 KaTeX / Mermaid 都是 opt-in：不挂 plugins.math 时 `$...$`
   * 按纯文本输出，不挂 plugins.mermaid 时 ```mermaid 退化成普通代码块；
   * mermaid 库本身仍由 Mermaid 组件在首次出现图表时才动态 import，不随
   * 消息列表一起加载。
   */
  plugins = $state<PluginConfig | undefined>(undefined);
  #started = false;

  /** Idempotent; safe to call from every bot bubble's effect. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void import('streamdown-svelte').then((m) => {
      this.plugins = { math: m.createMathPlugin(), mermaid: m.createMermaidPlugin() };
      this.component = m.Streamdown as Component<MarkdownComponentProps>;
    });
  }
}

export const lazyMarkdown = new LazyMarkdown();
