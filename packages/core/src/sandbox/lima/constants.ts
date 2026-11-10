/**
 * Lima 增强沙箱（macOS）的固定值（P12 增强级 + 设置页「创建虚拟机」能力）。
 *
 * VM 命名与 guest 内工具根必须与 sandbox/backend-container.ts 的执行约定
 * 一致：backend 以 `/opt/kepcup/bin/kepcup-sandbox` 作为唯一入口，所以
 * 初始化脚本与 shim 资源都以这里为准。
 */

/** Lima 实例名（`limactl create --name` / `limactl shell`）。 */
export const LIMA_VM_NAME = 'kepcup';

/** 作为 base 的官方模板：Debian 12（与 WSL rootfs 同发行版）。 */
export const LIMA_TEMPLATE = 'template:debian-12';

/** guest 内工具根（Node / srt / shim 均在其下）。 */
export const LIMA_TOOL_ROOT = '/opt/kepcup';

/** guest 内 shim 入口（backend-container 的 execArgv 使用同一路径）。 */
export const LIMA_SHIM_BIN = `${LIMA_TOOL_ROOT}/bin/kepcup-sandbox`;

/** 初始化完成标记（幂等判断：node/srt 版本匹配时跳过重复安装）。 */
export const LIMA_PROVISION_MARKER = `${LIMA_TOOL_ROOT}/.lima-provisioned`;

/** 与 WSL rootfs 相同的 apt 包集（srt 的 Linux 依赖 + 下载工具）。 */
export const LIMA_GUEST_PACKAGES =
  'bash coreutils git ripgrep bubblewrap socat ca-certificates curl xz-utils tar';

/** `limactl create` 的默认资源（磁盘为稀疏文件）。 */
export const LIMA_CPUS = 4;
export const LIMA_MEMORY = '4GiB';
export const LIMA_DISK_GIB = 20;
