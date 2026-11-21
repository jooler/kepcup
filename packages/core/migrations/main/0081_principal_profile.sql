-- Profile per-principal bucketing (62.11 C11, docs/design/62-team-server/
-- 11-core-seams.md): profile entries, proposals and the compiled card gain a
-- principal_key (NOT NULL, '' = the single-user bucket, matching
-- composer_drafts.principal_key from 0079).
--
-- profile_items / profile_proposals take a plain ADD COLUMN: the default fills
-- every existing row with the single-user key, and the profile_proposals_pending
-- index (status, created_at) survives an ADD COLUMN untouched. profile_fts is
-- keyed by item_id (no principal column of its own), so it keeps working
-- unchanged.
--
-- profile_card is rebuilt: the old single-row table (CHECK (id = 1)) becomes
-- one row per principal keyed by principal_key, and the old row migrates onto
-- the single-user '' key. Nothing references profile_card, so the rebuild
-- needs no foreign-keys pragma.
ALTER TABLE profile_items ADD COLUMN principal_key TEXT NOT NULL DEFAULT '';
ALTER TABLE profile_proposals ADD COLUMN principal_key TEXT NOT NULL DEFAULT '';

CREATE TABLE profile_card_new (
  principal_key TEXT PRIMARY KEY,
  content       TEXT NOT NULL,
  compiled_at   INTEGER NOT NULL
);

INSERT INTO profile_card_new (principal_key, content, compiled_at)
  SELECT '', content, compiled_at FROM profile_card;

DROP TABLE profile_card;
ALTER TABLE profile_card_new RENAME TO profile_card;
