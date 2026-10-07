/**
 * RoBERTa 风格字符级 BPE 分词器（DEV-007 本地向量模型
 * jina-embeddings-v2-base-zh：vocab.json 60516 词 + merges.txt 39382 合并）。
 * 与 HuggingFace RobertaTokenizer / tokenizer.json 对齐：
 * - 归一：NFC + 小写（tokenizer.json normalizer 序列）；
 * - 预切分：tokenizers `Whitespace`（\w+ | [^\w\s]+，空白丢弃、标点成块）；
 * - BPE：初始符号为单字符，按 merges rank 从小到大贪心合并相邻对；
 * - 未收录符号 → <unk>（无 byte fallback）；序列 <s> … </s>，超长截断时
 *   特殊符号占 maxLen（HF truncation 语义）。
 * 纯函数、无 I/O；词表加载由调用方（LocalEmbedder，模块级缓存）负责。
 * 实现已与 HF tokenizers 在中英混句上逐 id 比对一致（2026-10-07）。
 */

export const BOS_TOKEN = '<s>';
export const EOS_TOKEN = '</s>';
export const UNK_TOKEN = '<unk>';

/** merges.txt 行内以单个空格分隔符号对；符号本身不含空白。 */
const MERGE_SEPARATOR = ' ';

/**
 * tokenizers `Whitespace` 预切分（Rust \w ≈ 字母/Marks/数字/连接符/Join_Control）。
 * JS 侧以 Unicode property escape 近似；空白整体丢弃。
 */
const PRE_TOKEN_RE = /[\p{L}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]+|[^\p{L}\p{M}\p{Nd}\p{Pc}\p{Join_Control}\s]+/gu;

export interface BpeVocab {
  /** 符号 → id。 */
  vocab: ReadonlyMap<string, number>;
  /** 合并对（左右符号以 \u0000 连接）→ rank；rank 越小越先合并。 */
  ranks: ReadonlyMap<string, number>;
}

/** 解析 vocab.json（符号 → id）与 merges.txt（首行 #version 头跳过）。 */
export function loadBpeVocab(vocabJsonText: string, mergesText: string): BpeVocab {
  const vocab = new Map(Object.entries(JSON.parse(vocabJsonText) as Record<string, number>));
  const ranks = new Map<string, number>();
  mergesText.split('\n').forEach((line, index) => {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.length === 0 || trimmed.startsWith('#')) return;
    const sep = trimmed.indexOf(MERGE_SEPARATOR);
    // 词表损坏（无分隔符的行）让加载直接失败，好过静默错分。
    if (sep <= 0 || sep === trimmed.length - 1) {
      throw new Error(`merges.txt 第 ${index + 1} 行不是「符号 符号」对：${trimmed}`);
    }
    ranks.set(
      trimmed.slice(0, sep) + '\u0000' + trimmed.slice(sep + MERGE_SEPARATOR.length),
      ranks.size,
    );
  });
  return { vocab, ranks };
}

/** 对单个预切分块做 BPE：单字符起步，反复合并 rank 最小的相邻对。 */
export function bpeMerges(chunk: string, ranks: ReadonlyMap<string, number>): string[] {
  const parts = [...chunk];
  while (parts.length > 1) {
    let bestRank = Infinity;
    let bestIdx = -1;
    for (let i = 0; i + 1 < parts.length; i++) {
      const rank = ranks.get(parts[i]! + '\u0000' + parts[i + 1]!);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    parts.splice(bestIdx, 2, parts[bestIdx]! + parts[bestIdx + 1]!);
  }
  return parts;
}

/**
 * 编码为 input id 序列：<s> … </s>；正文超出 maxLen-2 截断（特殊符号占
 * maxLen）。空文本返回仅含特殊符号的序列。
 */
export function encodeBpe(text: string, bundle: BpeVocab, maxLen: number): number[] {
  const { vocab, ranks } = bundle;
  const bos = vocab.get(BOS_TOKEN);
  const eos = vocab.get(EOS_TOKEN);
  const unk = vocab.get(UNK_TOKEN);
  if (bos === undefined || eos === undefined || unk === undefined) {
    throw new Error('词表缺少 <s>/</s>/<unk>（vocab.json 与 RoBERTa 词表不符）');
  }
  const ids: number[] = [];
  for (const chunk of text.normalize('NFC').toLowerCase().match(PRE_TOKEN_RE) ?? []) {
    for (const piece of bpeMerges(chunk, ranks)) {
      ids.push(vocab.get(piece) ?? unk);
    }
  }
  return [bos, ...ids.slice(0, Math.max(0, maxLen - 2)), eos];
}
