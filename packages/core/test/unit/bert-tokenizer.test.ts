import { describe, expect, it } from 'vitest';

import { basicTokens, encodeBert, loadBertVocab, wordPieces } from '../../src/memory/bert-tokenizer.js';

/** 缩微词表：覆盖 CJK 单字、英文词、##续片、[UNK]/[CLS]/[SEP]/[PAD]。 */
const VOCAB_TEXT = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  '今',
  '天',
  '天',
  '气',
  '好',
  'weather',
  'nice',
  'is',
  'the',
  '##今天',
  '!',
  '。',
].join('\n');

const vocab = loadBertVocab(VOCAB_TEXT);

describe('bert tokenizer (P07 本地向量模型)', () => {
  it('parses vocab.txt line numbers as ids', () => {
    expect(vocab.get('[PAD]')).toBe(0);
    expect(vocab.get('[UNK]')).toBe(1);
    expect(vocab.get('气')).toBe(7);
  });

  it('splits CJK characters and punctuation, lowercases latin', () => {
    expect(basicTokens('今天天气好！')).toEqual(['今', '天', '天', '气', '好', '！']);
    expect(basicTokens('The Weather is Nice')).toEqual(['the', 'weather', 'is', 'nice']);
    expect(basicTokens('weather,nice')).toEqual(['weather', ',', 'nice']);
  });

  it('matches wordpieces greedily and falls back to [UNK]', () => {
    expect(wordPieces('weather', vocab)).toEqual(['weather']);
    // '##天' 不在词表且无法整词覆盖 → 整词回退 [UNK]（不输出半个词）。
    expect(wordPieces('今天', vocab)).toEqual(['[UNK]']);
    expect(wordPieces('weatherx', vocab)).toEqual(['[UNK]']);
    expect(wordPieces('x'.repeat(101), vocab)).toEqual(['[UNK]']);
  });

  it('encodes with [CLS]/[SEP] and truncates to maxLen', () => {
    const ids = encodeBert('今天天气好', vocab, 512);
    expect(ids[0]).toBe(vocab.get('[CLS]'));
    expect(ids[ids.length - 1]).toBe(vocab.get('[SEP]'));
    expect(ids).toContain(vocab.get('今'));
    // maxLen=5：[CLS] + 前 3 个词片 + [SEP]。
    const short = encodeBert('今天天气好', vocab, 5);
    expect(short.length).toBe(5);
    expect(short[0]).toBe(vocab.get('[CLS]'));
    expect(short[short.length - 1]).toBe(vocab.get('[SEP]'));
  });

  it('encodes empty text to just the special tokens', () => {
    const ids = encodeBert('   ', vocab, 512);
    expect(ids).toEqual([vocab.get('[CLS]'), vocab.get('[SEP]')]);
  });
});
