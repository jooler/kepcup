export type Utf8ByteLengthMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

// KepCup 垫片（orca src/shared/utf8-byte-limits.ts 原样复制，只保留 clipboard-text
// 垫片用到的度量部分）。Pair charCodeAt units explicitly: optimized codePointAt can
// read beyond a sliced string's trailing high surrogate, overcounting UTF-8 by one byte.
export function readUtf8CodePointAt(text: string, index: number): number {
  const leadUnit = text.charCodeAt(index)
  if (leadUnit < 0xd800 || leadUnit > 0xdbff || index + 1 >= text.length) {
    return leadUnit
  }
  const trailUnit = text.charCodeAt(index + 1)
  if (trailUnit < 0xdc00 || trailUnit > 0xdfff) {
    return leadUnit
  }
  return (leadUnit - 0xd800) * 0x400 + (trailUnit - 0xdc00) + 0x10000
}

export function measureUtf8ByteLength(
  text: string,
  options: { stopAfterBytes?: number } = {}
): Utf8ByteLengthMeasurement {
  const stopAfterBytes = options.stopAfterBytes
  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = readUtf8CodePointAt(text, index)
    byteLength += getUtf8ByteLengthForCodePoint(codePoint)
    if (Number.isFinite(stopAfterBytes) && byteLength > (stopAfterBytes ?? 0)) {
      return { byteLength, exceededLimit: true }
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return { byteLength, exceededLimit: false }
}

export function getUtf8ByteLength(text: string): number {
  return measureUtf8ByteLength(text).byteLength
}

export function getUtf8ByteLengthForCodePoint(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}
