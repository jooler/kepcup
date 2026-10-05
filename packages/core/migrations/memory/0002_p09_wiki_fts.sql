-- P09 每个 Bot 的 Wiki 全文索引（docs/dev/03-data-model.md "wiki_fts"，原文迁移）。
-- 写入一律经 infra/text-segment.ts 分词；每次 Wiki 维护提交后按变更页面增量更新。
CREATE VIRTUAL TABLE wiki_fts USING fts5(
  segmented_text, page_path UNINDEXED, title UNINDEXED, tokenize = 'unicode61'
);
