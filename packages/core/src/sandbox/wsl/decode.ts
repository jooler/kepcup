/**
 * wsl.exe prints its own status/list output as UTF-16LE (with a BOM) even
 * when the console code page is UTF-8 — a long-standing quirk documented in
 * WSL issue trackers and worked around by every WSL tooling. Command output
 * of commands run INSIDE the distro (`wsl -d … -- cmd`) is plain UTF-8; only
 * wsl.exe's own metadata output is UTF-16.
 *
 * This module is the single decoding point. Pure functions — fixture unit
 * tests feed real-shaped byte samples (docs 任务书: 输出为 UTF-16，注意编码).
 */

/**
 * Decodes wsl.exe output. Detection order:
 *  1. UTF-8 BOM → utf8;
 *  2. UTF-16LE BOM (0xFF 0xFE) → utf16le;
 *  3. UTF-16BE BOM (0xFE 0xFF) → utf16be;
 *  4. Heuristic: every second byte 0x00 with NUL only at odd offsets →
 *     UTF-16LE without BOM (older wsl.exe builds omit it);
 *  5. Otherwise UTF-8.
 */
export function decodeWslOutput(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return stripBom(bytes.subarray(3).toString('utf8'));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return stripBom(bytes.subarray(2).toString('utf16le'));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return stripBom(bytes.swap16().subarray(2).toString('utf16le'));
  }
  if (looksLikeUtf16Le(bytes)) {
    return stripBom(bytes.toString('utf16le'));
  }
  return stripBom(bytes.toString('utf8'));
}

/** True when the sample plausibly is BOM-less UTF-16LE (odd NUL density). */
export function looksLikeUtf16Le(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  // Odd-index NULs are the ASCII range of UTF-16LE; even-index NULs basically
  // never occur in wsl.exe output.
  let oddNull = 0;
  let evenNull = 0;
  const samples = Math.min(bytes.length, 256);
  for (let i = 1; i < samples; i += 2) {
    if (bytes[i] === 0) oddNull += 1;
  }
  for (let i = 0; i < samples; i += 2) {
    if (bytes[i] === 0) evenNull += 1;
  }
  const oddSlots = Math.floor(samples / 2);
  const evenSlots = Math.ceil(samples / 2);
  return oddSlots > 0 && oddNull / oddSlots > 0.6 && evenNull / evenSlots < 0.2;
}

function stripBom(text: string): string {
  // toString() after slicing already removed the byte BOM; strip a stray
  // U+FEFF that some code paths decode into the first character.
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
}
