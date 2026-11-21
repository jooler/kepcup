-- Memory source principal (62.11 C12, docs/design/62-team-server/
-- 11-core-seams.md): items can record the principal whose run produced them,
-- so retrieval can scope an audience (62.05 §3) and dedup stays within one
-- principal. Nullable: NULL = single-user status quo (existing rows and the
-- shared bucket).
ALTER TABLE memory_items ADD COLUMN source_principal_id TEXT;
