# P12 Windows WSL2 与增强沙箱

## 目标

Windows 上通过应用私有的 WSL2 发行版提供沙箱（内部运行 srt），命令不再需要逐条确认；macOS 与 Linux 提供按需安装的增强沙箱（Lima、rootless Podman），供声明需要增强沙箱的技能与任务使用。

## 依赖

P04、P06。

## 设计依据

- [design/10-sandbox.md](../../design/10-sandbox.md#windows私有-wsl2-发行版)（WSL2 方案）、[design/10-sandbox.md](../../design/10-sandbox.md#增强级)（增强级）
- [design/07-local-runtime.md](../../design/07-local-runtime.md#环境配置分级按需)（首次启动时的 Windows 准备）
- [design/13-permissions.md](../../design/13-permissions.md)（授权目录的动态挂载、逐条确认模式）
- [02-architecture.md](../02-architecture.md#沙箱)（`SandboxBackend` 接口）

## 范围

包含：

- Linux 根文件系统的构建流水线：精简发行版（建议 Debian slim 或 Alpine，**需验证** srt 依赖在其上可用），包含 bash、coreutils、git、ripgrep、bubblewrap、socat、ca-certificates，以及 srt 运行所需的 Node；产物为 tar，随 Windows 安装包分发（`resources/wsl/rootfs.tar`）。
- WSL 启用流程：检测 WSL2 状态（未安装 / 已安装但未启用虚拟机平台 / 可用）；引导启用（需要管理员授权与重启）；企业策略禁用时的说明。
- 发行版导入：`wsl --import Kepcup <~/.kepcup/sandbox/wsl> rootfs.tar --version 2`；`wsl.conf`：`automount.enabled = false`、`interop.enabled = false`、`interop.appendWindowsPath = false`。
- `wsl` 沙箱后端（`sandbox/backend-wsl.ts`）：在发行版中以普通用户运行 srt 包装的命令；策略中的 Windows 路径转换为发行版中的挂载路径。
- 动态挂载：project 目录与授权目录用 `mount -t drvfs` 挂载到发行版内的固定位置（例如 `/mnt/kepcup/{hash}`），授权失效或解绑后卸载。
- workspace 放在发行版内部文件系统（`/home/kepcup/workspaces/{botId}/{conversationId}`），文件工具通过 `\\wsl$\Kepcup\...` 访问（**需验证**性能与可靠性，不可行时改为 drvfs 挂载 Windows 侧目录，并记录）。
- 本机端口：验证 WSL2 与 Windows 之间的端口转发（沙箱内启动的开发服务器能被 Bot 浏览器访问）。
- 工具链：发行版内的工具链（Python、Node）通过 P06 的机制安装到发行版中（目录新增 `linux-x64` / `linux-arm64` 的发行版内安装步骤）。
- 增强级后端：`backend-lima.ts`（macOS）、`backend-podman.ts`（Linux）；作为环境目录条目按需安装；技能 frontmatter 声明 `sandbox: enhanced` 时使用；未安装时技能为 `incompatible` 并提示可安装。
- 首次启动与设置页中的 Windows 沙箱准备入口（可跳过；跳过时保持逐条确认模式）。

不包含：

- WSL 容器（`wslc`）等替代方案（接口保持可替换即可）。

## 任务

1. **rootfs 构建**（`apps/desktop/scripts/build-wsl-rootfs`）：可重复构建；在 CI 中产出并缓存；记录版本与校验值。
2. **WSL 状态检测与启用**（`sandbox/wsl/setup.ts`）
   - 检测：`wsl --status`、`wsl --list --verbose` 的输出解析（输出为 UTF-16，注意编码）。
   - 启用：以管理员身份运行 `wsl --install --no-distribution`（经 UAC 提示），提示用户重启；重启后自动继续导入。
   - 失败与策略禁用：显示原因与帮助链接，保持逐条确认模式。
3. **导入与配置**：导入发行版；写入 `wsl.conf`；创建普通用户；`wsl --terminate` 使配置生效；验证 srt 可用。
4. **后端**：`probe()` 检测发行版状态；`exec()` 通过 `wsl -d Kepcup -u kepcup -- <srt 包装命令>` 执行；路径转换函数（Windows 路径 ↔ 发行版路径）集中在 `sandbox/wsl/paths.ts`。
5. **动态挂载**：挂载与卸载需要发行版内 root 权限，由后端以 `-u root` 执行固定的挂载脚本（参数经过严格校验，只接受已登记的 project 或授权目录）。
6. **增强级**：Lima 与 Podman 后端实现 `SandboxBackend`；文件系统规则与网络规则与默认级一致；安装走环境目录。
7. **界面**：Windows 首次启动与设置页中的沙箱准备向导（状态、启用、重启提示、导入进度）；设置页显示当前沙箱后端。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| srt 在精简发行版中运行（bubblewrap 在 WSL2 内核中可用） | 在发行版中运行 P02 的安全用例集 |
| drvfs 动态挂载单个目录 | 挂载 project 后读写正常；未挂载的 Windows 路径在发行版中不可见 |
| `\\wsl$` 访问 workspace 的性能 | 读写 1000 个小文件的耗时 |
| WSL2 端口转发 | 沙箱内 `http.server` 被 Windows 侧访问 |
| Windows 10（19041）上的完整流程 | 在 Windows 10 虚拟机中实测 |

## 测试要求

- 沙箱测试（Windows，自建运行器或手工执行，结果写入 PROGRESS.md）：P02 与 P03 的安全用例集在 WSL 后端上全部通过；C 盘未挂载的目录在沙箱内不可见；发行版中无法启动 Windows 程序（`cmd.exe` 不存在于 PATH 且 interop 关闭）。
- 集成：路径转换函数的单元测试；挂载参数校验（拒绝未登记的路径）。
- 增强级：在 macOS 与 Linux 上运行安全用例集。

## 验收标准

- [ ] Windows 10（19041+）与 Windows 11 上，完成一次管理员授权与重启后，Bot 执行命令不再需要逐条确认。
- [ ] 发行版中看不到未授权的 Windows 目录，无法启动 Windows 程序。
- [ ] project 与授权目录在发行版中可读写，授权撤销后不可访问。
- [ ] 安全用例集在 WSL 后端上全部通过。
- [ ] 跳过 WSL 准备时保持逐条确认模式，界面持续提示，并可随时从设置页开始准备。
- [ ] macOS 与 Linux 上可以按需安装增强沙箱，声明需要增强沙箱的技能可以运行。
- [ ] 需验证技术点全部有结论。

## 注意事项

- 所有 `wsl.exe` 调用集中在 `sandbox/wsl/` 中，处理好输出编码。
- 同一台机器上的所有 WSL2 发行版共享一个虚拟机，这是已知限制，在设置页的说明中写明。
