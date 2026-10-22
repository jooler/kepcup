import { describe, expect, it } from 'vitest';
import { artifactKindOf, extensionOf, formatFileSize, isTextualKind } from './artifact-kind';

describe('artifact kinds', () => {
  it('maps extensions to the preview renderer', () => {
    expect(artifactKindOf('/a/b/screen.PNG')).toBe('image');
    expect(artifactKindOf('/a/b/demo.mp4')).toBe('video');
    expect(artifactKindOf('/a/b/page.html')).toBe('html');
    expect(artifactKindOf('/a/b/NOTES.md')).toBe('markdown');
    expect(artifactKindOf('/a/b/report.pdf')).toBe('pdf');
    expect(artifactKindOf('/a/b/report.docx')).toBe('document');
    expect(artifactKindOf('/a/b/sheet.xlsx')).toBe('spreadsheet');
    expect(artifactKindOf('/a/b/deck.pptx')).toBe('presentation');
    expect(artifactKindOf('/a/b/main.ts')).toBe('text');
    expect(artifactKindOf('/a/b/archive.zip')).toBe('other');
  });

  it('extracts the extension case-insensitively', () => {
    expect(extensionOf('/a/b.HTML')).toBe('.html');
    expect(extensionOf('no-extension')).toBe('');
  });

  it('marks only document-like text as textual', () => {
    expect(isTextualKind('html')).toBe(true);
    expect(isTextualKind('markdown')).toBe(true);
    expect(isTextualKind('text')).toBe(true);
    expect(isTextualKind('image')).toBe(false);
  });

  it('formats sizes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2 MB');
    expect(formatFileSize(undefined)).toBe('');
  });
});
