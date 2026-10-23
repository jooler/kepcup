-- 远程遥控（D96，docs/design/46-remote-control.md §5.3）。
--
-- 一行 = 一个已配对遥控端点（手机 PWA）。device_id 由手机在配对时生成（加密随机），
-- 审计里远程动作带 remote:{device_id} 来源标记。会话密钥与 token 明文永不入本表：
-- 密钥材料入 secrets 表 `remote:{device_id}`（沿用字段级 AES-256-GCM），桌面只存
-- token 的 sha256（撤销时连同密钥一起清空，行保留供审计）。
--   psk_mode       x25519（ECDH+HKDF，PFS）/ psk（WebCrypto 无 X25519 的回退，无 PFS）
--   last_seen_at   每次重连自举（hello 通过）刷新
--   revoked_at     非 NULL = 已撤销（kick 已发、密钥与 token 哈希已删）
CREATE TABLE remote_devices (
  device_id       TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  psk_mode        TEXT NOT NULL CHECK (psk_mode IN ('x25519','psk')),
  token_hash      TEXT,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER,
  revoked_at      INTEGER
);

-- 设备管理列表按最近在线排序；撤销行沉底。
CREATE INDEX remote_devices_active
  ON remote_devices(revoked_at, last_seen_at DESC);
