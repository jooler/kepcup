# P02 沙箱与编码工具

## 目标

Bot 获得文件与命令能力：在自己专属于该对话的 workspace 中读写文件、执行命令。macOS 与 Linux 上命令在 srt 沙箱中执行，文件工具经工具网关做路径检查，网络按 Profile 策略控制。

## 依赖

P01。

## 设计依据

- [design/06-isolation-and-storage.md](../../design/06-isolation-and-storage.md)（执行隔离、数据访问矩阵）
- [design/10-sandbox.md](../../design/10-sandbox.md)（srt、文件系统规则、网络、缓存、平台注意事项）
- [design/13-permissions.md](../../design/13-permissions.md#默认可访问范围)（默认可访问范围）
- [02-architecture.md](../02-architecture.md#工具网关)、[04-agent-runtime.md](../04-agent-runtime.md#工具目录)

## 范围

包含：

- workspace：路径 `bots/{botId}/workspaces/{conversationId}/`，首次执行时创建。
- 工具网关框架：执行身份校验、路径检查（`checkPath`）、审计日志。
- 文件工具：pi 的 read / write / edit / grep / find / ls，文件操作在核心服务内执行，经网关检查；本阶段可访问范围 = 当前 workspace（读写）+ 系统目录与工具链目录（只读）。
- 命令工具：bash，经网关调用沙箱执行。
- 沙箱接口与 srt 后端（macOS、Linux）；策略生成；可用性检测；沙箱违规记录。
- 随应用自带：`rg`（macOS、Linux）、`bwrap`、`socat`（Linux）；放在 `apps/desktop/resources/bin/{platform}-{arch}/`。
- 网络策略：Profile 中 `network_policy`（`none` / `allowlist` / `open`，默认 `open`），全模式拦截内网地址、链路本地地址、云服务器元数据接口、主机回环地址（本阶段没有 project，回环一律拦截）。
- 缓存环境变量指向应用缓存目录。
- `send_message` 支持 `attachment_paths`；`get_attachment` 对非文本附件复制到 workspace。
- 界面：执行步骤说明（例如“正在执行命令 npm test”）、可展开查看命令与输出摘要；设置页显示沙箱状态（可用 / 不可用及原因、修复提示）。
- Linux 用户命名空间检测与修复引导（显示需要执行的 sudo 命令）。

不包含：

- 授权与审批、逐条确认模式（P03）。本阶段沙箱不可用时 bash 工具返回 `SANDBOX_UNAVAILABLE`，**不执行命令**。
- project（P04）；Windows 的命令执行（P03 逐条确认模式、P12 WSL2）；增强沙箱（P12）。Windows 上本阶段只有文件工具可用。

## 任务

1. **路径与 workspace**：`infra/paths.ts` 增加 workspace 路径；`project/`、`sandbox/` 都通过它获取路径。
2. **工具网关**（`gateway/`）
   - `checkPath`：`realpath` 解析（目标不存在时解析最近的已存在父目录，再拼接剩余部分）；判断是否位于可访问范围；拒绝 `~/.kepcup` 中除当前 workspace 外的任何位置；拒绝敏感位置（`~/.ssh`、`~/.aws`、`~/.config/gh`、系统钥匙串目录、其他应用数据目录，清单放在 `sandbox/sensitive-paths.ts`，按平台区分）。
   - 本阶段 `needs_grant` 一律按 `forbidden` 处理并返回 `PATH_OUT_OF_SCOPE`（P03 接入审批）。
   - 审计：`exec`、`fs_write` 写入 `audit_log`。
3. **文件工具**：用 pi-coding-agent 的工具工厂创建工具，替换其文件操作接口为网关实现；工具结果按 `TOOL_OUTPUT_MAX_CHARS` 截断并包在 `<untrusted>` 中。
4. **沙箱**（`sandbox/`）
   - `backend-srt.ts`：以库方式调用 srt（`initialize` → 包装命令 → 执行 → 收集违规）；初始化失败返回不可用。
   - `policy.ts`：按 [design/10-sandbox.md](../../design/10-sandbox.md#文件系统规则) 生成策略（本阶段：workspace 读写；应用缓存与临时目录读写；系统目录与工具链目录只读；用户主目录其他位置禁止读取；敏感位置禁止；`~/.kepcup` 其他部分禁止）。
   - 网络：按 Profile 设置；`deniedResolvedAddresses` 加入 RFC1918、链路本地、`169.254.169.254` 等元数据地址、回环地址。
   - 环境变量：`npm_config_cache`、`PIP_CACHE_DIR`、`XDG_CACHE_HOME`、`CARGO_HOME` 指向 `~/.kepcup/cache/` 下对应目录；`HOME` 保持真实值（许多工具依赖）但主目录受读取限制。
   - `probe()`：检测 srt 依赖、Linux 用户命名空间（失败时返回 `fixHint`：需要执行的 sudo 命令）。
   - 命令超时（默认 10 分钟，可在调用参数中缩短）；`AbortSignal` 取消时结束进程树。
5. **bash 工具**：cwd 为 workspace；输出合并 stdout / stderr，截断；返回退出码与违规摘要（例如“被沙箱拦截：读取 ~/.ssh/id_rsa”）。
6. **附件**：`send_message.attachment_paths` 中的文件必须位于可访问范围内，复制到对话附件目录。
7. **生命周期**：删除对话时删除所有 Bot 在该对话的 workspace；删除 Bot 时删除其全部 workspace（已由 `bots/{id}/` 删除覆盖，补测试）。
8. **界面**：步骤说明文案；设置页“沙箱”分区；Linux 修复引导对话框（显示命令、复制按钮、“我已执行，重新检测”）。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| srt 作为库调用的 API（初始化、包装、违规记录） | 最小示例在 macOS 与 Linux 上执行 `cat ~/.ssh/xxx` 被拦截并报告违规 |
| srt 的网络拦截配置（`deniedResolvedAddresses` 等字段名） | 沙箱内 `curl http://192.168.1.1`、`curl http://169.254.169.254` 失败 |
| 自带的 bwrap、socat 在 Ubuntu 24.04、Debian 12、Fedora 最新版上可用 | 在这些系统（或容器 + 真机）上运行沙箱测试 |
| pi 编码工具的文件与命令接口可替换 | 工具的所有文件访问都经过网关（用计数器断言） |

## 测试要求

- 单元：`checkPath`（符号链接逃逸、`..`、不存在的目标、大小写不敏感文件系统）；`policy`（各路径类别）；输出截断。
- 沙箱测试（macOS、Linux）：安全用例集中本阶段的全部条目（[05-testing.md](../05-testing.md#安全用例集)）；网络三种模式的行为；命令超时与取消后无残留进程。
- 集成（模拟模型服务）：Bot 写一个脚本、执行、读取输出并回复；两个对话的 workspace 隔离；沙箱不可用时 bash 返回 `SANDBOX_UNAVAILABLE` 且没有任何进程被启动。
- 端到端：执行命令时状态行显示命令说明；设置页显示沙箱状态。

## 验收标准

勾选与证据以 [PROGRESS.md](../PROGRESS.md) P02 节为准（2026-09-30 审查修复 BR-P02-001～003 后同步；此前仅最小脚本证据，未在仓库内自动化钉死）。

- [x] macOS 与 Linux 上，Bot 能在 workspace 中创建、编辑、执行文件，并根据输出继续工作。
- [x] 沙箱内读取 `~/.ssh`、`~/.aws`、`~/.kepcup/main.db` 失败，违规记录在执行步骤中可见。
- [x] 沙箱内写入 workspace 以外的路径失败。
- [x] 文件工具访问 workspace 以外的路径返回 `PATH_OUT_OF_SCOPE`；指向外部的符号链接同样被拒绝。
- [x] 网络 `none` 模式下无法联网；`allowlist` 模式下只能访问列出的域名；任何模式下内网地址、元数据地址、回环地址都无法访问。
- [x] 同一 Bot 在两个对话中的 workspace 互相不可访问。
- [x] 沙箱不可用时命令不会执行，设置页显示原因；Linux 上显示修复命令，执行后重新检测变为可用。
- [x] 取消执行时正在运行的命令及其子进程全部结束。
- [x] npm / pip 的缓存写入 `~/.kepcup/cache/`，未写入用户真实缓存目录。
- [x] 删除对话后，该对话下所有 Bot 的 workspace 目录不存在。
- [x] 安全用例集全部通过（macOS、Linux 的 CI）。

## 注意事项

- 文件工具在核心服务内执行，**不经过沙箱**，因此网关的路径检查是它们唯一的防线，必须覆盖符号链接、硬链接到外部文件（按 inode 所在路径无法判断时，写入前检查目标的 realpath）。
- 不要为了让命令“能跑”而放宽策略；遇到必需的放宽，记录到 DEVIATIONS.md。
- srt 版本锁定；srt 的调用全部封装在 `backend-srt.ts` 中，其他模块不得直接依赖 srt。
