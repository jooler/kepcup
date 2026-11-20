-- Personal-domain ownership (62.11 C13, docs/design/62-team-server/
-- 11-core-seams.md): todos / memos / memo_groups / schedules / watches gain a
-- nullable owner_principal_id. NULL = the single-user status quo; team hosts
-- stamp the calling principal on create and filter / check it on read and
-- write. stickies gains the same column, but its semantics only apply to
-- scope='global' rows (conversation-scoped stickies follow their conversation's
-- visibility, so they are neither filtered nor checked) — hence the partial
-- index. conversation_notes stays untouched (it follows its conversation; no
-- ownership column this phase).
--
-- Plain ADD COLUMN: every table keeps its shape, CHECKs and indexes; the new
-- column is nullable with no default, so existing rows read NULL. Indexes are
-- simple owner lookups — the list filters ask "rows owned by P" and then reuse
-- the existing status / order indexes for sorting.
ALTER TABLE todos ADD COLUMN owner_principal_id TEXT;
ALTER TABLE memos ADD COLUMN owner_principal_id TEXT;
ALTER TABLE memo_groups ADD COLUMN owner_principal_id TEXT;
ALTER TABLE schedules ADD COLUMN owner_principal_id TEXT;
ALTER TABLE watches ADD COLUMN owner_principal_id TEXT;
ALTER TABLE stickies ADD COLUMN owner_principal_id TEXT;

CREATE INDEX todos_owner ON todos(owner_principal_id);
CREATE INDEX memos_owner ON memos(owner_principal_id);
CREATE INDEX memo_groups_owner ON memo_groups(owner_principal_id);
CREATE INDEX schedules_owner ON schedules(owner_principal_id);
CREATE INDEX watches_owner ON watches(owner_principal_id);
CREATE INDEX stickies_global_owner ON stickies(owner_principal_id) WHERE scope = 'global';
