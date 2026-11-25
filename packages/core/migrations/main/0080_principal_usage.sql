-- Usage attribution (62.11 C7): usage rows can carry the principal that
-- triggered the run, so team servers can split cost per human without joining
-- main.db to runs.db. Nullable: NULL = single-user status quo.
ALTER TABLE usage_ledger ADD COLUMN principal_id TEXT;
