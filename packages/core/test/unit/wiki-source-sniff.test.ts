import { describe, expect, it } from 'vitest';
import { sniffSourceKind } from '../../src/wiki/source.js';
import { inlineTextFor } from '../../src/wiki/maintenance.js';

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const withTail = (head: Buffer): Buffer => Buffer.concat([head, Buffer.alloc(32, 1)]);

describe('sniffSourceKind', () => {
  it('magic numbers classify binary formats regardless of name or declared mime', () => {
    expect(sniffSourceKind(Buffer.from('%PDF-1.7\n'), 'a.txt', 'text/plain')).toEqual({
      mime: 'application/pdf',
      kind: 'document',
    });
    expect(sniffSourceKind(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), 'x', null).kind).toBe('image');
    expect(sniffSourceKind(withTail(bytes(0xff, 0xd8, 0xff, 0xe0)), 'x.md', 'text/markdown').mime).toBe('image/jpeg');
    expect(sniffSourceKind(Buffer.from('GIF89a......'), 'x', null).mime).toBe('image/gif');
    expect(sniffSourceKind(Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WEBPVP8 ')]), 'x', null).mime).toBe('image/webp');
    expect(sniffSourceKind(Buffer.concat([Buffer.from('RIFF'), bytes(0, 0, 0, 0), Buffer.from('WAVEfmt ')]), 'x', null)).toEqual({
      mime: 'audio/wav',
      kind: 'audio',
    });
    expect(sniffSourceKind(Buffer.concat([bytes(0, 0, 0, 0x18), Buffer.from('ftypisom')]), 'x', null)).toEqual({
      mime: 'video/mp4',
      kind: 'video',
    });
    expect(sniffSourceKind(Buffer.concat([bytes(0, 0, 0, 0x14), Buffer.from('ftypqt  ')]), 'x', null).mime).toBe('video/quicktime');
    expect(sniffSourceKind(withTail(bytes(0x1a, 0x45, 0xdf, 0xa3)), 'clip.webm', null).mime).toBe('video/webm');
    expect(sniffSourceKind(Buffer.from('ID3\x04\x00\x00'), 'x', null)).toEqual({ mime: 'audio/mpeg', kind: 'audio' });
    expect(sniffSourceKind(Buffer.from('OggS\x00\x02'), 'x', null).mime).toBe('audio/ogg');
    expect(sniffSourceKind(Buffer.from('fLaC\x00\x00'), 'x', null).mime).toBe('audio/flac');
  });

  it('ZIP containers split by extension; OLE by extension', () => {
    const zip = withTail(bytes(0x50, 0x4b, 0x03, 0x04));
    expect(sniffSourceKind(zip, 'r.docx', null).kind).toBe('document');
    expect(sniffSourceKind(zip, 'r.xlsx', null).mime).toContain('spreadsheetml');
    expect(sniffSourceKind(zip, 'r.pptx', null).mime).toContain('presentationml');
    expect(sniffSourceKind(zip, 'r.epub', null).mime).toBe('application/epub+zip');
    expect(sniffSourceKind(zip, 'r.zip', null)).toEqual({ mime: 'application/zip', kind: 'binary' });
    const ole = withTail(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
    expect(sniffSourceKind(ole, 'old.doc', null)).toEqual({ mime: 'application/msword', kind: 'document' });
    expect(sniffSourceKind(ole, 'old.bin', null).kind).toBe('binary');
  });

  it('text without a magic number: extension refines, extensionless stays text/plain', () => {
    expect(sniffSourceKind(Buffer.from('# 标题\n正文'), 'note.md', null)).toEqual({
      mime: 'text/markdown',
      kind: 'text',
    });
    expect(sniffSourceKind(Buffer.from('{"a":1}'), 'd.json', null).mime).toBe('application/json');
    expect(sniffSourceKind(Buffer.from('a,b\n1,2'), 'd.csv', null).mime).toBe('text/csv');
    expect(sniffSourceKind(Buffer.from('<html><body>x</body></html>'), 'p.html', null).kind).toBe('html');
    expect(sniffSourceKind(Buffer.from('plain words'), 'README', null)).toEqual({
      mime: 'text/plain',
      kind: 'text',
    });
    expect(sniffSourceKind(Buffer.alloc(0), 'empty.txt', null).kind).toBe('text');
  });

  it('declared text mime is kept for text bytes; declared text but binary bytes is binary', () => {
    expect(sniffSourceKind(Buffer.from('x: 1'), 'cfg', 'application/x-yaml').mime).toBe('application/x-yaml');
    expect(sniffSourceKind(bytes(0x01, 0x00, 0x02, 0x00, 0x03), 'blob.txt', 'text/plain')).toEqual({
      mime: 'application/octet-stream',
      kind: 'binary',
    });
  });

  it('invalid UTF-8 is binary; a window cut inside a multibyte character is still text', () => {
    expect(sniffSourceKind(bytes(0xc3, 0x28, 0x41, 0x42), 'bad.txt', null).kind).toBe('binary');
    const long = Buffer.from('中'.repeat(4000), 'utf8'); // 12000 bytes, 8192 cuts mid-character
    expect(long.length).toBeGreaterThan(8192);
    expect(sniffSourceKind(long, 'zh.txt', null).kind).toBe('text');
  });
});

describe('inlineTextFor', () => {
  it('inlines text/html, never binary kinds, never NUL-bearing bytes', () => {
    expect(inlineTextFor('text', Buffer.from('hi'), null)).toBe('hi');
    expect(inlineTextFor('html', Buffer.from('<p>hi</p>'), null)).toBe('<p>hi</p>');
    expect(inlineTextFor('document', Buffer.from('%PDF-1.7'), null)).toBeNull();
    expect(inlineTextFor('binary', Buffer.from('abc'), null)).toBeNull();
    expect(inlineTextFor('text', Buffer.from('a\0b'), null)).toBeNull();
    expect(inlineTextFor('binary', Buffer.from('x'), '# converted')).toBe('# converted');
  });
});
