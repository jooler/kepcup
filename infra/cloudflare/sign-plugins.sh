#!/usr/bin/env bash
# 用仓库根目录 .env 里的 KEPCUP_PLUGIN_SIGNING_KEY 签名并构建插件市场索引（只读取这一个键，不 source、不回显）。
#   infra/cloudflare/sign-plugins.sh --out <dir> --key-id <id> --packages <dir> --catalog <curation.json> ...
#   infra/cloudflare/sign-plugins.sh --verify <dir> --keys <keys.json>
# 其余参数原样传给 scripts/sign-plugin-index.mjs（见该文件头部与 ../plugins/README.md）。
# 注意：本脚本先 cd 到仓库根再执行，--out / --packages / --catalog 要用绝对路径。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KEPCUP_ENV_FILE:-$ROOT/.env}"
line="$(grep -E '^KEPCUP_PLUGIN_SIGNING_KEY=' "$ENV_FILE" | tail -n1 || true)"
[[ -n "$line" ]] || { echo ".env 里缺 KEPCUP_PLUGIN_SIGNING_KEY。" >&2; exit 2; }
export KEPCUP_PLUGIN_SIGNING_KEY="${line#KEPCUP_PLUGIN_SIGNING_KEY=}"
cd "$ROOT"
exec node scripts/sign-plugin-index.mjs "$@"
