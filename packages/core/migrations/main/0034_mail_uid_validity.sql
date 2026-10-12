-- 邮件通道：记录 INBOX 的 UIDVALIDITY（RFC 3501 §2.3.1.1）。
-- last_uid 只在同一个 uid_validity 下有意义；服务器重建邮箱或账号换了另一个邮箱后，
-- UIDVALIDITY 会变，旧游标必须作废并重新取基线，否则新信 uid <= last_uid 会被静默丢掉。
-- 旧行为 NULL：下次连上时记下当前值，不动已有游标。
ALTER TABLE mail_accounts ADD COLUMN uid_validity INTEGER;
