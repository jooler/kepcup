#!/usr/bin/env bash
# =============================================================================
# build-wsl-rootfs — reproducible rootfs tars for the private WSL2 distro
# (docs/dev/phases/P12-windows-and-enhanced-sandbox.md 任务 1).
#
# **CI 产物优先，本机重跑只作开发用途**：产物为按架构分目录的
#   apps/desktop/resources/wsl/x64/rootfs.tar + rootfs-manifest.json
#   apps/desktop/resources/wsl/arm64/rootfs.tar + rootfs-manifest.json
# （版本与 sha256 记录）。随 Windows 安装包按架构分发（electron-builder 的
# extraResources `from: resources/wsl/${arch}` 每个 pack pass 只取匹配架构的
# 子目录）；setup.ts 在导入时按宿主 WSL2 内核架构校验存在性。dist.mjs 在
# Windows 本地打包缺产物时默认自建（可用 KEPCUP_DIST_SKIP_ROOTFS=1 跳过）。
#
# 裁决（记录于 PROGRESS.md P12）：基础发行版选 **Debian 12 slim（glibc）**
# 而非 Alpine——srt 的 Linux 路径依赖 bubblewrap+socat（apt 直装），P06 的
# python-build-standalone 与官方 Node 均为 glibc 构建；musl 兼容性不作为
# 盲写赌注。**srt 依赖（bwrap 在 WSL2 内核的 user namespaces）在其上的
# 可用性待发行版内验证**：导入后的首个自检（kepcup-sandbox --selfcheck，见
# sandbox/wsl/setup.ts ensureDistro）即该验证的自动化入口；已于 2026-10-18
# 在 x64 Windows 真机通过（BR-P12-005 shim 修复后）；arm64 真机仍留
# cross-platform-acceptance P12 项。
#
# CI 产出（release.yml rootfs job）：
# ubuntu amd64 runner + docker/setup-qemu-action（arm64 的 apt 基座必须来自
# arm64 容器——二进制架构跟容器走，与 NODE_ARCH 无关；混架构 tar 的成员
# 守卫抓不出来，自检才炸，故容器平台与目标架构必须一一对应）。
# Apple Silicon 等本机重跑同理：x64 构建跑 --platform linux/amd64（Docker
# Desktop 走 Rosetta），arm64 原生。
#
# 可重复性：基础镜像、Node 版本、srt 版本、uv 版本、apt 包清单全部钉版本；
# manifest 记录每个组件的版本与最终 tar 的 sha256。tar 按路径排序 + 固定
# mtime/owner 消除顺序噪声（apt 元数据的时间戳类残余除外，内容语义可重复）。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# resources/wsl 是 CI 产物目录，仓库里通常只有 .gitkeep；必须先 mkdir 再 cd。
OUT_BASE="$(cd "${HERE}/../../resources" && pwd)/wsl"
mkdir -p "${OUT_BASE}"
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

# ---- pinned inputs（升级 = 改这里 + 重跑 + 提交新 manifest）-------------------
readonly DEBIAN_IMAGE="debian:12-slim"          # 升级时同时把 digest 钉进 CI（docker pull + 每架构 docker image inspect）
readonly NODE_VERSION="24.21.0"                 # 与 packages/core/src/env/catalog.ts NODE_VERSION 一致
readonly SRT_VERSION="0.0.78"                   # 与 packages/core 的 @anthropic-ai/sandbox-runtime 一致
readonly UV_VERSION="0.12.21"                   # 发行版内 uv（uv python install 用，见 env/distro.ts）；Node/uv 校验在 install-inside-debian.sh 拉取官方 checksum

readonly MIN_ROOTFS_BYTES=$((100 * 1024 * 1024))   # debian slim + node + srt 解包 ≥ 数百 MB，100MB 为保守下限

# "<目标架构> <容器平台>" 一一对应：容器平台决定 apt 基座的二进制架构，
# NODE_ARCH 只挑下载的 Node/uv 官方产物——两者不一致产出混架构 tar，
# 成员守卫（见下）抓不出来，导入后的自检才炸。BR-P12-005 的教训。
# 不用「tar | grep -q」：grep -q 命中后提前关管道，pipefail 下 tar 收到
# SIGPIPE 会让整段判失败，误报「缺少成员」（CI 上已复现）。改成按路径
# 直接列成员。

# 用法：
#   bash build-rootfs.sh            # 缺省：构建 x64 + arm64 双架构（CI / 完整重建）
#   bash build-rootfs.sh x64        # 只构建 x64（本地 Windows x64 机器出本机产物）
#   bash build-rootfs.sh arm64      # 只构建 arm64
if [ "$#" -gt 0 ]; then
  for spec_wanted in "$@"; do
    case "$spec_wanted" in x64|arm64) ;; *) echo "build-rootfs: 未知架构 $spec_wanted（可选 x64|arm64）" >&2; exit 2 ;; esac
  done
fi
for arch_pair in "x64 amd64" "arm64 arm64"; do
  read -r ARCH DOCKERARCH <<<"${arch_pair}"
  if [ "$#" -gt 0 ]; then
    skip=1
    for spec_wanted in "$@"; do [ "$spec_wanted" = "$ARCH" ] && skip=0; done
    if [ "$skip" -eq 1 ]; then continue; fi
  fi
  ROOT="${STAGING}/rootfs-${ARCH}"
  mkdir -p "${ROOT}"
  OUT_ARCH_DIR="${OUT_BASE}/${ARCH}"
  mkdir -p "${OUT_ARCH_DIR}"

  docker run --rm \
    --platform "linux/${DOCKERARCH}" \
    -v "${HERE}:/src:ro" \
    -v "${ROOT}:/target" \
    "${DEBIAN_IMAGE}" \
    bash /src/install-inside-debian.sh "${NODE_VERSION}" "linux-${ARCH}" "${SRT_VERSION}" "${UV_VERSION}"

  # ---- 产物守卫（BR-P12-004，逐架构执行）--------------------------------------
  # 不满足即 exit 1：绝不产出「空 tar + 有效 manifest」——CI 拿到这种产物
  # 会让每台 Windows 机器在导入时才失败，且 manifest 看起来完全有效。
  TAR_PATH="${ROOT}/rootfs.tar"
  if [ ! -s "${TAR_PATH}" ]; then
    echo "build-rootfs(${ARCH}): rootfs.tar 缺失或为空——容器内安装未完成" >&2
    exit 1
  fi
  SIZE="$(stat -f%z "${TAR_PATH}" 2>/dev/null || stat -c%s "${TAR_PATH}")"
  if [ "${SIZE}" -lt "${MIN_ROOTFS_BYTES}" ]; then
    echo "build-rootfs(${ARCH}): rootfs.tar 只有 ${SIZE} 字节（下限 ${MIN_ROOTFS_BYTES}）——容器内安装未完成" >&2
    exit 1
  fi
  for member in opt/kepcup/bin/kepcup-sandbox opt/kepcup/bin/kepcup-mount opt/kepcup/bin/node opt/kepcup/bin/uv opt/kepcup/node/bin/node; do
    if ! tar -tf "${TAR_PATH}" "./${member}" >/dev/null 2>&1; then
      echo "build-rootfs(${ARCH}): rootfs.tar 缺少 ${member}——容器内安装未完成" >&2
      exit 1
    fi
  done

  mv "${TAR_PATH}" "${OUT_ARCH_DIR}/rootfs.tar"

  # ---- manifest：版本与校验值记录（任务 1；nodeArtifact 记下载产物架构）-------
  SHA256="$(shasum -a 256 "${OUT_ARCH_DIR}/rootfs.tar" | awk '{print $1}')"
  SIZE="$(stat -f%z "${OUT_ARCH_DIR}/rootfs.tar" 2>/dev/null || stat -c%s "${OUT_ARCH_DIR}/rootfs.tar")"
  cat > "${OUT_ARCH_DIR}/rootfs-manifest.json" <<EOF
{
  "version": 1,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "base": "${DEBIAN_IMAGE}",
  "node": "${NODE_VERSION}",
  "nodeArtifact": "linux-${ARCH}",
  "sandboxRuntime": "${SRT_VERSION}",
  "uv": "${UV_VERSION}",
  "tools": ["bash", "coreutils", "git", "ripgrep", "bubblewrap", "socat", "ca-certificates"],
  "tar": { "sha256": "${SHA256}", "sizeBytes": ${SIZE} }
}
EOF

  echo "rootfs-${ARCH}: rootfs.tar + rootfs-manifest.json written to ${OUT_ARCH_DIR}"
  echo "rootfs-${ARCH} sha256: ${SHA256}"
done
