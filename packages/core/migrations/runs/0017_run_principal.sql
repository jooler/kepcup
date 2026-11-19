-- Run attribution (62.11 C7): runs carry the principal that triggered them
-- (dialogue turn = speaker, task = inherited from the initiating turn,
-- scheduled / watched = owning principal, background jobs = NULL). Nullable:
-- NULL = single-user status quo. The index mirrors runs_by_conv / runs_by_bot.
ALTER TABLE runs ADD COLUMN principal_id TEXT;
CREATE INDEX runs_by_principal ON runs(principal_id, created_at);
