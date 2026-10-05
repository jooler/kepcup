/**
 * BERT WordPiece 分词器（DEV-007 本地向量模型 bge-small-zh-v1.5，词表
 * vocab.txt 21128 中文 BERT 词条）。与 HuggingFace BertTokenizer
 *（do_lower_case=true）对齐的基础分词 + WordPiece 贪心最长匹配：
 * - CJK 字符逐字切开（BERT 约定，覆盖中日韩统一表意文字各扩展区）；
 * - 标点两侧切开（ASCII 标点 + Unicode P 类）；
 * - 小写归一；超长词（>100 字符）与词表未命中最长前缀 → [UNK]。
 * 纯函数、无 I/O；vocab 加载由调用方（LocalEmbedder，模块级缓存）负责。
 */

export const CLS_TOKEN = '[CLS]';
export const SEP_TOKEN = '[SEP]';
export const UNK_TOKEN = '[UNK]';
/** BERT WordPiece 单词上限：超过直接整词 [UNK]（与 HF 一致）。 */
const MAX_CHARS_PER_WORD = 100;

const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b820, 0x2ceaf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];

function isCjk(codePoint: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/** BERT _is_punctuation：ASCII 标点段 + Unicode 标点类（\p{P}）。 */
function isPunctuation(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    (codePoint >= 33 && codePoint <= 47) ||
    (codePoint >= 58 && codePoint <= 64) ||
    (codePoint >= 91 && codePoint <= 96) ||
    (codePoint >= 123 && codePoint <= 126)
  ) {
    return true;
  }
  return /\p{P}/u.test(character);
}

/** 基础分词：CJK/标点两侧补空格 + 小写 + 按空白切。 */
export function basicTokens(text: string): string[] {
  let spaced = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (isCjk(codePoint) || isPunctuation(character)) spaced += ` ${character} `;
    else spaced += character;
  }
  return spaced
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** WordPiece 贪心最长匹配；不可整词覆盖时整词 [UNK]（与 HF 一致）。 */
export function wordPieces(token: string, vocab: ReadonlyMap<string, number>): string[] {
  if (token.length > MAX_CHARS_PER_WORD) return [UNK_TOKEN];
  const pieces: string[] = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let matched: string | null = null;
    while (start < end) {
      const candidate = (start === 0 ? '' : '##') + token.slice(start, end);
      if (vocab.has(candidate)) {
        matched = candidate;
        break;
      }
      end -= 1;
    }
    if (matched === null) return [UNK_TOKEN];
    pieces.push(matched);
    start = end;
  }
  return pieces;
}

export type BertVocab = ReadonlyMap<string, number>;

/** 解析 vocab.txt（一行一词，行号即 id；重复词保留首个）。 */
export function loadBertVocab(vocabText: string): BertVocab {
  const vocab = new Map<string, number>();
  vocabText.split('\n').forEach((line, index) => {
    const token = line.replace(/\r$/, '');
    if (token.length > 0 && !vocab.has(token)) vocab.set(token, index);
  });
  return vocab;
}

/**
 * 编码为 input id 序列：[CLS] … [SEP]，超出 maxLen（含特殊符号）按词截断。
 * 空文本返回仅含特殊符号的序列（ Bert 允许）。
 */
export function encodeBert(text: string, vocab: BertVocab, maxLen: number): number[] {
  const cls = vocab.get(CLS_TOKEN);
  const sep = vocab.get(SEP_TOKEN);
  if (cls === undefined || sep === undefined) {
    throw new Error('词表缺少 [CLS]/[SEP]（vocab.txt 与 BERT 词表不符）');
  }
  const ids: number[] = [cls];
  for (const token of basicTokens(text)) {
    if (ids.length + 1 >= maxLen) break;
    for (const piece of wordPieces(token, vocab)) {
      const id = vocab.get(piece);
      if (id === undefined) continue; // [UNK] 一定在词表；防御性跳过
      ids.push(id);
      if (ids.length + 1 >= maxLen) break;
    }
  }
  ids.push(sep);
  return ids.slice(0, maxLen);
}
