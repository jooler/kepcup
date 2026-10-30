#!/usr/bin/env bash
# 在 RHEL 9（glibc 2.34）构建 RPM 时，替换 es-git 的官方 gnu 预编译绑定。
#
# es-git 0.7.0 的 es-git-linux-*-gnu.node 引用 glibc 2.38 才提供的
# __isoc23_strtol；RHEL 9 是 glibc 2.34，Node 加载该 .node 会直接失败
# （core 的 start.ts 静态 import es-git，应用起不来）。RHEL 10（glibc 2.39）
# 不受影响，不需要跑本脚本。
#
# 做法：从同一 tag 拉源码，在目标发行版里重新 cargo build。vendored libgit2 /
# openssl 会一起编译，产物只依赖构建机的 glibc。构建完替换 pnpm 安装的
# platform 包里的 .node，并用当前 Node 真加载一次做冒烟。
#
# 依赖：cargo / rustup（rust-toolchain.toml 指定的版本）、cmake、perl、gcc、
# g++、make、pkgconf、git、node。CI 的 linux-rpm job 已安装。
#
#   bash scripts/release/rebuild-es-git.sh
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
version=$(node -p "require('${repo_root}/packages/core/package.json').dependencies['es-git']")
if [ -z "$version" ] || [ "$version" = "undefined" ]; then
  echo "[es-git] packages/core/package.json 里没有 es-git 依赖" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "[es-git] 未找到 cargo；先安装 rustup（rust-toolchain.toml 会固定版本）" >&2
  exit 1
fi

workdir="${RUNNER_TEMP:-/tmp}/es-git-src-$version"
if [ ! -d "$workdir/.git" ]; then
  echo "[es-git] clone toss/es-git v$version 到 $workdir"
  rm -rf "$workdir"
  git clone --depth 1 --branch "v$version" https://github.com/toss/es-git.git "$workdir"
fi

# 上游 rust-toolchain.toml 固定版本；rustup 缺哪个装哪个（CI 只装 rustup 本身）。
toolchain=$(sed -n 's/^channel *= *"\([^"]*\)".*/\1/p' "$workdir/rust-toolchain.toml" | head -1)
if [ -n "$toolchain" ] && ! rustup toolchain list | grep -q "^$toolchain"; then
  echo "[es-git] rustup toolchain install $toolchain"
  rustup toolchain install "$toolchain" --profile minimal
fi

echo "[es-git] cargo build --release --locked（vendored libgit2/openssl，耗时较长）"
(cd "$workdir" && cargo build --release --locked)

built="$workdir/target/release/libes_git.so"
if [ ! -f "$built" ]; then
  echo "[es-git] 构建产物缺失：$built" >&2
  exit 1
fi

# pnpm 的 platform 包目录形如
#   node_modules/.pnpm/es-git-linux-x64-gnu@0.7.0/node_modules/es-git-linux-x64-gnu/
binding=$(find "$repo_root/node_modules/.pnpm" \
  -path "*es-git-linux-*-gnu@*/node_modules/es-git-linux-*-gnu/*.node" \
  -print -quit)
if [ -z "$binding" ]; then
  echo "[es-git] 未找到已安装的 gnu 绑定（先 pnpm install）" >&2
  exit 1
fi

cp "$built" "$binding"
echo "[es-git] 已替换：$binding"

# 在目标发行版里真加载一次：glibc 符号不兼容会在这里暴露，而不是等到用户启动。
node -e 'require(process.argv[1])' "$binding"
if grep -aq '__isoc23_strtol' "$binding"; then
  echo "[es-git] 重建后仍引用 __isoc23_strtol——构建机 glibc 太新" >&2
  exit 1
fi
echo "[es-git] 冒烟通过：binding 可在当前系统加载"
