import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { NODE_VERSION } from '../../env/catalog.js';
import {
  LIMA_GUEST_PACKAGES,
  LIMA_PROVISION_MARKER,
  LIMA_SHIM_BIN,
  LIMA_TOOL_ROOT,
} from './constants.js';

/**
 * Lima VM 内的沙箱工具初始化（macOS 增强级）。
 *
 * 与 WSL rootfs 构建（apps/desktop/scripts/build-wsl-rootfs）保持同一套
 * 组件：Debian 12 + 官方 Node + `@anthropic-ai/sandbox-runtime` + shim。
 * 需要联网（apt + nodejs.org + npm），首次数分钟；脚本幂等，marker 命中且
 * 版本一致时直接退出。
 */

/** 运行时解析已安装的 srt 版本，避免与 package.json 漂移。 */
export function sandboxRuntimeVersion(): string {
  try {
    const requireFromCore = createRequire(import.meta.url);
    const pkg = requireFromCore('@anthropic-ai/sandbox-runtime/package.json') as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // packaged 布局异常时退回与 packages/core/package.json 一致的固定版本。
  }
  return '0.0.78';
}

export interface ProvisionInput {
  /** 官方 Node 版本（与 env/catalog 的 NODE_VERSION 一致）。 */
  nodeVersion?: string;
  /** srt 版本（默认从已安装包解析）。 */
  srtVersion?: string;
  /** shim 脚本内容的 base64（宿主侧读取 kepcup-sandbox.cjs）。 */
  shimBase64: string;
}

/**
 * 生成以 `bash -s` 从 stdin 执行的初始化脚本。所有输出都以 `[kepcup]`
 * 前缀标记，setup 用它更新向导进度文本。
 */
export function buildProvisionScript(input: ProvisionInput): string {
  const nodeVersion = input.nodeVersion ?? NODE_VERSION;
  const srtVersion = input.srtVersion ?? sandboxRuntimeVersion();
  const shimSha = createHash('sha256')
    .update(Buffer.from(input.shimBase64, 'base64'))
    .digest('hex');
  return `#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

readonly TOOL_ROOT="${LIMA_TOOL_ROOT}"
readonly SHIM="${LIMA_SHIM_BIN}"
readonly MARKER="${LIMA_PROVISION_MARKER}"
readonly WANT_NODE="${nodeVersion}"
readonly WANT_SRT="${srtVersion}"
readonly WANT_SHIM_SHA="${shimSha}"

if [ -x "$SHIM" ] && [ -f "$MARKER" ] \\
  && grep -qx "node=$WANT_NODE" "$MARKER" \\
  && grep -qx "srt=$WANT_SRT" "$MARKER" \\
  && grep -qx "shim=$WANT_SHIM_SHA" "$MARKER"; then
  echo "[kepcup] 沙箱工具已是目标版本（node $WANT_NODE / srt $WANT_SRT / shim 未变）"
  exit 0
fi

echo "[kepcup] 安装系统依赖：${LIMA_GUEST_PACKAGES}"
sudo -n apt-get update -qq
sudo -n apt-get install -y -qq --no-install-recommends ${LIMA_GUEST_PACKAGES}

case "$(uname -m)" in
  aarch64|arm64) node_arch="linux-arm64" ;;
  x86_64|amd64) node_arch="linux-x64" ;;
  *) echo "[kepcup] 不支持的虚拟机架构：$(uname -m)" >&2; exit 1 ;;
esac
node_tar="node-v$WANT_NODE-$node_arch.tar.xz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "[kepcup] 下载 Node $WANT_NODE（$node_arch）"
curl -fsSL -o "$tmp/$node_tar" "https://nodejs.org/dist/v$WANT_NODE/$node_tar"
curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$WANT_NODE/SHASUMS256.txt"
( cd "$tmp" && grep "  $node_tar\\$" SHASUMS256.txt | sha256sum -c - >/dev/null )
sudo -n mkdir -p "$TOOL_ROOT/node" "$TOOL_ROOT/bin"
sudo -n rm -rf "$TOOL_ROOT/node"
sudo -n mkdir -p "$TOOL_ROOT/node"
sudo -n tar -xJf "$tmp/$node_tar" -C "$TOOL_ROOT/node" --strip-components=1

echo "[kepcup] 安装 @anthropic-ai/sandbox-runtime@$WANT_SRT"
sudo -n env PATH="$TOOL_ROOT/node/bin:/usr/local/bin:/usr/bin:/bin" \\
  "$TOOL_ROOT/node/bin/npm" install --prefix "$TOOL_ROOT" --ignore-scripts \\
  "@anthropic-ai/sandbox-runtime@$WANT_SRT"

echo "[kepcup] 安装沙箱入口"
base64 -d > "$tmp/kepcup-sandbox" <<'KEPCUP_SHIM_B64'
${input.shimBase64}
KEPCUP_SHIM_B64
sudo -n install -m 0755 "$tmp/kepcup-sandbox" "$SHIM"
sudo -n ln -sfn "$TOOL_ROOT/node/bin/node" "$TOOL_ROOT/bin/node"

printf 'node=%s\\nsrt=%s\\nshim=%s\\n' "$WANT_NODE" "$WANT_SRT" "$WANT_SHIM_SHA" | sudo -n tee "$MARKER" >/dev/null
echo "[kepcup] 沙箱工具初始化完成"
`;
}
