import { describe, expect, it } from 'vitest';

import { decodeWslOutput, looksLikeUtf16Le } from '../../src/sandbox/wsl/decode.js';

/**
 * Fixtures are hand-built to the documented wsl.exe output shapes (P12 任务
 * 书：`wsl --status` / `wsl --list --verbose` 输出为 UTF-16，注意编码）。
 * All WSL behavior is blind-written on macOS — these byte-level fixtures are
 * the executable specification (todo/cross-platform-acceptance.md P12:
 * 真机复核输出编码形态).
 */

function utf16LeWithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

describe('decodeWslOutput', () => {
  it('decodes UTF-16LE output with the BOM wsl.exe emits', () => {
    const bytes = utf16LeWithBom('Default Version: 2\r\n');
    expect(decodeWslOutput(bytes)).toBe('Default Version: 2\r\n');
  });

  it('decodes BOM-less UTF-16LE (older builds omit the BOM)', () => {
    expect(looksLikeUtf16Le(Buffer.from('NAME  STATE', 'utf16le'))).toBe(true);
    expect(decodeWslOutput(Buffer.from('  Ubuntu          Running         2\r\n', 'utf16le'))).toBe(
      '  Ubuntu          Running         2\r\n',
    );
  });

  it('decodes UTF-8 output untouched (distro-side commands are plain UTF-8)', () => {
    const text = 'mount: 挂载成功 /mnt/kepcup/0123abcdef456789';
    expect(decodeWslOutput(Buffer.from(text, 'utf8'))).toBe(text);
  });

  it('strips a UTF-8 BOM', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok', 'utf8')]);
    expect(decodeWslOutput(bytes)).toBe('ok');
  });

  it('keeps plain ASCII readable', () => {
    expect(decodeWslOutput(Buffer.from('plain\r\n', 'utf8'))).toBe('plain\r\n');
  });
});
