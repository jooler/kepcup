import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';

/**
 * 连通性测试探针素材。图片 / 语音 / 向量直接用最小真实请求（成本忽略
 * 不计）；语音识别需要真实音频输入，这里程序化构造一段极短的静音 WAV
 * （16kHz 单声道 16bit PCM）；图片理解构造一张 32×32 纯色 PNG——部分
 * 视觉模型限制图片边长必须大于 10px（百炼 qwen3-vl/omni 实测），厂商
 * 返回 200 即证明 key、端点与模型可用，描述内容本身无意义。
 */

export const PROBE_AUDIO_MIME = 'audio/wav';

export function buildSilentWavBase64(seconds = 0.3, sampleRate = 16_000): string {
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  // 样本区保持 0（静音）。
  return buffer.toString('base64');
}

// --- 1×1 纯色 PNG（图片理解探测） -------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(chunkType: string, data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < chunkType.length; i++) {
    crc = CRC_TABLE[(crc ^ chunkType.charCodeAt(i)) & 0xff]! ^ (crc >>> 8);
  }
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(type, data), 0);
  return Buffer.concat([head, Buffer.from(type, 'ascii'), data, crc]);
}

/** 32×32 纯色 PNG（真彩色 RGB；视觉模型普遍要求边长 > 10px），data URI 形态。 */
export function buildSolidPngDataUri(r = 255, g = 0, b = 0, size = 32): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor
  // 压缩 / 滤波 / 隔行扫描均为 0，保持默认。
  const stride = size * 3 + 1;
  const scanline = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    scanline.fill(0, y * stride, y * stride + 1); // filter 0
    for (let x = 0; x < size; x++) {
      const offset = y * stride + 1 + x * 3;
      scanline[offset] = r;
      scanline[offset + 1] = g;
      scanline[offset + 2] = b;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanline)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}
