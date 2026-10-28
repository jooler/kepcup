-- Mail plugin instances (D105 P3, todo/plugin-platform README §4.2):
-- a mailbox account created on a plugin card is an instance of that mail plugin.
-- Legacy accounts keep instance_id NULL and keep working (shown as 未关联插件, not migrated).
-- ON DELETE SET NULL: an instance row must never block its own deletion — if the
-- instance row goes (direct delete, uninstall cascade, or a crash-recovery sweep)
-- the account survives as an unowned row (未关联插件) instead of deadlocking the
-- plugin row delete through the FK (review P0-1).

ALTER TABLE mail_accounts ADD COLUMN instance_id TEXT REFERENCES plugin_instances(id) ON DELETE SET NULL;
