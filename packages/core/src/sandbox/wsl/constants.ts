/**
 * Fixed identifiers of the private WSL2 distro (docs/design/10-sandbox.md
 * "Windows：私有 WSL2 发行版"). Every wsl.exe invocation lives in this
 * directory (docs 任务书注意事项); the rest of the core only sees the
 * SandboxBackend interface and these pure constants.
 */

/** Distro name used in `wsl --import Kepcup …` / `wsl -d Kepcup`. */
export const WSL_DISTRO_NAME = 'Kepcup';

/** Ordinary (non-root) user inside the distro running sandboxed commands. */
export const WSL_USER = 'kepcup';

/**
 * The distro user's home — wholesale DENIED in the distro-side srt policy
 * (BR-P12-001: without the deny, the deny-then-allow read model would leave
 * every bot's caches and the whole image home readable). Specific paths under
 * it (cache root, workspaces) are re-exposed by the mount plan.
 */
export const WSL_USER_HOME = `/home/${WSL_USER}`;

/**
 * Base environment for the command inside ANY sandbox image (the WSL distro,
 * the Podman image and the Lima VM all ship the `kepcup` user — BR-P12-006). The
 * backends merge these UNDER the policy env (policy wins) so the shim's
 * full-replacement `env` still carries identity/locale/temp basics, mirroring
 * the srt backend's child-env allowlist semantics (BR-P02-008). The host PATH
 * is never inherited: backends rewrite PATH to the in-image toolchain layout.
 */
export const DISTRO_BASE_ENV: Readonly<Record<string, string>> = {
  HOME: `/home/${WSL_USER}`,
  USER: WSL_USER,
  LOGNAME: WSL_USER,
  SHELL: '/bin/bash',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  TMPDIR: '/tmp',
};

/** In-distro workspace layout when the distro-internal filesystem is used. */
export const WSL_WORKSPACES_ROOT = '/home/kepcup/workspaces';

/** In-distro toolchain root (P06 linux toolchains installed into the distro). */
export const WSL_TOOLCHAINS_ROOT = '/opt/kepcup/toolchains';

/** In-distro cache root: sandbox policy cache variables are rewritten here so
 * npm/pip/cargo caches never round-trip through the NTFS drvfs mounts. */
export const WSL_CACHE_ROOT = '/home/kepcup/cache';

/** In-distro helper locations provisioned by the rootfs build (CI artifact). */
export const WSL_SHIM_BIN = '/opt/kepcup/bin/kepcup-sandbox';
export const WSL_MOUNT_BIN = '/opt/kepcup/bin/kepcup-mount';

/** Root of the dynamic drvfs mounts inside the distro. */
export const WSL_MOUNT_ROOT = '/mnt/kepcup';

/**
 * Windows host data directory mounted into the distro? No — nothing of
 * `~/.kepcup` is mounted wholesale (automount is disabled and the data
 * directory is never exposed); only individually registered directories
 * (workspace / project / grants / toolchains / skills) are mounted under
 * WSL_MOUNT_ROOT, each keyed by a content hash of its canonical path.
 */

/** wsl.exe — resolved from System32; tests inject runners instead. */
export const WSL_EXE = 'wsl.exe';

/**
 * Sentinel envelope of the in-distro shim result (sandbox/wsl/protocol.ts).
 * The shim prints the command's own stdout/stderr first and appends one
 * base64-encoded JSON record between these markers. The parser reads from
 * the END of the stream, requires both markers with nothing but whitespace
 * after them, and — when the request carried a nonce — the record must echo
 * it (BR-P12-005): command output alone cannot displace the real record.
 */
export const KEPCUP_RESULT_BEGIN = '__KEPCUP_RESULT_V1__';
export const KEPCUP_RESULT_END = '__KEPCUP_RESULT_END__';

/** Explicit `--version 2`: import as WSL2 even on hosts with WSL1 defaults. */
export const WSL_IMPORT_VERSION_FLAG = '--version 2';
