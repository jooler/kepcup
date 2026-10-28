-- Mail plugin instances (D105 P3, todo/plugin-platform README §4.2):
-- a mailbox account created on a plugin card is an instance of that mail plugin.
-- Legacy accounts keep instance_id NULL and keep working (shown as 未关联插件, not migrated).

ALTER TABLE mail_accounts ADD COLUMN instance_id TEXT REFERENCES plugin_instances(id);
