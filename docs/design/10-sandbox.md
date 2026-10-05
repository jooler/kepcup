# 10 沙箱实现

分级原则见 [06-isolation-and-storage.md](06-isolation-and-storage.md#执行隔离)。

## 选型

| 平台 | 默认使用 | 增强级 |
|---|---|---|
| macOS | `srt`（Seatbelt） | Lima |
| Linux | `srt`（bubblewrap） | rootless Podman |
| Windows | 私有 WSL2 发行版，内部运行 `srt` | 同左 |

`srt` 即 Anthropic 开源的 `@anthropic-ai/sandbox-runtime`（Apache-2.0），可作为 Node 库调用。

## 默认级：srt

- 核心服务以库的方式调用 `srt` 包装每一条命令；沙箱规则在每条命令执行前按当前授权实时生成，见 [13-permissions.md](13-permissions.md)。
- 沙箱初始化失败时不执行命令，转入逐条确认模式；**只有在用户对每一条命令明确确认后，才会在沙箱外执行**。
- `srt` 仍是 0.0.x 研究预览版：锁定版本，封装在我们自己的接口之后，必要时 fork。
- 应用自带其依赖：`rg`（所有平台），`bwrap`、`socat`（Linux）。
- `srt` 会记录每条命令的沙箱违规，可在界面中展示。

### 文件系统规则

| 路径 | 权限 |
|---|---|
| 当前 workspace | 读写 |
| project 目录 | 持有写入租约时读写，否则只读；保护规则中的文件禁止读取 |
| 应用缓存目录、临时目录 | 读写 |
| 本 Bot 的 Skills | 只读 |
| 本 Bot 的 Wiki | 只读（Wiki 维护 loop 为读写） |
| 系统目录、工具链目录（nvm、pyenv、brew 等） | 只读 |
| 本机其他位置 | 默认禁止；按授权放行（只读或读写） |
| `~/.ssh`、系统钥匙串、`~/.aws`、`~/.config/gh`、其他应用的数据目录 | 默认禁止；可授权，但授权卡片醒目警告 |
| `~/.kepcup` 中未列出的部分 | 永远禁止 |
| `.git/config`、`.git/hooks`、shell 配置文件 | 不可写（`srt` 内置规则） |

### 网络

- 沙箱内网络只能经过 `srt` 的本地代理，按 Profile 配置为禁止、白名单、开放三档。
- 所有模式下都拦截：内网地址（RFC1918，需显式配置）、链路本地地址、云服务器元数据接口。
- 主机回环地址（localhost）：
  - 对话绑定了 project 时，该对话中的沙箱命令**允许监听本机端口，并访问本机端口**，用于启动和测试开发服务器；每个 project 可以限定允许的端口范围（默认不限）。
  - 未绑定 project 时拦截。
  - 通过 `srt` 的网络配置实现，实现时验证；Windows 上还需验证 WSL2 与 Windows 之间的本机端口转发。
- 浏览器工具不经过沙箱，其网络规则见 [14-models-and-browser.md](14-models-and-browser.md#网络)。
- 已知限制：不遵循代理设置的工具无法联网。

### 缓存

`npm_config_cache`、`PIP_CACHE_DIR`、`XDG_CACHE_HOME`、`CARGO_HOME` 指向应用自己的缓存目录，不写入用户真实的缓存，防止缓存被投毒。

### 平台注意事项

- **macOS**：`sandbox-exec` 已被标记为废弃，但仍可用，Chrome、Claude Code、Codex 都依赖它。沙箱内禁止 `open` / `osascript`。
- **Linux**：启动时检测用户命名空间是否可用。Ubuntu 24.04 等发行版受 AppArmor 限制时，引导用户执行一次 sudo 命令解除；解除前处于逐条确认模式。

## Windows：私有 WSL2 发行版

- 应用自带精简的 Linux 根文件系统，通过 `wsl --import` 导入到应用数据目录，内部运行 `srt`。
- 支持 Windows 10（版本 19041 及以上）与 Windows 11。
- 首次启用 WSL2 需要一次管理员授权和一次重启；之后导入发行版不需要管理员权限。
- `wsl.conf` 中关闭自动挂载（`automount`）与 Windows 程序调用（`interop`），否则整个 C 盘会暴露，发行版还能启动沙箱外的 Windows 程序。
- 只实时挂载当前 project 目录，以及用户授权的目录（授权后动态挂载，失效后卸载）。
- workspace 放在发行版内部的文件系统中以获得更好的性能（实现时验证）。
- WSL2 尚未启用，或企业策略禁用 WSL 时，处于逐条确认模式并说明原因。
- 已知限制：同一台机器上的所有 WSL2 发行版共享一个虚拟机。
- 沙箱接口保持可替换，WSL 容器（`wslc`）等方案成熟后可以迁移。

## 增强级

- macOS 使用 Lima（支持所有 macOS 版本与 Intel 机器）；Linux 使用 rootless Podman；Windows 与默认使用的方案相同。
- 按需安装，每次需用户确认。

## git

- project 中的本地 git 操作（status、diff、commit 等）在沙箱内执行；git 命令行作为宿主层环境按申请流程安装。
- 远程操作（push / pull / fetch）以及改写 git 配置的操作（`git init`、`git remote add` 等），由核心服务在沙箱外代为执行，每次需用户确认。代为执行时使用用户本机已有的 git 凭据配置，凭据不进入沙箱。
