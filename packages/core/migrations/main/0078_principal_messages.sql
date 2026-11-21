-- Message sender principal (62.11 C4): user messages can carry the calling
-- principal (snapshot name kept alongside, still resolvable after the principal
-- is renamed or removed). Both nullable: NULL = single-user status quo.
--
-- updated_at is the content-change time used by messages.list changedSince
-- incremental catch-up (C6). It is maintained by this trigger instead of the
-- infra/clock convention (DEV-134): message bodies are rewritten in place at a
-- dozen call sites (settings/host, schedule, dispatch, streaming text, edit,
-- recall), and only a trigger guarantees none of them is missed. It fires on
-- UPDATEs whose SET list mentions content_json, status or edited_at — the
-- columns a catch-up client cares about — even when the value is unchanged,
-- and leaves rows whose inserted updated_at is NULL to fall back to created_at
-- on comparison (coalesce in the reader). The trigger is created after the
-- columns because its body writes updated_at.
ALTER TABLE messages ADD COLUMN sender_principal_id TEXT;
ALTER TABLE messages ADD COLUMN sender_name TEXT;
ALTER TABLE messages ADD COLUMN updated_at INTEGER;

CREATE TRIGGER messages_touch_updated_at
  AFTER UPDATE OF content_json, status, edited_at ON messages
BEGIN
  UPDATE messages
     SET updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
   WHERE id = OLD.id;
END;
