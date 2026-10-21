-- 备忘列表的排序键独立于「最后更新时间」：改正文不再把卡片顶到最前。
--   sort_at = 排序键（创建时取创建时间；只有置顶状态变化才刷新，置顶卡提到置顶组最前）。
--   updated_at 仍是真正的最后修改时间（卡片上的相对时间、管家上下文里的「最近备忘」用它）。
--   旧行回填 created_at：既有备忘改按记录时间排，此前被改过的会退回它原本的位置（不再占最前）。
ALTER TABLE memos ADD COLUMN sort_at INTEGER NOT NULL DEFAULT 0;
UPDATE memos SET sort_at = created_at;
DROP INDEX memos_live;
CREATE INDEX memos_live ON memos(deleted_at, pinned DESC, sort_at DESC);
