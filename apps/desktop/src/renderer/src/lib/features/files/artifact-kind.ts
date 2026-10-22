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
  '.json': 'text',
  '.log': 'text',
  '.yaml': 'text',
  '.yml': 'text',
  '.toml': 'text',
  '.xml': 'text',
  '.ts': 'text',
  '.tsx': 'text',
  '.js': 'text',
  '.jsx': 'text',
  '.mjs': 'text',
  '.cjs': 'text',
  '.css': 'text',
  '.scss': 'text',
  '.svelte': 'text',
  '.py': 'text',
  '.rb': 'text',
  '.go': 'text',
  '.rs': 'text',
  '.java': 'text',
  '.c': 'text',
  '.h': 'text',
  '.cpp': 'text',
  '.sh': 'text',
  '.sql': 'text',
};

export function extensionOf(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function artifactKindOf(filePath: string): ArtifactKind {
  return KIND_BY_EXTENSION[extensionOf(filePath)] ?? 'other';
}

export function isTextualKind(kind: ArtifactKind): boolean {
  return kind === 'html' || kind === 'markdown' || kind === 'text';
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
