# 跨系统人工验收事务（CI / 真机）

这些事项在 macOS（arm64）本机开发时无法覆盖，统一推迟到这里。每完成一项：
把 `[ ]` 改为 `[x]` 并附日期与结果，同时把结论补进 `docs/dev/PROGRESS.md` 对应阶段的验收记录。
不阻塞已在本机完成的阶段验收（P02 的「待验收」以本机证据为准）。

## 按平台分组的执行清单（迁移到对应平台做测试与适配时用）

> 本节是下方各阶段小节的逐条索引（原文保持不动，销项时回到对应阶段小节勾选原条目）。按主要执行平台归组；一条涉及多平台时归入其主要执行平台并在括注说明其余平台，无法归单组的放「跨平台」尾组。

### Windows 真机

- [ ] （P02）Windows 沙箱降级链路：sandbox-isolation 正确 describe.skip、文件工具集成用例返回 SANDBOX_UNAVAILABLE、设置页沙箱状态显示「不可用」且给出原因 — 详见下文 P02 小节对应条目
- [ ] （P03）逐条确认模式 PowerShell 端到端：pwsh 优先退回 Windows PowerShell、单引号转义、白名单免确认（dir/type/Get-ChildItem 等）、`C:\` 越界检查 — 详见下文 P03 小节对应条目
- [ ] （P03）`resolveWindowsShell` 的 where 探测：PATH 无 pwsh 时退回 powershell.exe（5.1） — 详见下文 P03 小节对应条目
- [ ] （P03）托盘无人值守切换与系统通知点击跳转在 Windows 的行为（通知中心聚合、点击激活窗口） — 详见下文 P03 小节对应条目
- [ ] （P04）Windows project 全链路：`C:\` 绑定与大小写不敏感、write/edit 自动租约、`.env` 保护、检查点系统 git、`git_remote` 审批后执行 — 详见下文 P04 小节对应条目
- [ ] （P04）本机端口转发（WSL2 与 Windows 主机之间）随 P12 落地验证；DEV-005/DEV-006 人工决定后销项 — 详见下文 P04 小节对应条目
- [ ] （P05）Windows 群聊端到端：建群/@ 顺序响应/send_message 连锁/成员移除级联（路径分隔符形态、清理）/群聊 project 写入租约 — 详见下文 P05 小节对应条目
- [ ] （P05）Windows 确认模式群聊轮次：成员移除时等待确认的 run 取消、pending 审批按「Bot + 对话」取消 — 详见下文 P05 小节对应条目
- [ ] （P06）MinGit 2.56.0 经 bsdtar（`tar -xf`）解压安装，`cmd`+`mingw64/bin` 注入 PATH 后确认模式与沙箱内 `git status` 可用 — 详见下文 P06 小节对应条目
- [ ] （P06）Windows runner e2e（`KEPCUP_ENV_CATALOG_FILE` 注入 + 本地文件服务器）与 `primaryExecutable`/`resolveBinDir` 的 `.exe` 形态、MinGit 布局断言（runner 可先行，真机复核） — 详见下文 P06 小节对应条目
- [ ] （P08）Windows 无 bash：shell 技能 `bash -n` 检查 fail-closed 属正确行为（P12 后 WSL2 复验）；`chmod 0444` 在 NTFS 被忽略后网关与沙箱仍阻断写入 — 详见下文 P08 小节对应条目
- [ ] （P08）Windows 工具链 PATH 前置后 `python -m py_compile` 与 `node --check` 在沙箱/逐条确认模式内可用 — 详见下文 P08 小节对应条目
- [ ] （P09）Windows 沙箱内原生 curl 可用性（PATH 注入后）；不可用时 URL 入库 fail-closed 报 `SANDBOX_UNAVAILABLE`（随 P12） — 详见下文 P09 小节对应条目
- [ ] （P11）分区目录布局：Windows 路径长度限制对 `Partitions/bot-{ulid}` 的影响、删 Bot 后 rmSync 在文件占用锁下的重试语义（macOS 已验证目录删除） — 详见下文 P11 小节对应条目
- [ ] （P12）WSL 真机全套：UTF-16 抽查/UAC/重启续导/导入与 wsl.conf 生效 — 详见下文 P12 小节对应条目
- [ ] （P12）安全用例集在 WSL 后端全绿：sandbox-isolation + P03 用例、C 盘未挂载目录不可见、interop 关无 cmd.exe — 详见下文 P12 小节对应条目
- [ ] （P12）drvfs 动态挂载真机：挂载读写/未挂载不可见/撤销 deny+结束即清理/ro↔rw remount busy 语义/`\\wsl$` 拒挂 — 详见下文 P12 小节对应条目
- [ ] （P12）workspace 落位裁决真机输入：`\\wsl$` 1000 小文件耗时实测、与 drvfs 对比与可靠性，显著更优则切 `distroWorkspacePath` — 详见下文 P12 小节对应条目
- [ ] （P12）WSL2 端口转发：发行版 http.server 被 Windows 侧访问、沙箱 curl 发行版回环 dev server、mirrored 模式复核 — 详见下文 P12 小节对应条目
- [ ] （P12）Windows 10（19041）完整流程：管理员授权 → 重启 → 导入 → 沙箱执行（Win10 的 wsl.exe 输出形态差异） — 详见下文 P12 小节对应条目
- [ ] （P12）发行版内工具链安装真机：node tar 流入+verify、uv python install、prefix 注入后 `node --version`、`environment.remove` 删除 — 详见下文 P12 小节对应条目
- [ ] （P12）准备向导真机走查：UAC 弹窗/重启续导链路/导入进度轮询/失败帮助链接/状态跨重启/设置页 WSL2+enhanced 行 — 详见下文 P12 小节对应条目
- [ ] （P13）Windows NSIS + 代码签名：x64/arm64 runner 构建、证书/Azure Trusted Signing 注入后安装无警告、安装/卸载/升级真机走查 — 详见下文 P13 小节对应条目

小计：23 条。

### Linux（含 CI runner）

- [ ] （P00）Ubuntu 无桌面/无 Secret Service：keystore 探测失败进 locked（或 KEYSTORE_UNAVAILABLE），不回退内核 keyring、数据库文件不被修改 — 详见下文 P00 遗留小节对应条目
- [ ] （P02）Ubuntu 24.04 bwrap 路径沙箱 8 用例全绿（文件逃逸/写越界/网络三模式/超时取消无残留/npm cache 用例无 npm 自动跳过） — 详见下文 P02 小节对应条目
- [ ] （P02）Linux e2e（xvfb）全绿：`sandbox.spec.ts` 沙箱状态「可用」+「正在执行命令 …」状态行 — 详见下文 P02 小节对应条目
- [ ] （P02）自带 rg 与系统 bwrap+socat 在 Ubuntu 24.04/Debian 12/Fedora 真机或容器可用（DEV-003 决定输入；Debian/Fedora CI 未覆盖，需容器或真机） — 详见下文 P02 小节对应条目
- [ ] （P02）DEV-003 人工决定：Linux bwrap/socat 取「系统包+探测提示」「musl 静态自构建」还是「包管理引导」 — 详见下文 P02 小节对应条目
- [ ] （P03）Linux CI 全绿：approvals 集成（真实沙箱 request_unsandboxed/确认模式/白名单）+ e2e 3 用例（卡片键盘/pending 徽标/无人值守横幅汇总） — 详见下文 P03 小节对应条目
- [ ] （P03）沙箱不可用的实际 Linux 真机复核（未装 bwrap/socat 或 userns 受限）：横幅原因文案、白名单免确认、命令审批链路 — 详见下文 P03 小节对应条目
- [ ] （P04）Linux CI 全绿：projects 12 集成（bwrap `--unshare-net` 下 loopback 需同一命令内完成）+ e2e 2 用例 — 详见下文 P04 小节对应条目
- [ ] （P04）确认沙箱内 `PYTHONPYCACHEPREFIX` 重定向不干扰 venv/conda 的 python — 详见下文 P04 小节对应条目
- [ ] （P05）Linux CI 全绿：group-chat 16 集成（triage 超时用例靠 `KEPCUP_TRIAGE_TIMEOUT_MS`）+ e2e 2 用例 — 详见下文 P05 小节对应条目
- [ ] （P06）Linux 缺 git 引导：审批卡片按 `/etc/os-release` 出发行版命令、用户执行后「重新检测」生效、`detectSystemItem` 正确报「未检测到」 — 详见下文 P06 小节对应条目
- [ ] （P06）Linux CI 全绿：environment 9 集成（GNU tar 解压）+ toolchain-sandbox 2 沙箱用例（userns 解除后） — 详见下文 P06 小节对应条目
- [ ] （P07）Linux CI 全绿：memory* 单元 5+集成 4+安全 1 与既有 17 个 e2e 用例 — 详见下文 P07 小节对应条目
- [ ] （P08）Linux CI 全绿：skills* 单元 3+集成 2（authoring 依赖 bwrap 沙箱与 bash） — 详见下文 P08 小节对应条目
- [ ] （P09）Linux CI 全绿：wiki* 单元 1+集成 2（bwrap+本机回环端口）与 memory-reflection 的 P09 断言 — 详见下文 P09 小节对应条目
- [ ] （P10）Linux CI 全绿：schedule* 单元 2+集成 1（无沙箱依赖） — 详见下文 P10 小节对应条目
- [ ] （P12）Podman（Linux 增强级）真机：rootless 安装/subuid/`podman import`/per-command 绑定读写只读/安全用例集/userns+AppArmor 与 bwrap 共存 — 详见下文 P12 小节对应条目
- [ ] （P13）Linux AppImage + deb：x64/arm64 runner 构建、deb 安装卸载、AppImage 直启、XDG autostart 与 deb 配合真机走查 — 详见下文 P13 小节对应条目

小计：18 条。

### macOS 真机（人工走查）

- [ ] （P03）系统通知 OS 级验证：窗口非前台收到通知、点击打开对应对话（macOS 为主，Linux 桌面环境同法走查） — 详见下文 P03 小节对应条目
- [ ] （P06）macOS 缺 git 引导真机：`request_environment git` → 批准 → `xcode-select --install` 安装器弹窗 → 「重新检测」显示「系统已提供」+ `environment_installed` 通知 — 详见下文 P06 小节对应条目
- [ ] （P10）真实休眠唤醒 OS 级行为：合盖跨过触发时刻后 resume 事件真实到达、late_by 补触发不重复、关闭期间错过的启动补触发（Windows/Linux 真机随迁） — 详见下文 P10 小节对应条目
- [ ] （P10）powerMonitor 桌面端到端：三平台 e2e 与真实休眠场景手工验证（含 macOS runner e2e 全绿确认：24 旧 spec + P10-B 新增） — 详见下文 P10 小节对应条目
- [ ] （P12）Lima（macOS 增强级）真机：`brew install lima` → create/start → catalog 检测可用 → 增强技能路由 Lima 后端 → 安全用例集在 Lima 运行 — 详见下文 P12 小节对应条目
- [ ] （P13）macOS 签名与公证：Developer ID + notarytool 机密注入后重打包，安装无「未知开发者」警告（本机现存产物为 adhoc 未签名，如实不伪造） — 详见下文 P13 小节对应条目

小计：6 条。

### 真实外部服务（真实模型、公网站点、真实网络）

- [ ] （P02）手工冒烟（真实模型，任选一台本机）：「写脚本执行并把输出发我」闭环 + `attachment_paths` 把 workspace 文件作为附件发出 — 详见下文 P02 小节对应条目
- [ ] （P02）手工冒烟（真实模型，Windows 可选）：文件工具可用、bash 返回 SANDBOX_UNAVAILABLE 且设置页显示原因 — 详见下文 P02 小节对应条目
- [ ] （P07）真实模型 20 条标注样例抽查：反思输出符合「记什么、不记什么」（需真实模型 key） — 详见下文 P07 小节对应条目
- [ ] （P07）厂商向量接口真实联通：OpenAI 兼容 `/v1/embeddings` 的 dim 探测/建表/写入检索/余弦去重（>0.92）/`memory_vec_rebuild` 实测 — 详见下文 P07 小节对应条目
- [ ] （P08）官方技能仓库导入实测：Anthropic 与 OpenAI 官方仓库各导入 2 个并运行，记录 compatible/partial/incompatible 与脚本沙箱执行 — 详见下文 P08 小节对应条目
- [ ] （P08）真实 HTTPS 克隆三平台各一次：凭据/代理/私仓 401 场景（生产仅放行 https:// 远程） — 详见下文 P08 小节对应条目
- [ ] （P09）真实模型抽查 Wiki 不含用户个人信息：含个人信息资料走全流程，页面与 log.md 不含个人信息、维护 loop 不执行资料指令 — 详见下文 P09 小节对应条目
- [ ] （P09）大规模真实资料入库压测与个人信息抽查：网页批量入库/大型文档，记录维护 loop 页面质量 — 详见下文 P09 小节对应条目
- [ ] （P13）自动更新端到端：真实发布仓库 + GH_TOKEN（owner/repo 现为占位），三平台下载/校验/重启安装、在途执行门控等待/确认、macOS zip 增量 — 详见下文 P13 小节对应条目

小计：9 条。

### CI 基建

- [ ] （前置）CI 首跑三平台（macOS arm64/Ubuntu 24.04/Windows）全绿，失败项按阶段归入下方清单（销 P00 验收记录遗留勾选） — 详见下文「前置：CI 首次运行」小节对应条目
- [ ] （P02）macOS runner e2e 全绿（sandbox.spec 沙箱「可用」） — 详见下文 P02 小节对应条目
- [ ] （P04）macOS runner e2e 全绿（projects 2 用例） — 详见下文 P04 小节对应条目
- [ ] （P05）macOS runner e2e 全绿（group-chat 2 用例） — 详见下文 P05 小节对应条目
- [ ] （P06）macOS runner e2e 全绿（environment 1 用例） — 详见下文 P06 小节对应条目
- [ ] （P07）sqlite-vec 0.1.9 平台覆盖随 CI 首跑：Ubuntu x64/arm64 与 Windows x64 加载检索、Windows arm64 正确退化为全文检索不崩溃 — 详见下文 P07 小节对应条目
- [ ] （P07）Intl.Segmenter 中文分词平台一致性：memory-store 中文召回用例在 Ubuntu/Windows 重跑，召回不劣于 macOS — 详见下文 P07 小节对应条目
- [ ] （P07）macOS runner e2e 全绿（既有 17 spec） — 详见下文 P07 小节对应条目
- [ ] （P07）P07-B 界面 4 用例 + 既有 spec 随 CI 在 Ubuntu/Windows 首跑（Intl/ICU 与本地日期分组两平台一致） — 详见下文 P07 小节对应条目
- [ ] （P08）macOS runner e2e 全绿（skills 2 用例 + 既有 21 spec） — 详见下文 P08 小节对应条目
- [ ] （P09）es-git wiki 仓库行为一致性随 CI 首跑：revwalk/rollback/维护提交在 NTFS/ext4 的路径大小写与文件锁 — 详见下文 P09 小节对应条目
- [ ] （P09）FTS5 snippet/bm25 平台一致性：wiki_fts 用例在 Ubuntu/Windows 随 CI 首跑 — 详见下文 P09 小节对应条目
- [ ] （P09）macOS runner e2e 全绿（wiki.spec + 既有 23，共 24） — 详见下文 P09 小节对应条目
- [ ] （P10）Intl 时区数据一致性：schedule-guard/schedule-cron 的时区用例在 Ubuntu/Windows 随 CI 首跑 — 详见下文 P10 小节对应条目
- [ ] （P11）网络拦截 OS/Chromium 矩阵 Windows/Linux 复验 + DNS 解析器差异与 measure-browser-dns.mjs 复跑（macOS 已覆盖，公网放行由判定函数覆盖） — 详见下文 P11 小节对应条目
- [ ] （P11）CDP `webContents.debugger` 三平台 Chromium 抽验：DOM.resolveNode/callFunctionOn/带 text 键需 `type:"keyDown"` — 详见下文 P11 小节对应条目
- [ ] （P12）rootfs 构建流水线接入 CI：debian:12-slim 产 rootfs.tar+manifest、钉基础镜像 digest、`kepcup-sandbox --selfcheck` 通过 — 详见下文 P12 小节对应条目
- [ ] （P13）CI release 矩阵首跑：rootfs job + 6 组平台×架构全绿、arm64 runner 可用性、三平台原生模块 rebuild — 详见下文 P13 小节对应条目

小计：18 条。

### 跨平台

- [ ] （P01）Ubuntu（xvfb-run）与 Windows 的 e2e 通过（直聊闭环、撤回/编辑、队列重启保留） — 详见下文 P01 遗留小节对应条目
- [ ] （P01）Windows `provider_concurrency` 排队用例 + Linux 原生模块加载，`pnpm test` 三平台全绿 — 详见下文 P01 遗留小节对应条目
- [ ] （P02）DEV-001（测试用 file keystore）/DEV-002（pi CredentialStore）人工确认或否决 — 详见下文 P02 小节对应条目
- [ ] （P06）三平台真机安装 uv + Python：`UV_PYTHON_INSTALL_DIR` 落位、`uv python find` 可用、沙箱内 `python3 --version` 走工具链（macOS arm64 已完成） — 详见下文 P06 小节对应条目
- [ ] （P06）三平台真机安装 Node（v24.21.0 官方 dist 包）：落位 `toolchains/node/{version}/`、沙箱内 `node --version` 可用 — 详见下文 P06 小节对应条目
- [ ] （P06）沙箱内 `UV_CACHE_DIR` 与 `uv pip install`（workspace venv）三平台缓存落位复核 — 详见下文 P06 小节对应条目
- [ ] （P07）本地向量模型三平台实测：选定库加载推理、体积 ≤200MB、CPU ≤50ms，catalog 钉 url/sha256 并清 `downloadPending` — 详见下文 P07 小节对应条目
- [ ] （P10）Windows/Linux 定时器精度与长延迟钳制：超远期分步重臂无偏差、睡眠只靠 power.resume 补触发、省电策略挂起下触发可达性 — 详见下文 P10 小节对应条目
- [ ] （P11）隐藏 `WebContentsView` 渲染与截图跨平台复验：Windows GPU 节流路径、Linux 无 GPU software rendering、高 DPR（3×/4×）下截图上限够用 — 详见下文 P11 小节对应条目
- [ ] （P11）AX 树平台差异：大型网站定标跨平台复核（三大型网站公网实测未做）、UIA/AT-SPI 的 role/name 差异、Linux 无 AT-SPI 会话可用性 — 详见下文 P11 小节对应条目
- [ ] （P11）下载行为三平台：文件名清洗保留字符集、重复命名规避、默认打开方式关联 — 详见下文 P11 小节对应条目
- [ ] （P12）catalog lima/podman 条目引导链路真机：guide 文案 → 安装 → 「重新检测」→ waiter 收到 `environment_installed` — 详见下文 P12 小节对应条目
- [ ] （P12）增强级界面安装侧翻转真机：设置页 enhanced 翻「可用」、向导徽标翻转、技能 incompatible 翻 active 刷新 — 详见下文 P12 小节对应条目
- [ ] （P13）三平台干净机（虚拟机）安装走查：安装 → 首启 → 引导 → 对话 → 执行命令 → 卸载（macOS 首启框架层弹窗需人工确认并记录条目） — 详见下文 P13 小节对应条目
- [ ] （P13）引导真机走查：五步向导在打包 app 完整走查（Windows WSL2 衔接/Linux sudo 修复命令随迁）+ 新用户 3 分钟真机计时 — 详见下文 P13 小节对应条目
- [ ] （P13）诊断页真机条目：system keystore/KEYSTORE_UNAVAILABLE 场景、Linux Secret Service 缺席、「在文件管理器中打开」三平台行为 — 详见下文 P13 小节对应条目
- [ ] （P13）开机自启真机验证：macOS 签名后 setLoginItemSettings、Windows Run 注册表键、Linux XDG autostart，注销重登 + 设置页开关一致性 — 详见下文 P13 小节对应条目
- [ ] （P13）中端机性能口径：冷启动 ≤3s 的中端机实测（本机 M1 Max 已测 1417ms）、输入无可感知延迟人工验证、空闲 ≤300MB 复核 — 详见下文 P13 小节对应条目

小计：18 条。

合计 92 条，与下方各小节一一对应（前置 1、P00 1、P01 2、P02 9、P03 6、P04 5、P05 4、P06 9、P07 8、P08 6、P09 7、P10 5、P11 6、P12 13、P13 10）；分组：Windows 真机 23、Linux（含 CI runner）18、macOS 真机 6、真实外部服务 9、CI 基建 18、跨平台 18。

## 前置：CI 首次运行

- [ ] 推送到托管平台后，`.github/workflows/ci.yml` 三平台（macOS arm64 / Ubuntu 24.04 / Windows）全绿；失败项按阶段归入下方清单。（P00 验收记录中遗留的「CI 在三个平台通过」勾选项在此销项）

## P00 遗留

- [ ] Ubuntu 无桌面环境 / 无 Secret Service 时，keystore 探测失败并进入 `locked`（或报 `KEYSTORE_UNAVAILABLE`），不回退内核 keyring，数据库文件不被修改。（代码已固定 `linux: { store: 'secret-service' }`，见 P00 验收记录）

## P01 遗留

- [ ] Ubuntu（`xvfb-run`）与 Windows 的 e2e 通过（直接聊闭环、撤回/编辑、队列重启保留等）。
- [ ] Windows 上 `provider_concurrency` 并发排队用例与 Linux 上的原生模块加载无回归（`pnpm test` 三平台全绿）。

## P02（2026-09-30 完成于 macOS，以下为跨系统项）

- [ ] Ubuntu 24.04 沙箱测试全绿：CI 已含 `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` 与 `apt-get install bubblewrap socat`（ci.yml test job）；确认 `packages/core/test/sandbox/sandbox-isolation.test.ts` 8 个用例在 bwrap 路径下通过（文件逃逸、写越界、网络三模式、超时/取消无残留、npm cache 实测——注意该用例在无 npm 环境自动跳过）。
- [ ] Linux e2e（xvfb）全绿，其中 `sandbox.spec.ts` 设置页沙箱状态应显示「可用」、状态行出现「正在执行命令 …」。
- [ ] Windows：`sandbox-isolation.test.ts` 正确跳过（describe.skip）；集成测试 `returns SANDBOX_UNAVAILABLE...` 等文件工具用例通过；e2e 设置页沙箱状态显示「不可用」且给出原因（不阻塞 P02 验收，Windows 命令执行是 P12）。
- [ ] macOS runner e2e 全绿（`sandbox.spec.ts` 沙箱状态「可用」）。
- [ ] 真机/容器验证自带的 rg 与系统 bwrap + socat 在 Ubuntu 24.04、Debian 12、Fedora 最新版上可用（P02 需验证技术点：在这三个系统上跑沙箱测试；Debian 12 / Fedora 目前 CI 未覆盖，需容器或真机）。结果作为 DEV-003 的决定输入。
- [ ] DEV-003 人工决定：Linux 的 bwrap/socat 采用「系统包 + 探测提示」（现状）、「musl 静态自构建」还是「包管理引导」，见 docs/dev/DEVIATIONS.md。
- [ ] DEV-001（测试用 file keystore）、DEV-002（pi CredentialStore）人工确认或否决。
- [ ] 手工冒烟（真实模型厂商，任选一台本机可完成）：给 Bot 发「写一个脚本执行并把输出发我」→ Bot 在 workspace 写文件、bash 执行、依据输出回复；再验证一次带 `attachment_paths` 的 send_message（让 Bot 把 workspace 文件作为附件发出）。结果补进 P02 验收记录。
- [ ] 手工冒烟（真实模型，Windows 可选）：确认 Windows 上文件工具可用、bash 返回 `SANDBOX_UNAVAILABLE` 且设置页显示原因。

## P03（2026-09-30 完成于 macOS，以下为跨系统项）

- [ ] Windows 逐条确认模式端到端：`sandbox/confirm-executor.ts` 的 PowerShell 执行（pwsh 优先、退回 Windows PowerShell；单引号转义；环境变量白名单）在真机上验证——命令确认后落地执行、白名单 `dir` / `type` / `Get-ChildItem` / `Get-Content` / `Select-String` / `Get-Location` 与 `git status` 等免确认、带绝对路径参数的越界检查（`C:\` 路径形态）。
- [ ] Windows 上 `resolveWindowsShell` 的 `where` 探测在 PATH 无 pwsh 时正确退回 `powershell.exe`（Windows PowerShell 5.1）。
- [ ] Windows 托盘菜单的无人值守切换（`platform.unattended` 事件 + `unattended.disable` 平台 RPC）与系统通知点击跳转（`Notification` + `navigate-conversation` ipc）在 Windows 的行为（通知中心聚合、点击激活窗口）。
- [ ] Linux CI 全绿确认：`approvals.test.ts`（含真实沙箱下 `request_unsandboxed`、确认模式、白名单）与 e2e `approvals.spec.ts` 3 个用例（卡片键盘操作、pending 徽标、无人值守横幅与汇总）在 Ubuntu（xvfb）通过。
- [ ] macOS/Linux 系统通知 OS 级验证：窗口非前台时收到通知、点击打开对应对话（Electron Notification 依赖系统通知中心，CI 内不稳定，需人工在桌面环境点一遍）。
- [ ] 逐条确认模式在真机沙箱不可用机器上的表现复核（Linux 未装 bwrap/socat 或 userns 受限的实际机器）：横幅原因文案、白名单免确认、命令审批链路。

## P04（2026-09-30 完成于 macOS，以下为跨系统项）

- [ ] Windows 上 project 经文件工具与逐条确认模式使用（不做 WSL 挂载，P12）：绑定目录（`C:\` 路径形态、大小写不敏感比较）、write/edit 自动租约、`.env` 保护规则、检查点快照（系统 git CLI 在 PowerShell 环境可用）、`git_remote` 审批后执行。
- [ ] Linux CI 全绿确认：projects.test.ts 12 个集成用例（真实沙箱：租约串行、本机端口 allowLocalBinding 在 bwrap `--unshare-net` 下的行为——沙箱内 loopback 是独立 netns，`python3 -m http.server & curl` 需在同一命令内完成；确认用例在 Linux 路径下仍通过或按此调整）与 e2e `projects.spec.ts` 2 个用例在 Ubuntu（xvfb）通过。
- [ ] Linux 上确认沙箱内 `PYTHONPYCACHEPREFIX` 重定向不干扰 venv/conda 的 python（`$HOME` deny 与系统 python 的 pyc 重定向仅针对 macOS 系统框架 Python；Linux 的 venv python 自带可写 pycache，应不受影响）。
- [ ] 本机端口转发（Windows WSL2 与 Windows 主机之间，design/10"网络"）在 P12 WSL2 落地时验证；DEV-005（srt 端口范围不强制）与 DEV-006（es-git print 缺陷 → 检查点 diff 用系统 git）人工决定后销项。
- [ ] macOS runner e2e 全绿确认（`projects.spec.ts` 2 个用例，CI 首次运行时）。

## P05（2026-09-30 完成于 macOS，以下为跨系统项）

- [ ] Windows 上群聊端到端：建群、@ 判断与顺序响应、`send_message` 连锁（chains 表、层数/预算）、成员移除级联（workspace 删除的路径分隔符形态、per-conversation grants/approvals 清理）、群聊中 project 写入租约（`C:\` 路径形态下 `canonicalPath` 冲突判定）。
- [ ] Windows 上文件工具 + 逐条确认模式下的群聊轮次：成员移除时正在执行（等待确认）的 run 取消、pending 审批按「Bot + 对话」取消（`cancelPendingForBotInConversation` 的 SQL 在 Windows 无差异，属常规回归确认）。
- [ ] Linux CI 全绿确认：group-chat.test.ts 16 个集成用例（triage 超时用例依赖 `KEPCUP_TRIAGE_TIMEOUT_MS`，与平台无关）与 e2e `group-chat.spec.ts` 2 个用例在 Ubuntu（xvfb）通过。
- [ ] macOS runner e2e 全绿确认（`group-chat.spec.ts` 2 个用例，CI 首次运行时）。

## P06（2026-09-30 完成于 macOS，以下为跨系统项）

- [ ] 三个平台真机安装 uv + Python（任务书「手工」项）：uv 从官方 release 下载安装、`uv python install`（`UV_PYTHON_INSTALL_DIR` 指向 `~/.kepcup/toolchains/python/{version}`）落位、`uv python find` 可用、沙箱/逐条确认模式内 `python3 --version` 走工具链。macOS arm64 已于 2026-09-30 完成（uv 0.12.21 + Python 3.12.11，见 PROGRESS P06 技术点结论），Windows/Linux 待真机。
- [ ] 三个平台真机安装 Node（v24.21.0 官方 dist 压缩包）：解压落位 `toolchains/node/{version}/`、沙箱内 `node --version` 可用（沙箱注入测试已覆盖机制，真机待验）。
- [ ] Windows：MinGit 2.56.0（64-bit / arm64 zip）经 bsdtar（`tar -xf`）解压安装，`{root}/cmd` + `{root}/mingw64/bin` 注入 PATH，逐条确认模式与沙箱（P12 后）内 `git status` 可用。
- [ ] macOS 缺 git 引导真机走一遍（机制已于 BR-P06-001 修复落地并有注入测试）：`request_environment git` → 审批批准 → `xcode-select --install` 打开系统安装器（真机确认弹窗行为与非零退出不打断）→ 用户完成安装 → 设置页「重新检测」显示「系统已提供」，Bot 收到 `environment_installed` 通知。
- [ ] Linux 缺 git 引导：审批卡片显示发行版安装命令（读 `/etc/os-release` 判 apt/dnf/pacman），用户执行后「重新检测」生效；`detectSystemItem` 在无 git 机器上正确报「未检测到」。
- [ ] Windows 上 `KEPCUP_ENV_CATALOG_FILE` 注入 + 本地文件服务器的 e2e（`environment.spec.ts`）在 Windows runner 通过；`primaryExecutable`/`resolveBinDir` 的 `.exe` 形态与 MinGit `cmd`/`mingw64` 布局断言。
- [ ] Linux CI 全绿确认：environment.test.ts 9 个集成用例（下载/校验/解压在 Linux 用 GNU tar；沙箱用例走 bwrap）与 toolchain-sandbox.test.ts 2 个沙箱用例在 Ubuntu（userns 解除后）通过。
- [ ] macOS runner e2e 全绿确认（`environment.spec.ts` 1 个用例，CI 首次运行时）。
- [ ] 沙箱内 UV_CACHE_DIR（`~/.kepcup/cache/uv`）与 `uv pip install`（workspace venv 场景）在三个平台的缓存落位复核（P07 本地向量模型接入时的前置检查）。

## P07（2026-10-01 核心领域层完成于 macOS，界面与 e2e 留 P07-B；以下为跨系统项）

- [ ] **真实模型 20 条标注样例抽查**（任务书验收标准第 2 条）：配一个真实厂商（含真实向量接口或本地模型，见 DEV-007），对 20 条标注样例核对反思输出是否符合"记什么、不记什么"；记录结果补进 PROGRESS.md P07 小节。需真实模型 key，本机未执行。
- [ ] **本地向量模型三平台实测**（DEV-007 已落实 2026-10-04、默认模型 2026-10-07 起 = jina-embeddings-v2-base-zh q8，运行库=onnxruntime-node 1.30.0，见 DEVIATIONS）：macOS arm64 已实测（模型约 163MB + 运行库约 114MB、短句 warm 约 4ms CPU EP / 约 26ms CoreML EP、1024 token 约 367ms、会话创建约 170ms-2s、中英及混说语义方向正确：同义 0.65 / 跨语言 0.68 / 无关 0.04）；剩余 **Windows（DirectML 路径 + CPU 回退）与 Linux（纯 CPU）实测**——下载/安装/推理全流程 + 耗时记录；下载源 npmmirror/modelscope 在目标网络环境的可达性复核。
- [ ] **厂商向量接口真实联通**：`VendorEmbedder`（OpenAI 兼容 `/v1/embeddings`）对真实厂商（如 OpenAI text-embedding-3-small）跑通：dim 探测、memory_vec 建表、写入/检索、余弦去重（>0.92）实测；更换来源后 `memory_vec_rebuild` 任务实测。本机仅有 mock，未打真实接口。
- [ ] **sqlite-vec 0.1.9 平台覆盖**：macOS arm64 已验证（加密库下 vec0 建表/写入/KNN/持久化，见 PROGRESS P07）；Ubuntu（x64/arm64）与 Windows（x64）随 CI 首跑确认加载与检索；**Windows arm64 上游不发布 sqlite-vec 扩展**——确认该平台检索正确退化为全文检索（embedding.status 显示未就绪原因）且不崩溃。
- [ ] **Intl.Segmenter 中文分词的平台一致性**：50 条中文样例召回验证在 macOS 完成（AND 9/50 → OR 38/50 top-1，见 PROGRESS P07）；ICU 版本差异可能影响分词边界，在 Ubuntu/Windows 上重跑 `test/unit/` 中分词相关断言（`memory-store.test.ts` 的中文召回用例）确认召回不劣于 macOS。
- [ ] Linux CI 全绿确认：`memory*.test.ts`（单元 5 文件 + 集成 4 文件 + 安全 1 文件）与 e2e 既有 17 个用例在 Ubuntu（xvfb）通过。
- [ ] macOS runner e2e 全绿确认（既有 17 个 spec，CI 首次运行时）。
- [ ] **P07-B 界面项在三个平台的 e2e**（2026-10-01 交付，macOS 全绿）：`apps/desktop/test/e2e/memory.spec.ts` 4 个用例（①右栏记忆：分组/搜索/编辑/「只属于该 Bot」/证据高亮跳转/删除转已撤回；②群聊记忆的证据在对话删除后显示「来源对话已删除」；③画像页：整理任务产出条目 + 贡献 Bot + 卡片预览 + 编辑/删除；④用量与预算页：按 Bot/loop/天分组、预算持久化、超出当日提示）+ 既有 17 个 spec 无回归；Ubuntu（xvfb）与 Windows 随 CI 首跑确认（Intl/ICU 与本地日期分组在两平台一致）。

## P08（2026-10-01 核心领域层 + 界面与 e2e 完成于 macOS；以下为跨系统项）

- [ ] **官方技能仓库导入实测**（任务书「需验证技术点」第 2 条）：从 Anthropic（github.com/anthropics/skills）与 OpenAI 官方技能仓库各导入 2 个技能并运行，记录兼容性扫描结果（compatible/partial/incompatible）与脚本沙箱执行情况。属真实网络访问，本机未执行；导入管线本身（HTTPS es-git 克隆、扫描、审批、安装、沙箱执行）已用本地 git 夹具仓库全流程验证（`skills.test.ts`）。
- [ ] **Windows：`bash -n` 语法检查不可用**（技能生成验证步骤）：Windows 上无 bash（P12 WSL2 启用前），shell 技能的 `bash -n` 检查会失败导致验证不通过——属 fail-closed 正确行为；P12 后在 WSL2 内复验技能生成全流程。同批验证 Windows 上技能库目录 `chmod 0444`（writeReadonly）被忽略后，网关与沙箱仍阻断写入（`skills-registry.test.ts` 的只读断言在 NTFS 上的行为）。
- [ ] **Windows：`py_compile` / `node --check`**：python/node 技能的语法检查依赖宿主或工具链提供 `python3`/`node`（经 P06 环境管理器安装后进沙箱 PATH）；在 Windows 真机验证工具链 PATH 前置后 `python -m py_compile` 与 `node --check` 在沙箱/逐条确认模式内可用。
- [ ] **真实网络克隆**：生产环境仅放行 `https://` 远程（es-git/libgit2），本地路径与 `file://` 仅用于本地仓库与测试；真实 HTTPS 克隆（凭据、代理、私仓 401 场景）在三个平台各实测一次。
- [ ] Linux CI 全绿确认：`skills*.test.ts`（单元 3 文件 + 集成 2 文件）在 Ubuntu（userns 解除后）通过——authoring 集成用例依赖 srt 沙箱（bwrap）与 bash。
- [ ] macOS runner e2e 全绿确认（P08-B 的 skills.spec 2 个用例〔导入+审批卡片、候选选择+启停〕与既有 21 个 spec，CI 首次运行时）。

## P09（2026-10-01 核心领域层与界面/e2e 均完成于 macOS；以下为跨系统项）

- [ ] **真实模型样例抽查：Wiki 内容不出现用户个人信息**（任务书验收标准第 4 条）：配真实厂商，用含个人信息的样例资料走「学一下这份文档」全流程，抽查生成的页面与 log.md 不含用户个人信息、维护 loop 不执行资料中的指令。需真实模型 key，本机未执行（机制证据：SCHEMA 条款 + 维护提示词强制 + 体检清单，mock 驱动集成测试）。
- [ ] **Windows：沙箱内 curl 可用性**（URL 来源入库）：wiki 的 URL 抓取在沙箱内执行 `curl`（继承宿主 PATH）。macOS/Linux 系统自带 curl；Windows 原生 curl（Win10 1803+ 自带）在 srt 沙箱 PATH 注入后的可用性待真机验证；不可用时 URL 入库应 fail-closed 报 `SANDBOX_UNAVAILABLE` 而非绕过沙箱。随 P12 沙箱落地一并验证。
- [ ] **Windows/Linux：es-git wiki 仓库行为一致性**：`wiki.history`（revwalk）、`wiki.rollback`（全树 checkout + 新提交）、维护提交（index.addAll + writeTree + commit）在 NTFS/ext4 上的路径大小写与文件锁行为随 CI 首跑确认（P08 skills 仓库同构先例）。
- [ ] **FTS5 snippet/bm25 平台一致性**：wiki_fts 检索（OR 组合 + bm25 排序 + snippet）依赖 SQLite 编译选项，`test/unit/wiki.test.ts` 的 wiki_fts 用例在 Ubuntu/Windows 随 CI 首跑确认（P07 memory_fts 同类先例）。
- [ ] **大规模真实资料个人信息抽查**（交接要求）：用真实的大体积/多来源资料（网页批量入库、大型文档）做入库压测与个人信息抽查，记录维护 loop 的页面质量；本机仅有小样例夹具。
- [ ] Linux CI 全绿确认：`wiki*.test.ts`（单元 1 文件 + 集成 2 文件）在 Ubuntu（userns 解除后）通过——URL 抓取用例依赖 srt 沙箱（bwrap）与本机回环端口，`memory-reflection.test.ts` 的 P09 断言随全量跑。
- [ ] macOS runner e2e 全绿确认（P09 的 wiki.spec 与既有 23 个 spec，共 24 个，CI 首次运行时）。

## P10（2026-10-01 核心领域层与界面/e2e 均完成于 macOS；以下为跨系统项）

- [ ] **真实休眠唤醒的 OS 级行为**（任务书验收标准第 2 条的真机面）：macOS 真机合盖/休眠 ≥ 跨过一次任务触发时刻后唤醒，验证 `powerMonitor` 的 `resume` 事件真实到达、核心补触发带正确 `late_by`、定时器重臂后后续触发不再重复；对照「应用关闭期间错过」的启动补触发路径（机制已由集成测试以可控时钟验证，OS 挂起期间 libuv 单调时钟不走的前提需真机确认）。Windows（`powerMonitor` 的 suspend/resume 事件在 Windows 上的可达性，部分场景依赖现代待机 S0ix）与 Linux（XDG 休眠信号，Electron powerMonitor 在无 systemd/logind 会话下的行为）随各平台真机验证。
- [ ] **Windows/Linux 定时器精度与长延迟钳制**：`TIMER_MAX_DELAY_MS`（2^31-1-60s）钳制下超远期任务的分步重臂在 Windows/Linux 上无额外偏差；系统睡眠对长定时器的影响仅依赖 power.resume 补触发（两平台 setTimeout 在休眠期间的行为与 macOS 的差异实测）；后台进程被系统省电策略挂起（Windows 效率模式/Linux laptop 模式）时定时触发的可达性。
- [ ] **Intl 时区数据一致性**：免打扰窗口结束时刻（`quietHoursEndAt`）与每日零点（`nextLocalMidnight`）依赖宿主 ICU 时区库，历史 DST 规则差异（如 Windows 无 `right/` 时区数据库）可能改变边缘推迟时刻——`schedule-guard.test.ts` / `schedule-cron.test.ts` 的时区用例在 Ubuntu/Windows 随 CI 首跑确认。
- [ ] **powerMonitor 事件的桌面端到端**：右栏「定时任务」列表与设置页汇总（P10-B 界面已交付：直聊标签页 + 群信息分区 + 设置页汇总三处共用组件，macOS e2e 26 全绿含 schedules.spec 2 例——列表显示、两步取消、真实时钟 25 秒到点主动发消息）在三个平台的 e2e 与真实休眠场景手工验证（macOS runner e2e 全绿确认含既有 24 个 spec + P10-B 新增 spec）。
- [ ] Linux CI 全绿确认：`schedule*.test.ts`（单元 2 文件 + 集成 1 文件，无沙箱依赖）在 Ubuntu 通过。

## P11（2026-10-01 核心侧 + 界面 + e2e + 技术点完成于 macOS，browser.spec.ts 8 例全绿；以下为剩余跨系统/真机项）

- [ ] **网络拦截的 OS/Chromium 真实行为矩阵**（判定逻辑已由 `browser-net-rules.test.ts` 纯函数覆盖）：**macOS e2e 已覆盖**（`browser.spec.ts`：`127.0.0.1` 未绑 project 拦/绑后放行〔拦截时请求未达本地服务器〕、`192.168.1.1`/`169.254.169.254` 绑定后恒拦、本地夹具放行）；**公网站点真实打开未实测**（网络依赖，放行由判定函数覆盖）；剩余：Windows/Linux 复验同矩阵 + 各平台 DNS 解析器差异（systemd-resolved / Windows DNS 缓存、hosts 文件、IPv6 先行）对拦截判定的影响。DNS 延迟 macOS 已实测（`node scripts/measure-browser-dns.mjs`，与 browser-host 同算法：缓存热 p95 0.021ms、冷首查 mean 41.6ms），Windows/Linux 随 CI 复跑该脚本。
- [ ] **隐藏 `WebContentsView` 渲染与截图**：**macOS e2e 已覆盖**（隐藏窗口截图非空白像素断言 + retina DPR 2× 实测 2560×1600、宽高比不变）；剩余：Windows（隐藏窗口渲染节流/GPU 合成路径不同）、Linux 无 GPU 环境 software rendering 的复验；新增——**截图物理分辨率随显示 DPR 放大**，高 DPR（3×/4×）显示器与外接屏下复核 `BROWSER_SCREENSHOT_MAX_BASE64_CHARS=4_000_000` 上限是否够用。
- [ ] **`Accessibility.getFullAXTree` 平台差异**：**本地复杂页面定标 macOS 已完成**（testkit `/large` 夹具 ≈1.3k DOM 节点，150 元素/4000 字符截断经 e2e 断言生效）；**任务书要求的三大型网站（github.com 等）实测在 macOS 也未做**（保持登记，不做伪造）；剩余：大型网站定标按平台复核（macOS + Windows/Linux 随迁）；AX 树由平台可达性后端产出（macOS AX/Windows UIA/Linux AT-SPI）的 role 命名/name 内容平台差异对引用稳定性的影响；Linux 服务器环境无 AT-SPI 会话时 AX 树可用性（可能需要 accessibility 启动开关）。
- [ ] **分区数据目录布局**：`app.setPath('sessionData', KEPCUP_HOME/browser)` 后 Electron 各平台实际的分区落盘路径复核（Windows 路径长度限制对 `Partitions/bot-{ulid}` 的影响）；删除 Bot 后分区目录真实消失——macOS e2e 已验证（强制落盘→目录存在→删除→目录消失不复活），rmSync 在 Windows 文件占用锁下的重试语义待验。
- [ ] **下载行为**：`will-download` → workspace/downloads（macOS e2e 已验证落盘与内容）；剩余：三平台的文件名清洗（保留字符集差异）、重复命名规避与默认打开方式关联行为。
- [ ] **CDP `webContents.debugger` 稳定性**：`DOM.resolveNode`/`Runtime.callFunctionOn`/`Input.dispatchKeyEvent`（P11-B 实测：带 text 的键需 `type:"keyDown"` 才产生 keypress/表单隐式提交）在三平台 Chromium 版本间行为一致（desktop 锁定 Electron 版本，风险低，抽验即可）。

## P12（2026-10-01 核心侧与界面/e2e 完成于 macOS——全部 WSL 代码盲写 + fixture/注入 runner 测试 + e2e 注入驱动向导；以下为真机/跨系统项）

- [ ] **WSL 真机全套（Windows 11）**：`wsl --status` / `wsl --list --verbose` 输出编码与本地化形态抽查（fixture 按文档格式自造——BOM有无、zh-CN 标签变体；已知弱点：BOM-less UTF-16 中文输出解析会落入 needs_enable 幂等流程，不静默，真机确认实际形态后按需收紧 decode 启发式）；`requestEnable` 的 UAC 提权真机行为（PowerShell Start-Process -Verb RunAs 弹窗、取消授权的非零退出码路径）；重启后状态机续导（awaiting_reboot → probe → ensureDistro）；`wsl --import Kepcup --version 2` 真实导入 + wsl.conf（automount/interop 关）生效验证（terminate 后 C 盘不可见、cmd.exe 不在 PATH）。
- [ ] **rootfs 构建流水线接入 CI**（任务 1，脚本已写好不执行）：CI（ubuntu runner + debian:12-slim 容器）产出 `resources/wsl/rootfs.tar` + manifest（版本/sha256）；钉住基础镜像 digest；产物随 Windows 安装包分发（P13 打包阶段接线）。发行版内 `kepcup-sandbox --selfcheck` 通过 = srt 依赖（bwrap）在该发行版 + WSL2 内核可用的首个自动化验证点（任务书需验证技术点①；失败时的 rootfs 调整也在这里做）。
- [ ] **安全用例集在 WSL 后端**（任务书测试要求）：`packages/core/test/sandbox/sandbox-isolation.test.ts` + P03 确认模式/授权用例在 Windows 真机（已导入发行版）全绿——win32 skipIf 集成块（wsl-backend.test.ts 文件尾）先行冒烟（probe + `echo kepcup-e2e-ok`）；C 盘未挂载目录在发行版内不可见；发行版内无法启动 Windows 程序（cmd.exe 不存在于 PATH 且 interop 关闭）。
- [ ] **drvfs 动态挂载真机验证**（需验证技术点②；语义按修复轮 BR-P12-001/008 修复后表述）：挂载 project 后读写正常；未挂载的 Windows 路径在发行版中不可见；授权撤销后「本命令不可读」（发行版 srt 配置对 /mnt/kepcup 与 /home/kepcup 整树 deny、计划内路径 last-match-wins 重暴露）+「命令结束即清理」（引用计数归零触发 kepcup-mount umount——真机复核 drvfs umount/重挂的耗时与 busy 行为）；kepcup-mount 模式变更（rw↔ro）remount 真机复核（busy 时非零退出 → SANDBOX_MOUNT_FAILED）；`\\wsl$` 9P 共享路径被 isWindowsAbsolutePath 拒绝挂载的真机复核。
- [ ] **workspace 落位裁决的真机输入**（需验证技术点③）：`\\wsl$\Kepcup\...` 访问发行版内目录的 1000 小文件读写耗时实测；与 drvfs 挂载方案（当前交付默认：workspace 留 Windows 侧 + 挂载进发行版）的读写耗时对比；`\\wsl$` 可靠性（文件锁、重命名、删除竞态）——若显著优于 drvfs 则按 `distroWorkspacePath`/`wslUncPath`（已实现并有单测）一次切换并在 PROGRESS 记录。
- [ ] **WSL2 端口转发**（需验证技术点④）：发行版内 `python -m http.server` 被 Windows 侧（Bot 浏览器）访问成功（localhostForwarding 默认行为）；绑定 project 的对话内沙箱命令 curl 发行版内回环 dev server（srt allowLocalhost 语义在发行版内的实际表现）；`.wslconfig` networkingMode=mirrored 时的行为复核。
- [ ] **Windows 10（19041）完整流程**（需验证技术点⑤）：Windows 10 虚拟机中走完「管理员授权 → 重启 → 导入 → 沙箱执行」全流程（Win10 的 wsl.exe 输出形态与 Win11 差异、可选组件启用提示差异在此覆盖）。
- [ ] **发行版内工具链安装真机验证**：catalog `wslDistro` 条目（node：linux tarball 暂存 → tar 流入发行版 → 发行版内 verify；python：发行版内 uv `python install`）在真实 wsl.exe 上端到端；`distroToolchainPathPrefix` 注入后沙箱内 `node --version` 可用；`environment.remove` 的发行版内删除。
- [ ] **Lima（macOS 增强级）真机**：本机确认未装 limactl（按指令不安装重资源依赖）；真机 `brew install lima` → `limactl create/start`（VM 挂载按 build-rootfs.sh 头注释 provision，同径挂载）→ catalog lima 条目检测可用 → 增强技能路由到 Lima 后端执行 → **安全用例集在 Lima 后端运行**（任务书测试要求「增强级：在 macOS 与 Linux 上运行安全用例集」）。
- [ ] **Podman（Linux 增强级）真机**：rootless Podman 安装（subuid/subgid 配置）→ `podman import rootfs.tar`（PODMAN_IMAGE=kepcup-sandbox:1）→ per-command `-v` 绑定的读写/只读语义 → 安全用例集在 Podman 后端运行；Ubuntu 24.04 userns/AppArmor 环境下 rootless 容器与 bwrap 的共存行为。
- [ ] **catalog lima/podman 条目的引导链路真机**：审批卡片 guide 文案（brew / 发行版包管理器）→ 用户安装 → 「重新检测」（detectBin=limactl 的 detectSystemItem 真机探测）→ waiter 收到 `environment_installed`。
- [ ] **准备向导真机走查（P12-B 界面，e2e 为 fixture 注入驱动）**：`sandbox-wizard.spec.ts` 4 例在 macOS 上经 `KEPCUP_WSL_TEST_FIXTURE` 注入的 wsl.exe fixture 驱动（仅 wsl.exe 字节是夹具，状态机/网关/界面全为生产代码）；真实 Windows 上待走查：requestEnable 的 UAC 弹窗文案与非零退出路径、awaiting_reboot 提示与「重启后打开应用自动继续导入」的真实链路、真实导入耗时（rootfs.tar 数百 MB）下向导 importing/configuring 进度展示与轮询体验、失败原因 + 帮助链接渲染、首启提示与跳过持久化（状态文件跨重启）、设置页 WSL2 后端 + enhanced 行（Windows 上 enhanced 为 null 的展示）+ 共享 VM 说明。
- [ ] **增强级界面的安装侧翻转真机**：本机 e2e 只覆盖「未安装」半边（enhanced 行「未安装」+ 技能 incompatible + 提示）；Lima/Podman 真机安装后待验证——设置页 enhanced 翻「可用」、向导增强入口徽标翻转、已导入 enhanced 技能经 `resolveEffectiveCompatibility` 从 incompatible 翻 active 的界面刷新（`sandbox.status` probe 触发 refreshEnhancedAvailability）。

## P13（2026-10-01 核心侧 P13-A + 界面/性能/回归收口 P13-B 完成于 macOS——electron-builder 三平台配置 + electron-updater 门控 + 开机自启 + 迁移备份 + 产物剔除 + 首启引导 + 诊断页 + 更新/自启 UI + 性能测量与优化；以下为签名/真机/CI 项）

- [ ] **macOS 签名与公证**：Developer ID 证书（CSC_LINK/CSC_KEY_PASSWORD）+ notarytool（APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID）经 CI 机密注入后重打包；验证安装时无「未知开发者」警告（任务书验收标准 1）。本机产物为 identity=null + CSC_IDENTITY_AUTO_DISCOVERY=false 的未签名构建（codesign=adhoc），如实不伪造。
- [ ] **Windows NSIS + 代码签名**：x64/arm64 nsis 构建在 windows runner 通过（release.yml 矩阵）；证书（WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD）或 Azure Trusted Signing（五元组 secrets）注入后安装无警告；NSIS 安装/卸载/升级安装路径真机走查。
- [ ] **Linux AppImage + deb**：x64/arm64 构建在 ubuntu runner 通过；deb 安装/卸载、AppImage 直启真机走查（maintainer 字段、desktop 入口、XDG autostart 与 deb 的配合）。
- [ ] **三平台干净机（虚拟机）安装走查**（任务书测试要求）：安装 → 首次启动 → 完成引导 → 对话 → 执行命令 → 卸载。本机打包 app 首启实测：进程阻塞于框架层系统模态弹窗（sample 证实 NSAlert runModal 于应用 JS 之前——ad-hoc 签名新二进制的 macOS 隐私/安全类人工授权弹窗），需人工点击确认后继续走查；确认弹窗的具体条目（TCC/keychain 类）与签名后的形态差异在此一并记录。
- [ ] **引导真机走查（P13-B 界面）**：首启向导五步（欢迎/数据位置 → 模型厂商〔含跳过后的持续提示〕→ 权限〔自启开关在真机的 setLoginItemSettings 回读、系统通知的 OS 授权弹窗在打包签名 app 上的出现时机〕→ 沙箱〔Windows 上向导步骤在真机 WSL2 的衔接、Linux 上的 sudo 修复命令〕→ 第一个 Bot〔模板〕）在打包 app 上的完整走查；「新用户 3 分钟内完成引导并与第一个 Bot 对话」（验收标准 4）的真机计时（本机 e2e 已覆盖全流程机制，真机人工计时留此）。
- [ ] **诊断页真机条目（P13-B 界面）**：`system` keystore（真机钥匙串而非 e2e 的 memory 注入）时的「钥匙串 / 密钥存储」行与 KEYSTORE_UNAVAILABLE 场景（钥匙串锁定/拒绝）的显示；Linux Secret Service 缺席时的诊断行；「在文件管理器中打开」在三平台文件管理器（Finder/Explorer/xdg-open 兼容环境）的实际打开行为。
- [ ] **自动更新端到端**（任务书测试要求）：从上一个已发布版本自动更新到当前版本、数据完整（需真实发布仓库 + GH_TOKEN；publish 仓库 owner/repo 现为占位）。含：electron-updater 在三平台的下载/校验/重启安装、`KEPCUP_UPDATE_URL` generic 源覆盖、门控在真实在途执行下的等待/用户确认链路、macOS zip 增量（blockmap）更新。
- [ ] **开机自启真机验证**：macOS **签名后** `app.setLoginItemSettings` 的注册/注销真机行为（任务书明示「macOS 需签名后验证」；未生效时 login-item 的 failed + reason 路径在此复核）；Windows（Run 注册表键）与 Linux（XDG autostart desktop 文件 `~/.config/autostart/app.kepcup.desktop`）真机注销/重登验证；设置页开关（P13-B UI）与系统侧状态的一致性。
- [ ] **CI release 矩阵首跑**：release.yml rootfs job（docker 构建rootfs.tar 落 resources/wsl/）+ 6 组平台×架构构建全绿；arm64 runner（macos-13〔x64〕/ubuntu-24.04-arm〔arm64〕）可用性确认；原生模块在每平台的 rebuild（better-sqlite3-multiple-ciphers/es-git/@napi-rs/keyring）。
- [ ] **中端机性能口径**：任务书「冷启动 ≤3s（中端机器）」的中端机实测（本机 M1 Max 实测 1417ms，见 PROGRESS P13）；「输入框按键到字符显示无可感知延迟」的人工验证；空闲 ≤300MB 达标确认（P13-B 优化后的结果在此复核）。
