import { describe, expect, it } from 'vitest';

import { bpeMerges, encodeBpe, loadBpeVocab } from '../../src/memory/bpe-tokenizer.js';

/**
 * 缩微词表（结构同真实 vocab.json/merges.txt）：特殊符号 0-4、CJK 单字、
 * 一个「今 天」合并对与合并结果「今天」。
 */
const VOCAB_JSON = JSON.stringify({
  '<s>': 0,
  '<pad>': 1,
  '</s>': 2,
  '<unk>': 3,
  '<mask>': 4,
  今: 5,
  天: 6,
  好: 7,
  weather: 8,
  is: 9,
  nice: 10,
  今天: 11,
  a: 12,
});
const MERGES_TEXT = ['#version: 0.2', '今 天'].join('\n');

const bundle = loadBpeVocab(VOCAB_JSON, MERGES_TEXT);

describe('bpe tokenizer（P07 本地向量模型 jina-embeddings-v2-base-zh）', () => {
  it('parses vocab.json and merges.txt (version header skipped, rank by order)', () => {
    expect(bundle.vocab.get('今天')).toBe(11);
    expect(bundle.ranks.get('今\u0000天')).toBe(0);
    const crlf = loadBpeVocab(VOCAB_JSON, '#version: 0.2\r\na b\r\n');
    expect(crlf.ranks.get('a\u0000b')).toBe(0);
  });

  it('rejects malformed merges lines instead of silently mis-tokenizing', () => {
    expect(() => loadBpeVocab(VOCAB_JSON, 'novspace\n')).toThrow('merges.txt');
  });

  it('merges CJK pairs by rank, keeps unmergeable chars as symbols → <unk>', () => {
    expect(bpeMerges('今天好', bundle.ranks)).toEqual(['今天', '好']);
    // 无合并对的块保持单字符序列；词表未收录的符号逐个映射 <unk>。
    expect(encodeBpe('xyz', bundle, 512)).toEqual([0, 3, 3, 3, 2]);
  });

  it('lowercases, splits punctuation into its own chunks (NFC + Whitespace 预切分)', () => {
    // 大写归一；标点独立成块且不在词表 → <unk>。
    expect(encodeBpe('A', bundle, 512)).toEqual([0, 12, 2]);
    expect(encodeBpe('今天, 好!', bundle, 512)).toEqual([0, 11, 3, 7, 3, 2]);
    // 空白整体丢弃（tokenizers Whitespace 语义），不产生空符号。
    expect(encodeBpe('  今天   好  ', bundle, 512)).toEqual([0, 11, 7, 2]);
  });

  it('encodes with <s>/</s> and truncates body to maxLen-2 (specials 占位)', () => {
    expect(encodeBpe('今天好', bundle, 512)).toEqual([0, 11, 7, 2]);
    // maxLen=3：<s> + 正文前 1 个符号 + </s>。
    const short = encodeBpe('今天好', bundle, 3);
    expect(short).toEqual([0, 11, 2]);
  });

  it('encodes empty text to just the special tokens', () => {
    expect(encodeBpe('   ', bundle, 512)).toEqual([0, 2]);
  });
});
