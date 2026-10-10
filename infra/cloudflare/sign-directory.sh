#!/usr/bin/env bash
# 用仓库根目录 .env 里的 KEPCUP_CONNECTOR_SIGNING_KEY 签名并构建目录索引（只读取这一个键，不 source、不回显）。
#   infra/cloudflare/sign-directory.sh [sign-connector-index.mjs 的参数…]
# 默认输出到 infra/cloudflare/directory/public/connectors/v1，keyId 取 kepcup-2026-1（可用参数覆盖）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KEPCUP_ENV_FILE:-$ROOT/.env}"
line="$(grep -E '^KEPCUP_CONNECTOR_SIGNING_KEY=' "$ENV_FILE" | tail -n1 || true)"
[[ -n "$line" ]] || { echo ".env 里缺 KEPCUP_CONNECTOR_SIGNING_KEY。" >&2; exit 2; }
export KEPCUP_CONNECTOR_SIGNING_KEY="${line#KEPCUP_CONNECTOR_SIGNING_KEY=}"
cd "$ROOT"
exec node scripts/sign-connector-index.mjs "$@"
