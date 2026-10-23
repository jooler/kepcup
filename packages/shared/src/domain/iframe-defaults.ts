/**
 * iframe 内部文档的默认滚动条样式（与应用 app.css 的全局滚动条同款：8px 药丸滑块、
 * 轨道透明）。父页面 CSS 够不到 iframe 文档，由各注入点把它写进文档头部：
 *
 * - Bot 组件：core 的 SDK 垫片注入（`--kc-muted` 有主题变量，随明暗切换）；
 * - kepcup-file 目录预览：主进程协议层对 text/html 注入（无主题变量，走 `#808080`
 *   兜底——中性灰在明暗两种底色下都可用）。
 *
 * 「页面自己定义了滚动条样式」则不注入（{@link htmlDefinesScrollbarStyle}）；注入的
 * 这份也因位置在文档最前，页内后出现的同名规则照常覆盖。
 *
 * 约束：整段 **ASCII 且单行**——ASCII 在任何兼容字符编码下都是自身（协议层注入不碰
 * charset 语义）；单行保证组件注入不破坏「错误行号 = Bot 原文行号」的约定。
 */
export const IFRAME_SCROLLBAR_CSS = [
  '::-webkit-scrollbar{width:8px;height:8px;background:transparent}',
  '::-webkit-scrollbar-track,::-webkit-scrollbar-track-piece,::-webkit-scrollbar-corner{background:transparent;border:none}',
  '::-webkit-scrollbar-thumb{border-radius:9999px;background:color-mix(in oklch,var(--kc-muted,#808080) 35%,transparent)}',
  '::-webkit-scrollbar-thumb:hover{background:color-mix(in oklch,var(--kc-muted,#808080) 55%,transparent)}',
  '*{scrollbar-width:thin;scrollbar-color:color-mix(in oklch,var(--kc-muted,#808080) 35%,transparent) transparent}',
].join('');

/** 页面是否自己定义了滚动条样式（webkit 伪元素或标准属性任一）。 */
export function htmlDefinesScrollbarStyle(html: string): boolean {
  return /::-webkit-scrollbar\b/i.test(html) || /\bscrollbar-(?:width|color)\s*:/i.test(html);
}

/** 注入的 <style> 标记属性：运行时兜底（主进程 executeJavaScript）据此识别已注入。 */
export const IFRAME_SCROLLBAR_STYLE_MARKER = 'data-kepcup-scrollbar';

/**
 * 把默认滚动条样式注入 HTML 文档头部（已定义滚动条样式时原样返回）。插入点与组件
 * 垫片同一策略：`<head>` 开标签之后 → doctype 之后（HTML 解析器会把它归入 head，不
 * 触发 quirks mode）→ 都没有才前置到最开头（本就不规范的文档）。
 */
export function injectIframeScrollbarStyle(html: string): string {
  if (htmlDefinesScrollbarStyle(html)) return html;
  const style = `<style ${IFRAME_SCROLLBAR_STYLE_MARKER}>${IFRAME_SCROLLBAR_CSS}</style>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${style}${html.slice(at)}`;
  }
  const doctype = /<!doctype\s+html[^>]*>/i.exec(html);
  if (doctype !== null) {
    const at = doctype.index + doctype[0].length;
    return `${html.slice(0, at)}${style}${html.slice(at)}`;
  }
  return `${style}${html}`;
}
