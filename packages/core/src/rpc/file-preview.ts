import path from 'node:path';

/**
 * File preview RPC helpers (Bot file cards). The renderer may read only the
 * files the conversation actually surfaced as artifacts (`messages.hasArtifactPath`);
 * the data directory and historical workdirs are not a general read scope.
 */

/** Base64 IPC is expensive; limits differ by renderer (video/pdf are the heavy ones). */
const PREVIEW_LIMITS: Readonly<
  Record<'video' | 'pdf' | 'office' | 'image' | 'text' | 'other', number>
> = {
  video: 48 * 1024 * 1024,
  pdf: 32 * 1024 * 1024,
  office: 12 * 1024 * 1024,
  image: 24 * 1024 * 1024,
  text: 8 * 1024 * 1024,
  other: 16 * 1024 * 1024,
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

export function previewMimeOf(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** Maximum bytes the renderer may pull for this file kind. */
export function previewMaxBytesOf(filePath: string): number {
  const extension = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXTENSION[extension] ?? '';
  if (mime.startsWith('video/')) return PREVIEW_LIMITS.video;
  if (mime === 'application/pdf') return PREVIEW_LIMITS.pdf;
  if (
    mime === 'application/msword' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.ms-powerpoint' ||
    mime.startsWith('application/vnd.openxmlformats-officedocument') ||
    mime.startsWith('application/vnd.oasis.opendocument')
  ) {
    return PREVIEW_LIMITS.office;
  }
  if (mime.startsWith('image/')) return PREVIEW_LIMITS.image;
  if (mime.startsWith('text/') || mime === 'application/json') return PREVIEW_LIMITS.text;
  return PREVIEW_LIMITS.other;
}
