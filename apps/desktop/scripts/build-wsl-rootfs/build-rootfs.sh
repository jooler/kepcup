#!/usr/bin/env bash
# =============================================================================
# build-wsl-rootfs — reproducible rootfs tar for the private WSL2 distro
# (docs/dev/phases/P12-windows-and-enhanced-sandbox.md 任务 1).
#
# **本机不执行**：脚本为 CI 产物编写（在 debian:12 容器内运行），产物为
# apps/desktop/resources/wsl/rootfs.tar + rootfs-manifest.json（版本与
# sha256 记录）。随 Windows 安装包分发；setup.ts 在导入时校验存在性。
#
# 裁决（记录于 PROGRESS.md P12）：基础发行版选 **Debian 12 slim（glibc）**
# 而非 Alpine——srt 的 Linux 路径依赖 bubblewrap+socat（apt 直装），P06 的
# python-build-standalone 与官方 Node 均为 glibc 构建；musl 兼容性不作为
# 盲写赌注。**srt 依赖（bwrap 在 WSL2 内核的 user namespaces）在其上的
# 可用性待发行版内验证**：导入后的首个自检（kepcup-sandbox --selfcheck，见
# sandbox/wsl/setup.ts ensureDistro）即该验证的自动化入口；P02/P03 安全
# 用例集在 WSL 后端的运行列入 todo/cross-platform-acceptance.md P12。
#
# CI 产出（注释形式，供 P13 打包阶段接入 .github/workflows）：
# ```yaml
# jobs:
#   rootfs:
#     runs-on: ubuntu-latest
#     steps:
#       - uses: actions/checkout@v4
#       - run: bash apps/desktop/scripts/build-wsl-rootfs/build-rootfs.sh
#       - uses: actions/upload-artifact@v4
#         with: { name: wsl-rootfs, path: apps/desktop/resources/wsl/ }
#       # 打包 job 下载该 artifact 并放进 Windows 安装包的 resources/。
# ```
#
# 可重复性：基础镜像、Node 版本、srt 版本、uv 版本、apt 包清单全部钉版本；
# manifest 记录每个组件的版本与最终 tar 的 sha256。tar 按路径排序 + 固定
# mtime/owner 消除顺序噪声（apt 元数据的时间戳类残余除外，内容语义可重复）。
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$(cd "${HERE}/../../resources/wsl" && pwd)"
STAGING="$(mktemp -d)"
trap 'rm -rf "${STAGING}"' EXIT

# ---- pinned inputs（升级 = 改这里 + 重跑 + 提交新 manifest）-------------------
readonly DEBIAN_IMAGE="debian:12-slim"          # 升级时同时把 digest 钉进 CI（docker pull + docker image inspect）
readonly NODE_VERSION="24.21.0"                 # 与 packages/core/src/env/catalog.ts NODE_VERSION 一致
readonly NODE_ARCH="linux-x64"                  # CI 产物同时构建 linux-arm64 时改此值并重跑
readonly NODE_SHA256="<SHASUMS256.txt 官方值，构建时校验>"  # CI 步骤先抓 https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt 核对
readonly SRT_VERSION="0.0.78"                   # 与 apps/desktop package.json 的 @anthropic-ai/sandbox-runtime 一致
readonly UV_VERSION="0.12.21"                   # 发行版内 uv（uv python install 用，见 env/distro.ts）

mkdir -p "${OUT_DIR}"
ROOT="${STAGING}/rootfs"
mkdir -p "${ROOT}"

# ---- rootfs 内容（容器内安装 + 容器内确定性打包）-------------------------------
# install-inside-debian.sh（与 build-rootfs.sh 同目录）在容器内执行，6 步见其
# 头注释：apt 工具（任务书清单）、官方 Node（SHASUMS256.txt 校验）→
# /opt/kepcup/node、srt（--ignore-scripts）+ uv（官方 checksums 校验）→
# /opt/kepcup、shim 脚本 → /opt/kepcup/bin、node 符号链接；/etc/wsl.conf 不进镜像
# （sandbox/wsl/setup.ts 在导入后写入——automount/interop 关闭是导入时的
# 安全基线，唯一来源是 conf.ts）。打包同样在容器内完成（GNU tar 确定性参数），
# 产物经 /target 卷落回 ${ROOT}/rootfs.tar。
docker run --rm \
  -v "${HERE}:/src:ro" \
  -v "${ROOT}:/target" \
  "${DEBIAN_IMAGE}" \
  bash /src/install-inside-debian.sh "${NODE_VERSION}" "${NODE_ARCH}" "${SRT_VERSION}" "${UV_VERSION}"

# ---- 产物守卫（BR-P12-004）----------------------------------------------------
# 不满足即 exit 1：绝不产出「空 tar + 有效 manifest」——CI 拿到这种产物会让
# 每台 Windows 机器在导入时才失败，且 manifest 看起来完全有效。
TAR_PATH="${ROOT}/rootfs.tar"
readonly MIN_ROOTFS_BYTES=$((100 * 1024 * 1024))   # debian slim + node + srt 解包 ≥ 数百 MB，100MB 为保守下限
if [ ! -s "${TAR_PATH}" ]; then
  echo "build-rootfs: rootfs.tar 缺失或为空——容器内安装未完成" >&2
  exit 1
fi
SIZE="$(stat -f%z "${TAR_PATH}" 2>/dev/null || stat -c%s "${TAR_PATH}")"
if [ "${SIZE}" -lt "${MIN_ROOTFS_BYTES}" ]; then
  echo "build-rootfs: rootfs.tar 只有 ${SIZE} 字节（下限 ${MIN_ROOTFS_BYTES}）——容器内安装未完成" >&2
  exit 1
fi
for member in opt/kepcup/bin/kepcup-sandbox opt/kepcup/bin/kepcup-mount opt/kepcup/bin/node opt/kepcup/bin/uv opt/kepcup/node/bin/node; do
  if ! tar -tf "${TAR_PATH}" | grep -q "^\./${member}\$"; then
    echo "build-rootfs: rootfs.tar 缺少 ${member}——容器内安装未完成" >&2
    exit 1
  fi
done

mv "${TAR_PATH}" "${OUT_DIR}/rootfs.tar"

# ---- manifest：版本与校验值记录（任务 1）---------------------------------------
SHA256="$(shasum -a 256 "${OUT_DIR}/rootfs.tar" | awk '{print $1}')"
SIZE="$(stat -f%z "${OUT_DIR}/rootfs.tar" 2>/dev/null || stat -c%s "${OUT_DIR}/rootfs.tar")"
cat > "${OUT_DIR}/rootfs-manifest.json" <<EOF
{
  "version": 1,
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "base": "${DEBIAN_IMAGE}",
  "node": "${NODE_VERSION}",
  "nodeArtifact": "${NODE_ARCH}",
  "sandboxRuntime": "${SRT_VERSION}",
  "uv": "${UV_VERSION}",
  "tools": ["bash", "coreutils", "git", "ripgrep", "bubblewrap", "socat", "ca-certificates"],
  "tar": { "sha256": "${SHA256}", "sizeBytes": ${SIZE} }
}
EOF

echo "rootfs.tar + rootfs-manifest.json written to ${OUT_DIR}"
echo "sha256: ${SHA256}"
