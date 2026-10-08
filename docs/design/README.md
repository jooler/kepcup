# Kepcup 设计文档

一个类似 Grok Bot 的对话式 Bot 应用：用户与 Bot 对话，Bot 在独立的执行 loop 中完成任务并把结果反馈到对话。设计目标是让每个 Bot 像一个真人——它记得用户，记得自己的状态，有自己的大脑（知识库），有自己的工具（技能），并且能在用户的项目中完整地编辑代码。

本应用是运行在 macOS、Windows、Linux 上的**本地客户端应用**，所有数据保存在用户本机。

开发指导文档见 [../dev/README.md](../dev/README.md)。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-conversation.md](01-conversation.md) | 通讯录、单聊、群聊、输入与待发送队列、消息模型、删除语义 |
| [02-execution.md](02-execution.md) | 执行模型、并发、loop 类型、上下文注入、群聊响应、主动消息、撤回与编辑 |
| [03-bot.md](03-bot.md) | Bot 的构成、Profile、生命周期 |
| [04-memory.md](04-memory.md) | Bot 长期记忆、共享用户画像、写入与注入 |
| [05-wiki-and-skills.md](05-wiki-and-skills.md) | Bot 知识库（LLM Wiki）与技能（Skills） |
| [06-isolation-and-storage.md](06-isolation-and-storage.md) | 执行 / 数据 / 并发 / 信任隔离，整体数据流 |
| [07-local-runtime.md](07-local-runtime.md) | 本地客户端定位、进程结构、环境配置 |
| [08-project.md](08-project.md) | Project：用户工作空间、写入租约、检查点与回退 |
| [09-tech-stack.md](09-tech-stack.md) | 技术选型：Agent loop（pi）、桌面壳（Electron）、前端（Svelte + shadcn-svelte） |
| [10-sandbox.md](10-sandbox.md) | 沙箱实现：srt、Windows WSL2、文件系统与网络规则、git |
| [11-storage.md](11-storage.md) | 存储：数据目录、数据库、加密、敏感数据 |
| [12-ui-layout.md](12-ui-layout.md) | 界面：视觉风格、三栏布局、交互反馈 |
| [13-permissions.md](13-permissions.md) | 访问授权（软隔离）：默认范围、授权、沙箱外执行、逐条确认模式、命令白名单、无人值守模式 |
| [14-models-and-browser.md](14-models-and-browser.md) | 模型配置、浏览器工具 |
| [15-interactive-execution.md](15-interactive-execution.md) | 命令交互执行：非交互优先、交互模式 stdin 通道、输入可见性分层、凭据注入、平台降级 |
| [16-capability-models.md](16-capability-models.md) | 能力模型（非对话模型）按类型配置、国内厂商逐能力 API 适配、检索重排 |
| [17-mineru-document-parsing.md](17-mineru-document-parsing.md) | 文档解析：预置公共技能接入官方 MinerU（vendored），PDF/扫描件读原文并整合进 Wiki |
| [18-inline-setup.md](18-inline-setup.md) | 对话内设置引导：缺配置时在对话里就地呈现设置组件，完成后自动续跑 |
| [19-work-path-and-group-setup.md](19-work-path-and-group-setup.md) | 对话=工作路径的绑定模型；Bot 访谈中的目录问题；群创建对话化与群语义（description） |
| [20-conversation-media.md](20-conversation-media.md) | 对话附件与媒体：用户上传、草稿附件、内联渲染与灯箱、语音/视频生成工具、图片进视觉通道 |
| [21-web-search.md](21-web-search.md) | 联网检索：内置 web_search / web_fetch 工具、检索供应商配置、内联设置引导 |
| [22-file-skill-routing.md](22-file-skill-routing.md) | 文件技能路由：推荐技能注入、install_skill 授权安装、四级升级阶梯 |
| [23-mcp-and-subagent.md](23-mcp-and-subagent.md) | MCP 工具服务器接入与宿主 SubAgent（前台 / 后台 / 并行 fan-out） |
| [24-durable-execution.md](24-durable-execution.md) | 长任务可恢复执行 / Host Durable Journal：ephemeral 默认仍按 D49，durable 按 journal 与工具 replay 策略 resume |
| [25-capability-tools.md](25-capability-tools.md) | 能力补位工具：understand_image（图片理解）与 transcribe_audio（语音转写），缺配置走对话内设置引导 |
| [26-voice-input.md](26-voice-input.md) | 输入坞语音化：按录转文字键与语音对话模式（音频附件 + 转写文本），16kHz PCM→WAV 录音管道，缺配置走对话内设置引导 |
| [27-butler-and-delegation.md](27-butler-and-delegation.md) | 管家 Bot（唯一/置顶/不可删）与跨 Bot 委派 A→B：组队审批卡、路由、delegations、结果回贴（非 SubAgent） |
| [28-external-agents-acp.md](28-external-agents-acp.md) | 外部智能体引擎（ACP）：设置页智能体目录（兼容 ACP Registry 条目）、Bot 在模型 / 智能体间选择、宿主能力按能力包可选注入、Provider 架构；本期 Claude Agent / Codex / OpenCode / DeepSeek Harness / Cursor / Google Antigravity（仅 key / Vertex 登录）；ZCode 已放弃（DEV-008：订阅鉴权须由宿主读取 / 中转凭据）；补位能力原生优先；隔离让渡与条款边界（未实现） |
| [29-connected-apps.md](29-connected-apps.md) | 连接应用（Connect apps）：第三方账号经远程 MCP + OAuth（MCP Authorization 规范、CIMD/DCR/预注册、系统浏览器 + loopback）授权给 Bot；Connector→Connection→Grant 模型、令牌本地加密、按工具风险分级审批与定义锁定、对话内连接卡；开放平台基座（MCP / MCP Apps / Agent Skills / Registry 子注册表、分级信任、开发者流程）（未实现） |
| [30-supervisor-and-tasks.md](30-supervisor-and-tasks.md) | 对话轮与任务分治：对话轮（只读、串行、负责沟通与调度）与任务（完整工具面、可并行、负责执行）两层 loop；任务状态机与「必有结算」不变量、枚举化路由工具、1 写 N 读租约、消息所有权与任务卡；归并 D66/D71 并化简 D72；worktree 隔离明确不做（未实现） |
| [31-sensors.md](31-sensors.md) | 传感器统一管理：麦克风 / 摄像头 / 将来的温湿压风等统一为 `sensor`（kind × transport × dataShape 三维描述表）、统一权限与授权、设备选择与启停、设置页「硬件」数据驱动；本期麦克风做实、摄像头只走通硬件（Bot 监看待需求确认）；default session 权限收紧（代码已实现，待实机验收） |

## 尚未讨论（暂不入文档）

- 暂无

## 决策记录

| # | 议题 | 决定 |
|---|---|---|
| D1 | 用户与 Bot 的归属 | 单用户应用，Bot 为该用户私有 |
| D2 | Bot 执行中收到新消息 | 在 loop 的下一步注入，由 Bot 决定调整还是继续 |
| D3 | 删除对话后的长期记忆 | 保留；Bot 记得用户，但看不到旧聊天记录 |
| D4 | Bot 之间的触发 | 仅在明确 @ 时触发，限制连锁层数与预算 |
| D5 | 群聊多个 Bot 都要响应 | 按顺序执行，后执行者能看到前者回复并可放弃 |
| D6 | 主动消息、撤回与编辑、沙箱 | 三者都支持 |
| D7 | Bot 自建技能的启用 | 沙箱试跑通过后自动启用，并在对话中告知用户，用户可随时停用 |
| D8 | 私聊信息是否进入共享用户画像 | 默认共享；敏感类信息和用户声明“只告诉你”的除外 |
| D9 | Bot 之间的 Wiki 访问 | 完全隔离，分享知识通过消息附件 |
| D10 | 用户连发多条消息 | 取消防抖，改为待发送队列：输入框为空时再次发送即发出；另提供快捷键一步追加并发出 |
| D11 | 应用形态 | 本地客户端应用，数据保存在本机 |
| D12 | 支持平台 | macOS、Windows、Linux |
| D13 | 宿主层环境安装 | 由 Bot 申请，每次都需用户确认 |
| D14 | 休眠期间错过的定时任务 | 唤醒后补执行，并告知 Bot 迟到多久，由 Bot 决定是否仍要发送 |
| D15 | Windows 沙箱 | 直接采用增强沙箱 |
| D16 | Workspace 中的 git 命令行 | 作为宿主层环境，走正常申请流程 |
| D17 | 群聊待发送队列中的 @ | 一批消息中的所有 @ 合并计算，被 @ 的 Bot 按顺序响应 |
| D18 | 删除 Bot | 类似微信删除联系人：消息保留、名称显示为 id、群内不能被 @、私聊只读；相关 loop 全部中断；id 永不复用；记忆、Wiki、Skills、workspace 全部清理；删除前弹框提醒 |
| D19 | 群成员变动 | 移除即直接移除；新加入的 Bot 等同一直在群中，可读取完整群历史 |
| D20 | 删除对话 | 该对话中的承诺作废；Wiki 资料保留 |
| D21 | Agent loop 框架 | pi，作为库嵌入核心服务，锁定版本并封装在自有接口之后 |
| D22 | 桌面壳 | Electron；核心服务为独立 Node 进程 |
| D23 | 前端 | Svelte 5 + shadcn-svelte，优先使用现成组件 |
| D24 | 数据库 | better-sqlite3-multiple-ciphers + FTS5 + sqlite-vec；不采用 libSQL（没有字段级加密，整库加密无完整性校验） |
| D25 | 加密与敏感数据 | 主密钥存系统钥匙串；每个库派生独立密钥；API key 等再做字段级加密，LLM 只见代号 |
| D26 | 数据目录 | `~/.kepcup/` |
| D27 | 沙箱实现 | macOS / Linux 使用 srt；Windows 使用私有 WSL2 发行版；增强级 macOS 用 Lima、Linux 用 rootless Podman |
| D28 | Project | 绑定到对话，对话中所有 Bot 可读写，是处理用户文件的默认目录 |
| D29 | Project 并发 | 写入租约：同一目录同一时刻只有一个 loop 可写，跨对话生效 |
| D30 | Project 撤销 | 影子 git 仓库做检查点，每次执行可查看 diff 与整次回退 |
| D31 | git 远程操作 | 由核心服务在沙箱外代为执行，每次需用户确认 |
| D32 | Windows 前置条件 | 接受一次管理员授权与重启启用 WSL2；支持 Windows 10（19041+）与 11；project 实时挂载 |
| D33 | Linux 前置条件 | 需要时引导用户执行一次 sudo 命令解除用户命名空间限制 |
| D34 | 界面布局 | 三栏：左栏对话列表与头像菜单，中栏对话，右栏 Bot 详情 |
| D35 | 访问范围 | 软硬结合：文件工具由工具网关按路径检查（软隔离），命令行在沙箱中执行且规则按当前授权实时生成 |
| D36 | project 以外的读取与写入 | 都需授权；系统目录与工具链目录只读放行；应用数据目录永远不可授权 |
| D37 | 授权方式 | 只给提出申请的 Bot、只在当前对话内有效；有效期为“仅这一次”或“本对话内一直允许”，可随时撤销 |
| D38 | 沙箱外执行 | 允许 Bot 申请，每次都需用户确认 |
| D39 | 沙箱不可用时 | 降级为逐条确认模式，取代原先的“直接禁用” |
| D40 | 只读命令白名单 | 逐条确认模式下豁免确认；严格匹配；不放宽访问范围；用户可自定义 |
| D41 | 无人值守模式 | 用户确认危险提示后，所有待确认操作一律自动批准；全局开关，可定时关闭；全程审计（D72 修订：沙箱外命令的自动批准 fail-closed——无法静态证明不触及应用数据目录的命令自动拒绝，见 13） |
| D42 | 盲目批准的风险 | 由用户自行把握，产品不额外干预 |
| D43 | 本机端口 | 对话绑定 project 时，沙箱命令可监听并访问本机端口 |
| D44 | 浏览器工具 | 每个 Bot 默认具备，使用 Electron 内置 Chromium，每个 Bot 独立会话 |
| D45 | 模型配置 | 直接复用 pi 的模型能力；设置页配默认主模型与轻量模型，Bot 可覆盖 |
| D46 | 视觉与交互 | 参考 Grok Bot，简单、扁平；用户目光焦点处的反馈重点细致处理 |
| D47 | 运行时元数据 | Bot Profile、技能安装记录、环境安装记录统一存数据库；文件系统只存文件类内容 |
| D48 | Bot 发消息的方式 | 最终回复自动发送；中途用 `send_message`；不回复用 `skip_reply`；@ 其他 Bot 只能通过结构化参数 |
| D49 | 中断的执行 | 应用退出或崩溃时标记为中断，重启后提示，不自动恢复（D67 修订：仅适用于 ephemeral run；durable 见 [24-durable-execution.md](24-durable-execution.md)） |
| D50 | 命令交互输入 | bash 支持交互模式（stdin 受控通道）：模型发起，只有用户能写 stdin；非交互优先是默认形态 |
| D51 | 输入对模型的可见性 | 普通输入回注入工具结果（模型可见）；用户标记敏感的输入只回执不回显（密码类分层处理） |
| D52 | 凭据注入 | 密码/token 经审批卡片输入后写入命令 stdin，值不进模型上下文与任何持久化；可记住到本对话结束（系统钥匙串） |
| D53 | 无人值守模式扩展 | 交互与凭据默认授权：有缓存的凭据自动注入、无缓存自动拒绝；交互命令无人输入按空闲超时结束；开启弹框增加对应警告 |
| D54 | 中间过程投送 | 带工具调用的回复里的说明文字自动作为消息进对话（护栏：每 run 直聊 8 条 / 群聊 4 条、单条 2000 字符截断）；工具调用与输出仍只进执行记录；进度不走 `send_message`（todo/loop-interim-updates.md） |
| D55 | 执行状态行 | 状态行排在消息流末尾、带头像，位置即下一条消息出现的位置；文案随活动切换（请稍等… / 正在调用工具 X…），新消息落库时让位隐藏、下一个工具活动重现；run 结束移除 |
| D56 | Loop 续接 | 上一 run 结束 30 分钟内的新触发默认回放其过程记录（确定性，不做模型判断）；超出窗口但 24 小时内有候选时由轻量模型判断续接哪些 run；回放有独立 token 预算、大段工具输出用占位符；旧 run 原样保留、只落新 run 并记录 `continued_from_run_ids`；判断失败按不续接处理 |
| D57 | 文档解析能力 | 预置公共技能逐字引入官方 MinerU Agent Skill（AGPL-3.0，NOTICE 记录锚点，同步脚本跟随上游），不改写不翻译；本地解析优先、上云需用户同意；Wiki 整合走「全量导出 markdown → wiki_enqueue(file)」，零核心改动（见 17） |
| D58 | 对话内设置引导 | 功能缺配置时在对话里就地呈现设置组件（与设置页同一份数据）：无模型的消息发送被门禁拦下（草稿保留）、能力缺失的执行以结构化 setup 失败（`runs.error_json` 携带；媒体网关专用错误码 `CAPABILITY_NOT_CONFIGURED`、工具 `SETUP_REQUIRED` 中断）；完成设置后自动重试原 run 或冲掉草稿队列；设置组件从设置页拆出复用，卡片不做消息持久化（见 18） |
| D59 | 创建期工作路径引导 | 工作路径的绑定单位是对话（P04 既有模型，群内所有 Bot 共享、写租约串行化）；新建 Bot 的访谈在首问作答后、任何 LLM 调用前，由 core 确定性插入「工作目录」一问（选择目录 / 暂不设置）；闸门关闭期间一切用户消息只落库不投递，作答后缓冲消息与目录决定一起进入首个响应 run（见 19） |
| D60 | 群创建对话化 | 新建群从弹框改为对话内四问（名称、主要事务、成员、工作目录），全部 core 确定性下发、零模型调用；群定位落新列 `conversations.description` 并注入群聊 `<conversation_info>`；创建状态 `conversations.setup_state='creating'` 持久化，可中断续答、可取消（级联删除）；成员作答即写行，完成前 Bot 不被唤醒（见 19） |
| D61 | 附件与媒体 | 用户附件走既有 attachments 通道（上传即落盘、草稿预挂、flush 转正；`drafts.add` 增 `attachmentIds`、发送前可 `attachments.detach`）；消息附件按 mime 内联渲染（图片缩略图、音视频点击加载播放、灯箱缩放预览）；新增 `generate_speech` / `generate_video` 工具（视频提交+轮询，产物经 send_message 附件发出）；触发批图片附件在模型支持时以 image part 入上下文（≤4 张、单张 ≤5MB），不支持时保持文本行；上下文附件行补充 mime（见 20） |
| D62 | 联网检索能力 | 以内置宿主工具提供（`web_search` + `web_fetch`），不做默认安装的搜索技能——检索是服务调用，curl 抓搜索页脆弱且不可控，工具层可配置可测试可复用；供应商 `settings.webSearch`（tavily/brave/bocha），key 存 `websearch:{provider}`；未配置走结构化 setup `{kind:'web-search'}` 内联引导；`web_fetch` 带 SSRF 防护独立可用；检索为只读公网操作，无需审批（见 21） |
| D63 | 文件技能路由 | 模型面对处理不了的文件按四级阶梯升级：已安装技能 → `<recommended_skills>` 段匹配预置技能后 `install_skill(preset_id)`（阻塞审批 `skill_preset`，装为公共技能）→ `web_search` 检索技能仓库后 `install_skill(source_url)`（走既有 `skill_import` 扫描审批，按 Bot 安装）→ 如实告知不支持；两级授权强度与内容信任级对齐（预置轻授权、外部完整扫描审批）；无人值守下两者同属自动批准类；安装后当次 run 即可用（prepareRequest 刷新提示词）（见 22） |
| D64 | Pi 版本 | 升级并锁定 1.x（1.0.2）：0.87.1 → 1.0.2 为纯版本变更（核心 API 逐字兼容，harness/search/telemetry 移除项宿主未使用），D21 封装不变 |
| D65 | MCP | 用户在设置页配置 MCP server（stdio / streamable HTTP），按「应用启用 ∩ Bot 勾选」暴露工具；调用走网关审批（autoApprove 默认关）与审计；密钥字段级加密；OAuth 与 Codemode 后续单排（见 23） |
| D66 | 宿主 SubAgent | `delegate_task`：前台同步（默认阻塞等结论）、**后台委派**（立即返回，主 Bot 可继续对话，完成后 follow-up 注入）、**并行 fan-out**（多路只读子 run，有硬顶）；loopType=subagent、落 run 行、不写用户消息、结论 ≤4000 字符；不充当群成员、禁止再委派与子代理互通；fork / 热替换 / 任务树面板等明确不做（见 23） |
| D67 | 长任务崩溃恢复 | Host Durable Journal；run 分 ephemeral（默认，仍按 D49：标中断、不自动恢复）与 durable（按 journal + 工具 replay 策略 resume）；不把 Pi Durable 包定为全体 Bot Runtime；修订 D49 的适用范围为仅 ephemeral（见 24） |
| D68 | 能力补位工具 | 主模型没有的能力以工具补位（image/tts/video/web_search 已落地）；补齐 `understand_image`（multimodal）与 `transcribe_audio`（asr）：素材 = 附件 id 或 workspace/project 路径转 data URI，未配置走 SETUP_REQUIRED → 结构化 setup 失败 → 对话内设置卡 → 自动续跑；embedding/rerank 保持内部环节不工具化（见 25） |
| D69 | 语音输入 | 输入坞右侧语音键（白圆 AudioLines）：**点击**开始录音、原位变「■+计时+点点」胶囊、再点停止并转文字填输入框（Esc 取消；60s 上限、500ms 下限）；有内容/队列时该位是发送键（出现逻辑不变），录音中打字则胶囊与发送键并列；未配置 asr 点击置起对话内设置卡；录音 16kHz PCM→WAV（软性采集约束 + OverconstrainedError 回退；worklet 以 `?url&no-inline` 同源资源加载——CSP 拦 blob:/data: 脚本），设备在设置页「硬件」分区选择；macOS TCC 授权门：askForMediaAccess 主动拉框、被拒深链系统设置。语音对话模式（按住发音频消息）暂缓、入口隐藏，设计保留在 26（见 26） |
| D70 | Butler（管家） | 每用户唯一 `system_role='butler'`：置顶、不可删；访谈后 `propose_team` 审批卡 → 确定性批量 `bots.create`；工具 `propose_team` / `propose_bot` / `propose_group` / `suggest_route`（仅管家）+ `list_bots` / `delegate_to_bot`（所有 Bot）；审批 kind 单一 `butler_proposal`、非阻塞、无人值守不自动批；未知→管家、单域→直聊、多角色→群、留在本聊→委派；早期先路由卡，「你安排」再委派（见 27） |
| D71 | 跨 Bot 委派 A→B | `delegate_to_bot` / `cancel_delegation` + `delegations` 表；B 收用户代发消息（`origin=delegation`「由 A 代你发出」），UI 留在 A；B 终回复截断~2000 贴回 A 为卡+链接，internal follow-up 禁止复述（feedback 首期不做）；B 忙 / 免打扰时排队（`submitted`），保证每个委派对应自己的 run；防环：首期一律单跳（执行时校验）、禁 A→B→A、禁委派给管家；同群降级 D4 `@`；**不是** D66 SubAgent（见 27） |
| D72 | 外部智能体引擎（ACP） | 设置页「智能体」目录（条目与 ACP Registry 同构 + KepCup 扩展字段，随应用锁版本），用户启用 = 按需安装（npx / binary 校验 sha256 / 系统 CLI）+ 官方登录；Bot 运行配置在「模型 / 智能体」间选择（`runtime.agent`），选 Agent 时可设模型、权限档位与**注入的能力包**（默认 = Agent 原生没有的全部注入，`core` 必选；补位类能力**原生优先**——工具描述前缀 + `<tool_policy>` 让 Agent 先用自带工具，宿主语义类能力宿主优先）；`ExternalAgentEngine` 是 `AgentEngine` 第二实现，换 loop 不换 Bot；宿主能力经本机 MCP 桥（会话级 token、绑定当前 run）注入；Agent 原生文件 / 命令工具在其自身沙箱运行，权限请求分级进 `agent_tool` 审批卡（隔离让渡；永不 bypass；无 OS 沙箱的 Agent 命令逐条确认）；写入租约整 run 持有；每个 Agent 是一个 Provider（目录条目 + 差异模块 + 登记 + 契约测试），不支持 ACP 的以进程内垫片接入；本期 Claude Agent、Codex、OpenCode、DeepSeek Harness、Cursor、Google Antigravity（条款禁止第三方用个人 Google 账号登录，只开放 API key / Vertex / Enterprise），ZCode 原计划经私有协议垫片接入，P5 复核后放弃（DEV-008，订阅鉴权须由宿主读取 / 中转凭据；通用 shim 接线保留）；KepCup 不接触订阅凭据；Claude Agent 开发期按启用处理，是否随发行版发布由 `releaseGate` 在发行前决定（见 28） |
| D73 | 连接应用 | 一个连接应用 = 一个 MCP server + 用户的一个账号授权，首选厂商官方远程 MCP + OAuth，本地 MCPB 为补充；授权完全遵循 MCP Authorization（PKCE、RFC 9728/8414/8707/9207，客户端身份按 预注册 → CIMD → DCR(native) → 手填），系统浏览器 + 本机 loopback 回调；令牌只存本机 `secrets`（`conn:{id}:tokens`、`oauth:client:{issuerHash}`），不进 LLM / 界面 / 外部智能体 / KepCup 服务器；Connector→Connection→Grant（`runtime.app_connection_ids`，同一 Bot 同一应用至多一个账号），工具 `app_{slug}_{tool}`；按注解（规范缺省值取严）分级 read 免审 / write 每次确认 / destructive 永远确认，「对该 Bot 总是允许」以 (Bot, Connection, 工具) 为键；工具定义首连展示并哈希锁定防 rug pull；（Bot, 对话）级污点收紧全部外发通道；运行时永不自行发起授权，缺连接 / 过期 / 权限不足走 `{kind:'connect-app'}` 对话内连接卡后 `runs.retry` 续跑；修订 D65（只读免审、autoApprove 不覆盖 destructive）、D41（destructive 不自动批）、D37（新增按 Bot 总是允许）；设置「MCP」并入「应用」分区（目录 / 已连接 / 自定义）（见 29） |
| D74 | 开放平台基座 | 不发明协议：工具 MCP、界面 MCP Apps、用法 Agent Skills、元数据 Registry `server.json`、本地包 MCPB，KepCup 仅加 `_meta["app.kepcup/connector"]`；目录为 MCP Registry 子注册表，客户端消费 Ed25519 签名索引 + 打包快照；分级 builtin / verified / community / developer；服务端统一部署在 Cloudflare（`kepcup.com`；CIMD `https://kepcup.com/oauth/client.json` 用 Static Assets，子注册表 Workers + D1，索引 CI 离线 Ed25519 签名，网关 `workers-oauth-provider` + `createMcpHandler`）；开发者模式、`kepcup-app validate`、提交审核、MCP Apps 渲染与托管授权网关（URL 模式 elicitation，仅用于无法本地直连的平台）后续分期（见 29） |
| D75 | 对话轮与任务分治 | Bot 的一次响应拆为两层：**对话轮**（`loop_type=turn`，秒级、每（Bot,对话）串行、**只读**、固定内置引擎，工具面 = 对话核心 + 只读查询 + `start_task`/`inject_task`/`cancel_task`/`list_tasks` + 异步托管动作）与**任务**（`loop_type=task`，完整工具面、可并行、按对话级与全局封顶）；对话轮**永不等待任务**，任务结算是事件、按宿主确定性条件唤醒下一轮（有结果、失败或中断时唤醒；被取消、结果为空不唤醒）；写操作与长时工作只发生在任务里（执行期校验）；可靠性核心是「每个终态任务的结果至少被对话轮消费一次」——先落盘再启动、先写终态条目（main.db，每任务至多一条、唯一索引幂等）再写任务终态（runs.db，两库不能同事务，启动修复补齐）→ 投递 → 对话轮终态时标记消费；条目即持久化通知、启动对账 + reaper，宁重复不静默；写互斥用租约（租约扩到 workspace 键，同一 workdir 最多一个写任务，只读不限），**git worktree 与 CoW 隔离明确不做**（写用户 `.git` 违反 D31/影子仓库底线、路径门禁锚在单一 `project.path` 致 `denyRead` 失效、检查点回退对不上、新 worktree 缺依赖与未提交改动），只留 `task_workdir` 口子；消息出口按「进度直达、结果经对话轮转述」：任务中间说明直达可见流，任务结果写入 **Bot 私有时间线**并唤醒对话轮，由其转述或 `forward_task_result` 原文转发（不再需要禁止复述 follow-up）；**私有时间线 = 同一张消息表上的 `owner_bot_id` 归属**——Bot 与任务的往返（交代 / 追加 / 取消 / 提问 / 结果 / 失败）记为 `task_event`，只进 owner Bot 的上下文，单聊即 UX、群聊即 GX、不另建列表，所有读路径按视角过滤、对话摘要只摘共享行，现有内部事务保持对话共享；路由必须留痕（任务卡）；「重新执行」= `cancel_task` + `start_task({continues_task_id})`，任务深度 1；修订 D2（注入改为「进入下一轮由 Bot 决定」）、D5（群轮次在对话轮终态推进）、D29（租约扩到 workspace）、D37（「仅这一次」收紧为单次工具调用 + 绝对时限）、D56（自动续接对对话轮关闭，任务间改显式）、D66（`delegate_task` 降为任务内嵌套子代理）、D67（durable 适用对象改为任务）、D72（`runtime.agent` 改为**任务**引擎，对话轮固定内置 → 提示词刷新与 `delegate_task` 两项让渡消失；按 provider 的 steering / `parallelSessions` 降级；无内置模型用户两级降级）（见 30） |
| D76 | 传感器统一管理 | 硬件接入统一为 `sensor`：`kind`（测什么）/ `transport`（怎么接：webmedia 本期，serial/ble/hid/network 预留）/ `dataShape`（stream-audio / stream-video / scalar）三维分开，`packages/shared` 纯数据描述表（写法同 `HOST_CAPABILITIES`）；硬件宿主在渲染层 / 主进程、不在 core，本期零 core / RPC 改动，将来 core 经 Port B 取数据；偏好与启停本期留渲染层 localStorage（`kepcup.sensors.v1`，兼容旧 `kepcup.micDeviceId`）；摄像头默认关、麦克风默认开，启用开关为隐私总闸；本期麦克风做实（权限常驻、测试电平、热插拔、设备丢失显式提示），摄像头只走通硬件（枚举 / 授权 / 设置页预览），不做任何 Bot 侧能力；default session 权限收紧为仅放行自家窗口的 `media`（先审计再落地）（见 31） |
