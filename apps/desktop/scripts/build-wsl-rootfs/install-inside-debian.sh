#!/usr/bin/env bash
# =============================================================================
# install-inside-debian.sh — runs INSIDE the debian:12-slim build container
# (invoked by build-rootfs.sh with the pinned versions as arguments; this
# directory is mounted read-only at /src and the tar destination at /target).
# Populates the container filesystem and then packs it deterministically to
# /target/rootfs.tar — the artifact setup.ts imports as the private WSL2
# distro (P12 任务 1).
#
# Steps (build-rootfs.sh 头注释的 6 步)：
#   1. apt-get install: bash coreutils git ripgrep bubblewrap socat
#      ca-certificates curl xz-utils tar (任务书清单 + 下载/解压工具)；
#   2. official Node tarball (sha256 verified against SHASUMS256.txt fetched
#      from nodejs.org) → /opt/kepcup/node；
#   3. npm install --prefix /opt/kepcup @anthropic-ai/sandbox-runtime@$SRT_VERSION
#      (--ignore-scripts: 纯 JS 依赖，无安装脚本)；uv single-file binary
#      (sha256 verified against the release checksums file) → /opt/kepcup/bin/uv
#      (发行版内 python 安装用，env/distro.ts)；
#   4. copy kepcup-sandbox.cjs → /opt/kepcup/bin/kepcup-sandbox (chmod +x), kepcup-mount →
#      /opt/kepcup/bin/kepcup-mount (chmod +x)；
#   5. ln -s /opt/kepcup/node/bin/node /opt/kepcup/bin/node (the shim's shebang
#      target)；
#   6. /etc/wsl.conf is NOT baked into the image — sandbox/wsl/setup.ts
#      writes it after the import (automount/interop off is the import-time
#      security baseline; conf.ts is its single source).
#
# Runs as root inside the container; needs network (apt + downloads). Any
# failed download / checksum mismatch aborts with a non-zero exit so the
# outer build never ships a half-installed rootfs.
# =============================================================================
set -euo pipefail

NODE_VERSION="${1:?usage: install-inside-debian.sh <node-version> <node-arch> <srt-version> <uv-version>}"
NODE_ARCH="${2:?node arch (linux-x64|linux-arm64)}"
SRT_VERSION="${3:?sandbox-runtime version}"
UV_VERSION="${4:?uv version}"

case "${NODE_ARCH}" in
  linux-x64)   NODE_TAR="node-v${NODE_VERSION}-linux-x64.tar.xz";   UV_TRIPLET="x86_64-unknown-linux-musl" ;;
  linux-arm64) NODE_TAR="node-v${NODE_VERSION}-linux-arm64.tar.xz"; UV_TRIPLET="aarch64-unknown-linux-musl" ;;
  *) echo "install-inside-debian: unsupported NODE_ARCH: ${NODE_ARCH}" >&2; exit 2 ;;
esac

echo "[1/5] apt packages (Debian 12 slim base)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  bash coreutils git ripgrep bubblewrap socat ca-certificates curl xz-utils tar
rm -rf /var/lib/apt/lists/*

mkdir -p /opt/kepcup/bin /opt/kepcup/node

echo "[2/5] Node ${NODE_VERSION} (${NODE_ARCH}, sha256 verified)"
curl -fsSL -o /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
curl -fsSL -o /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
NODE_SHA="$(grep "  ${NODE_TAR}\$" /tmp/SHASUMS256.txt | awk '{print $1}')"
[ -n "${NODE_SHA}" ] || { echo "install-inside-debian: SHASUMS256.txt 中找不到 ${NODE_TAR}" >&2; exit 1; }
echo "${NODE_SHA}  /tmp/node.tar.xz" | sha256sum -c - >/dev/null
tar -xJf /tmp/node.tar.xz -C /opt/kepcup/node --strip-components=1
rm -f /tmp/node.tar.xz /tmp/SHASUMS256.txt

echo "[3/5] @anthropic-ai/sandbox-runtime ${SRT_VERSION} + uv ${UV_VERSION}"
npm install --prefix /opt/kepcup --ignore-scripts "@anthropic-ai/sandbox-runtime@${SRT_VERSION}"
UV_TAR="uv-${UV_VERSION}-${UV_TRIPLET}.tar.gz"
curl -fsSL -o /tmp/uv.tar.gz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_TAR}"
curl -fsSL -o /tmp/uv-checksums.txt "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${UV_VERSION}-checksums.txt"
UV_SHA="$(grep "  ${UV_TAR}\$" /tmp/uv-checksums.txt | awk '{print $1}')"
[ -n "${UV_SHA}" ] || { echo "install-inside-debian: checksums 中找不到 ${UV_TAR}" >&2; exit 1; }
echo "${UV_SHA}  /tmp/uv.tar.gz" | sha256sum -c - >/dev/null
tar -xzf /tmp/uv.tar.gz -C /tmp
install -m 0755 "/tmp/uv-${UV_VERSION}-${UV_TRIPLET}/uv" /opt/kepcup/bin/uv
rm -rf /tmp/uv.tar.gz /tmp/uv-checksums.txt "/tmp/uv-${UV_VERSION}-${UV_TRIPLET}"

echo "[4/5] shim scripts"
install -m 0755 /src/kepcup-sandbox.cjs /opt/kepcup/bin/kepcup-sandbox
install -m 0755 /src/kepcup-mount /opt/kepcup/bin/kepcup-mount

echo "[5/5] node symlink (shim shebang target)"
ln -sf /opt/kepcup/node/bin/node /opt/kepcup/bin/node

# Build residue must not enter the image (size + reproducibility): npm cache,
# curl leftovers, package-manager lists.
rm -rf /root/.npm /root/.cache /var/tmp/* /tmp/*

echo "[tar] packing the filesystem (deterministic: sorted, fixed mtime/owner)"
mkdir -p /target
cd /
tar --sort=name --mtime='UTC 2026-10-01' --owner=0 --group=0 --numeric-owner \
  --exclude='./target' --exclude='./target/*' \
  --exclude='./proc/*' --exclude='./sys/*' --exclude='./dev/*' --exclude='./run/*' \
  -cf /target/rootfs.tar .

echo "install-inside-debian: done ($(stat -c%s /target/rootfs.tar) bytes)"
