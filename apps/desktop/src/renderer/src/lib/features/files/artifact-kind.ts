import type { MessageKey } from '$lib/i18n';

/**
 * How a Bot-produced file is previewed in the artifact overlay. The extension
 * decides the renderer; unknown binaries fall back to a metadata panel.
 */
export type ArtifactKind =
  | 'image'
  | 'video'
  | 'html'
  | 'markdown'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'text'
  | 'code'
  | 'other';

const KIND_BY_EXTENSION: Readonly<Record<string, ArtifactKind>> = {
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  '.heic': 'image',
  '.mp4': 'video',
  '.m4v': 'video',
  '.webm': 'video',
  '.mov': 'video',
  '.ogv': 'video',
  '.mkv': 'video',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.pdf': 'pdf',
  '.doc': 'document',
  '.docx': 'document',
  '.odt': 'document',
  '.xls': 'spreadsheet',
  '.xlsx': 'spreadsheet',
  '.ods': 'spreadsheet',
  '.csv': 'spreadsheet',
  '.ppt': 'presentation',
  '.pptx': 'presentation',
  '.odp': 'presentation',
  '.txt': 'text',
  '.log': 'text',
  // 代码 / 数据配置档：FileViewer 交给 CodeViewer 按语言高亮（code-language.ts）。
  '.json': 'code',
  '.jsonc': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
  '.xml': 'code',
  '.ini': 'code',
  '.ts': 'code',
  '.mts': 'code',
  '.cts': 'code',
  '.tsx': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.sass': 'code',
  '.less': 'code',
  '.svelte': 'code',
  '.vue': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.kt': 'code',
  '.swift': 'code',
  '.php': 'code',
  '.lua': 'code',
  '.dart': 'code',
  '.cs': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cpp': 'code',
  '.hpp': 'code',
  '.cc': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.zsh': 'code',
  '.sql': 'code',
};

export function extensionOf(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * 音频产物（53 号修订 v2 V2-2）：MessageArtifact 无 mime 字段，按扩展名识别，
 * 在消息卡里渲染成 AudioPlayer 行（TTS 语音回复的 mp3/wav 等）。`.webm` 在
 * KIND_BY_EXTENSION 里是视频档——已判为 video 的扩展名不按音频处理，避免
 * 视频产物被塞进纯音频播放器。
 */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3',
  '.wav',
  '.opus',
  '.m4a',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.webm',
  '.weba',
]);

export function isAudioArtifact(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(extensionOf(filePath)) && artifactKindOf(filePath) !== 'video';
}

export function artifactKindOf(filePath: string): ArtifactKind {
  return KIND_BY_EXTENSION[extensionOf(filePath)] ?? 'other';
}

export function isTextualKind(kind: ArtifactKind): boolean {
  return kind === 'html' || kind === 'markdown' || kind === 'text' || kind === 'code';
}

export function artifactKindLabelKey(kind: ArtifactKind): MessageKey {
  return `files.kind.${kind}` as MessageKey;
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
