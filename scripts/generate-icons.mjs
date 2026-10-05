#!/usr/bin/env node
// Generates the placeholder app / tray icons committed under
// apps/desktop/resources. P13 replaces them with final artwork.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../apps/desktop/resources');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Ring with a gap at the top plus a center dot: minimal "bot" mark. */
function drawGlyph(size, rgb, background) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const outer = size * 0.42;
  const inner = size * 0.26;
  const dot = size * 0.1;
  const gapHalf = Math.PI / 7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const r = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const inGap =
        Math.abs(angle + Math.PI / 2) < gapHalf || Math.abs(angle - (3 * Math.PI) / 2) < gapHalf;
      const idx = (y * size + x) * 4;
      let on = false;
      if (r <= outer && r >= inner && !inGap) on = true;
      if (r <= dot) on = true;
      if (background) {
        rgba[idx] = on ? rgb[0] : background[0];
        rgba[idx + 1] = on ? rgb[1] : background[1];
        rgba[idx + 2] = on ? rgb[2] : background[2];
        rgba[idx + 3] = on ? 255 : 255;
      } else {
        rgba[idx] = rgb[0];
        rgba[idx + 1] = rgb[1];
        rgba[idx + 2] = rgb[2];
        rgba[idx + 3] = on ? 255 : 0;
      }
    }
  }
  return rgba;
}

mkdirSync(outDir, { recursive: true });
const black = [20, 20, 20];
const accent = [59, 130, 246];
writeFileSync(path.join(outDir, 'trayTemplate.png'), encodePng(16, 16, drawGlyph(16, black)));
writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), encodePng(32, 32, drawGlyph(32, black)));
writeFileSync(
  path.join(outDir, 'icon.png'),
  encodePng(256, 256, drawGlyph(256, [255, 255, 255], accent)),
);
console.log('icons written to', outDir);
