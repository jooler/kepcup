#!/usr/bin/env bash
# 用仓库根目录 .env 里的 Cloudflare 凭证运行一条命令（cf / wrangler / curl …）。
#
#   infra/cloudflare/with-env.sh check                 # 只读自检：令牌有效？账号对不对？看得到 kepcup.com？
#   infra/cloudflare/with-env.sh cf zones list         # 用令牌 A（CLOUDFLARE_API_TOKEN）
#   infra/cloudflare/with-env.sh --admin cf ...        # 改用令牌 B（CLOUDFLARE_ZONE_ADMIN_API_TOKEN）
#   infra/cloudflare/with-env.sh wrangler deploy       # 在子目录里部署（凭证由本脚本注入）
#
# 为什么需要它：
#   - cf 的规则是「shell 里已有的环境变量优先于 .env」。如果 shell 里本来就有别的项目的
#     CLOUDFLARE_API_TOKEN，直接跑 cf 会悄悄用错令牌 / 错账号。本脚本先清掉所有 CLOUDFLARE_* / CF_*，
#     再只从 .env 里取值。
#   - wrangler 在各 infra 子目录里运行，读不到仓库根的 .env；本脚本统一注入。
#   - 不用 `source`：只解析白名单键（CLOUDFLARE_*），文件里的其它内容一律不执行、不导出。
#   - 永不打印令牌值。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${KEPCUP_ENV_FILE:-$ROOT/.env}"
USE_ADMIN=0

if [[ "${1:-}" == "--admin" ]]; then
  USE_ADMIN=1
  shift
fi
if [[ $# -eq 0 ]]; then
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "找不到 $ENV_FILE —— 先 cp .env.example .env 并填写（见 infra/cloudflare/README.md）。" >&2
  exit 2
fi
# .env 不应对其他用户可读。
if [[ -n "$(find "$ENV_FILE" -perm /077 2>/dev/null)" ]]; then
  echo "警告：$ENV_FILE 权限过宽，建议 chmod 600。" >&2
fi

# 清掉 shell 里所有已有的 Cloudflare 变量（含旧式 Global API Key 变量），防止误用。
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep -E '^(CLOUDFLARE_|CF_)' || true)

declare -A VALS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(CLOUDFLARE_[A-Z0-9_]+)=(.*)$ ]]; then
    key="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    val="${val%%[[:space:]]\#*}"            # 行内注释
    val="${val#"${val%%[![:space:]]*}"}"     # 去前导空白
    val="${val%"${val##*[![:space:]]}"}"     # 去尾随空白
    val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    VALS["$key"]="$val"
  fi
done <"$ENV_FILE"

export CLOUDFLARE_ACCOUNT_ID="${VALS[CLOUDFLARE_ACCOUNT_ID]:-}"
[[ -n "${VALS[CLOUDFLARE_ZONE_ID]:-}" ]] && export CLOUDFLARE_ZONE_ID="${VALS[CLOUDFLARE_ZONE_ID]}"
export CLOUDFLARE_ZONE_NAME="${VALS[CLOUDFLARE_ZONE_NAME]:-kepcup.com}"
if [[ "$USE_ADMIN" == 1 ]]; then
  export CLOUDFLARE_API_TOKEN="${VALS[CLOUDFLARE_ZONE_ADMIN_API_TOKEN]:-}"
  [[ -n "$CLOUDFLARE_API_TOKEN" ]] || { echo "--admin 需要 .env 里的 CLOUDFLARE_ZONE_ADMIN_API_TOKEN。" >&2; exit 2; }
else
  export CLOUDFLARE_API_TOKEN="${VALS[CLOUDFLARE_API_TOKEN]:-}"
fi
[[ -n "$CLOUDFLARE_API_TOKEN" ]] || { echo ".env 里缺 CLOUDFLARE_API_TOKEN。" >&2; exit 2; }
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || { echo ".env 里的 CLOUDFLARE_ACCOUNT_ID 应为 32 位十六进制。" >&2; exit 2; }

# 只读自检：不改任何东西。
if [[ "$1" == "check" ]]; then
  echo "== 身份（cf auth whoami，只显示是否有效与账号名）"
  cf auth whoami | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("authenticated:", d.get("authenticated"), "| tokenValid:", d.get("tokenValid"), "| source:", d.get("authSource"))
for a in d.get("accounts", []):
    print("account:", a["id"], a["name"])
'
  echo "== 看得到的 zone（名称 / 状态 / 套餐）"
  cf zones list | python3 -c '
import sys, json, os
d = json.load(sys.stdin)
want = os.environ.get("CLOUDFLARE_ZONE_NAME", "kepcup.com")
found = False
for z in d:
    mark = "  <-- 目标" if z["name"] == want else ""
    found = found or z["name"] == want
    print(z["name"], z["status"], z["plan"]["name"], mark)
print("目标 zone", want, "可见" if found else "不可见：令牌未包含该 zone，或该 zone 在别的账号下")
'
  exit 0
fi

exec "$@"
