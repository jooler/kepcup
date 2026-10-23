import { z } from 'zod';

/**
 * 「完整 WebApp 档」的目录预览协议（`kepcup-file://`）：FileViewer 浏览 HTML 时，页面在
 * 一个以会话 token 为 host 的协议源里加载（`kepcup-file://{token}/相对路径`），同目录的
 * 相对资源、fetch / WebSocket、localStorage 都按真实 WebApp 工作；隔离由 iframe sandbox
 * 属性 + 独占源 + 主进程导航守卫承担。core 只服务「该对话文件卡登记过的 HTML 所在目录」
 * （会话表在 core 内存里，TTL + LRU），主进程协议处理器按 token 经平台 RPC 取字节。
 */

export const FILE_APP_SCHEME = 'kepcup-file';

/**
 * 预览页外链 → 宿主渲染层的 postMessage 消息类型（docs/design/47）：主进程注入 kepcup-file
 * 帧的桥接脚本拦截外链点击（`target=_blank` 被 sandbox 挡在 Blink 层，导航守卫收不到事件），
 * 发 `{ type, url }` 给父窗口；渲染层校验 `event.source` / origin 后经 `shell:openExternal`
 * 转交系统浏览器，URL scheme 白名单在主进程兜底。
 */
export const FILE_APP_OPEN_EXTERNAL_MESSAGE = 'kepcup:open-external';

/** token = `f` + sha256(canonical 绝对路径) 前 24 hex（core 侧派生）：重开同一文件 = 同一源，localStorage 延续。 */
const TOKEN_PATTERN = /^f[0-9a-f]{24}$/;

/** `files.previewSession`（app，renderer → core）：为对话里一个 HTML artifact 开目录预览会话。 */
export const filePreviewSessionInputSchema = z.object({
  conversationId: z.string().min(1),
  path: z.string().min(1),
});
export const filePreviewSessionOutputSchema = z.object({
  token: z.string().regex(TOKEN_PATTERN),
  size: z.number().int().nonnegative(),
});
export type FilePreviewSessionOutput = z.infer<typeof filePreviewSessionOutputSchema>;

/** `files.previewResource`（平台，主进程协议处理器 → core）：取会话目录内一个文件的字节。 */
export const filePreviewResourceInputSchema = z.object({
  token: z.string().regex(TOKEN_PATTERN),
  rel: z.string().min(1).max(512),
});
export const filePreviewResourceOutputSchema = z.object({
  mime: z.string(),
  dataBase64: z.string(),
});
export type FilePreviewResourceInput = z.infer<typeof filePreviewResourceInputSchema>;
export type FilePreviewResourceOutput = z.infer<typeof filePreviewResourceOutputSchema>;
