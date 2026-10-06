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
| D41 | 无人值守模式 | 用户确认危险提示后，所有待确认操作一律自动批准；全局开关，可定时关闭；全程审计 |
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
| D70 | Butler（管家） | 每用户唯一 `system_role='butler'`：置顶、不可删；访谈后 `propose_team` 审批卡 → 确定性批量 `bots.create`；工具 `list_bots` / `propose_bot` / `propose_group` / `suggest_route` / `delegate_to_bot`；未知→管家、单域→直聊、多角色→群、留在本聊→委派；早期先路由卡，「你安排」再委派（见 27） |
| D71 | 跨 Bot 委派 A→B | `delegate_to_bot` / `cancel_delegation` + `delegations` 表；B 收用户代发消息（`origin=delegation`「由 A 代你发出」），UI 留在 A；B 终回复截断~2000 贴回 A 为卡+链接，`notify_me` follow-up 禁止复述；防环（深度/禁 A→B→A/默认单跳）；同群降级 D4 `@`；**不是** D66 SubAgent（见 27） |
