-- D104: update journal. A non-NULL update_to marks an update in flight; the row keeps describing
-- the OLD version/dir until the commit statement flips everything at once.
ALTER TABLE plugins ADD COLUMN update_to TEXT;
ALTER TABLE plugins ADD COLUMN update_snapshot TEXT;   -- JSON {kind: opaque string} from projector.beginUpdate()
