# P06 环境管理器

## 目标

Bot 可以申请安装宿主层环境（Python、Node、uv、git 命令行等），经用户确认后安装到应用私有目录，所有 Bot 共享，并在沙箱与逐条确认模式中可用；安装完成后作为事件通知申请的 Bot 继续工作。提供环境体检与清理。

## 依赖

P03。

## 设计依据

- [design/07-local-runtime.md](../../design/07-local-runtime.md)（环境配置分级、两层配置职责、环境清单与缓存、体检与降级）
- [design/10-sandbox.md](../../design/10-sandbox.md#git)（git 命令行）
- [03-data-model.md](../03-data-model.md)（env_installs）

## 范围

包含：

- 安装目录 `~/.kepcup/toolchains/{item}/{version}/`；env_installs 表记录。
- 可安装项目录（catalog）：`uv`、`python`（经 uv 安装）、`node`、`git`；每项在各平台的来源、版本、校验值、体积、安装步骤、验证命令。
- `request_environment` 工具与 `environment` 审批卡片（名称、版本、体积、来源、原因）。
- 下载（进度事件）、校验（sha256）、解压 / 安装、验证、失败回滚。
- 安装完成后以 `event` 触发（`event = 'environment_installed'`）投递到申请 Bot 的 Mailbox。安装通报是 Bot 内部事务（消息原则，见 design/01-conversation.md）：事件消息带 `internal: true`，只进 Bot 的上下文（续任务/调整方案），不作为对话内容展示；用户可见的面是审批卡片与设置页环境列表，系统发起流程的决定结果只留日志。
- 沙箱与逐条确认模式的 PATH 注入：已安装的工具链目录加入 `PATH`，工具链目录在沙箱策略中只读可见。
- workspace 层：Bot 在 workspace 中自行创建虚拟环境、安装依赖（受网络策略约束，无需确认）；pip / npm / uv 缓存指向 `~/.kepcup/cache/`。
- 环境体检：启动时与每天一次，检查已安装项是否完好、磁盘占用；设置页“环境”分区列出已安装项、占用、最近使用时间，支持删除。
- 系统提示词 `<workspace>` 段附带“可用工具链”列表。

不包含：

- 本地向量模型的下载（P07 通过本阶段的机制接入）。
- 增强沙箱的安装（P12 通过本阶段的机制接入）。

## 任务

1. **目录**（`env/catalog.ts`）
   - 条目结构：`{ item, version, displayName, platforms: { 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'linux-arm64' | 'win32-x64' | 'win32-arm64': { url, sha256, sizeBytes, kind: 'archive' | 'installer-script' | 'system' } }, verify: { command, expect } }`。
   - 版本与校验值写死在目录中（升级目录即代码变更）；来源只使用官方发布地址。
   - `python`：先确保 `uv`，再执行 `uv python install {version}`，设置 `UV_PYTHON_INSTALL_DIR` 指向工具链目录。
   - `git`：
     - Windows：官方 MinGit 便携包，解压到工具链目录。
     - macOS：不自行下载；检测到缺失时，审批通过后调用 `xcode-select --install` 打开系统安装器，由用户完成，完成后重新检测。
     - Linux：不自行下载；审批卡片中显示适合当前发行版的安装命令（读取 `/etc/os-release` 判断 apt / dnf / pacman），用户自行执行后点击“重新检测”。
   - 条目 `kind = 'system'` 表示由系统安装器或用户完成，环境管理器只负责检测。
2. **安装器**（`env/installer.ts`）：串行执行（同一时刻只安装一个）；下载到 `~/.kepcup/cache/downloads/`，校验通过后解压到临时目录，验证命令通过后原子重命名到目标目录；任何一步失败则清理并把状态记为 `failed`，审批卡片显示失败原因。
3. **`request_environment` 工具**：参数 `item`、`version?`、`reason`；已安装则直接返回路径；未知 `item` 返回 `ENV_ITEM_UNKNOWN` 并列出可安装项；否则发起审批（无人值守模式下自动批准），工具立即返回“已提交申请，安装完成后会通知你”，执行不必等待安装完成。
4. **事件触发**：安装成功或失败后，向申请的 Bot 在该对话中的 Mailbox 投递事件（正在执行则注入，否则新建执行，优先级 1）。
5. **PATH 注入**（`sandbox/policy.ts`、`sandbox/confirm-executor.ts`）：`env` 中 `PATH` 前置已安装工具链的 `bin` 目录；工具链目录加入 `readOnly`。
6. **体检**（`env/doctor.ts`）：验证命令逐项执行；异常项标记并在设置页提示“重新安装”。
7. **界面**：环境审批卡片（体积、来源、下载进度条）；设置页“环境”分区。

## 需验证技术点

| 技术点 | 验证方法 |
|---|---|
| uv 在六个平台上的独立安装与 `uv python install` 到自定义目录 | 三个平台实测；arm64 至少在 macOS 上实测 |
| 沙箱内通过 PATH 使用工具链目录中的 Python / Node | 沙箱测试中执行 `python3 --version`、`node --version` |
| MinGit 在逐条确认模式下可用 | Windows 上执行 `git status` |

## 测试要求

- 单元：目录条目校验（每个平台条目字段完整）；校验失败的处理。
- 集成（下载使用本地模拟文件服务器）：审批 → 下载 → 校验 → 安装 → 事件投递；校验值不匹配时安装失败且不留残留目录；重复申请已安装项直接返回；未知项的返回。
- 沙箱测试：安装后沙箱内可执行；工具链目录在沙箱内不可写。
- 端到端：审批卡片显示体积与进度；设置页列出与删除。
- 手工：在三个平台上真实安装 uv + Python、Node；Windows 安装 MinGit；macOS 与 Linux 的 git 缺失引导。

## 验收标准

- [x] Bot 申请安装 Python 后，对话中出现带体积与来源的审批卡片；批准后显示进度，完成后 Bot 被通知并继续工作。（PROGRESS P06：集成审批→安装→事件投递 + python-via-uv 链式安装；真实三平台安装列跨系统清单）
- [x] 安装位置在 `~/.kepcup/toolchains/`，未修改系统环境（系统 PATH、全局包目录）。（集成断言落位与 downloads 清空；uv 调用经环境变量隔离）
- [x] 沙箱内与逐条确认模式下都能使用已安装的工具链；工具链目录在沙箱内不可写。（toolchain-sandbox 集成 2 用例）
- [x] 下载内容校验失败时安装失败，不留残留。（集成 checksum mismatch 用例）
- [x] Bot 在 workspace 中创建虚拟环境、安装依赖无需确认，缓存写入 `~/.kepcup/cache/`。（P02 机制回归 + policy 单元断言 UV_CACHE_DIR 等）
- [x] git 命令行在三个平台上都有可用的获取途径（Windows 自动安装；macOS、Linux 引导）。（catalog 单元 + macAction/linuxGuide 实现；真机引导列跨系统清单）
- [x] 设置页可以查看、删除已安装项；体检能发现被破坏的安装。（集成 settings operations + e2e environment.spec）
- [x] 本阶段测试全部通过（迭代中跑定向测试，收口跑一次全量，见 [05-testing.md](../05-testing.md#开发中如何跑测试)）。（`pnpm test` 248 连续 3 轮全绿；`pnpm test:e2e` 17 全绿；lint/build 干净）

## 注意事项

- 安装过程不需要、也不得请求管理员权限（macOS 的 `xcode-select` 由系统自己处理授权）。
- 目录中的下载地址与校验值必须来自官方发布页；不要使用镜像站。
