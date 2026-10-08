# 08 Project

## 概念

- Project 是用户选择的一个本地目录，是**用户的工作空间**。Bot 在其中拥有完整的代码编辑能力。
- Project 绑定到对话：在右栏「配置」tab 的 project 选择器（群聊在群信息面板）中选择一个本地目录。一个对话同一时间最多绑定一个 project。
- 选定后，该对话中的**所有 Bot** 都有该目录的读写权限。
- 用户要求 Bot 处理文件时，默认目录就是 project。
- Bot 的 workspace 仍然存在，退回为 Bot 私人的草稿区（临时脚本、中间产物），与 project 区分。

## 实体

```text
Project
  id
  path
  name
  protect_rules      -- 禁止读取 / 写入的文件规则
  status             -- available | missing
  created_at, last_used_at

Conversation
  project_id         -- 当前绑定的 project，可为空
```

- 同一目录只对应一条 Project 记录，可被多个对话选用；选择器中列出最近使用的 project。
- 目录被移动或删除时标记为不可用，并在对话中提示用户重新选择。

## 选择与切换

- 首次为对话选择 project 时，在对话中说明授权范围：该对话中的所有 Bot 都可以读写此目录。
- 切换或取消 project 会在对话中产生一条系统消息（例如“项目已切换为 X”），Bot 可见。
- 有 Bot 正在执行时，不能切换或取消 project。
- 创建期引导：新建 Bot 的初始化访谈在首问作答后、首个响应 run 之前插入「工作目录」一问；新建群在对话内创建流程中最后一问选择群目录。两处都可选「暂不设置」，之后随时用 project 选择器手动绑定。见 [19-work-path-and-group-setup.md](19-work-path-and-group-setup.md)。

## 上下文注入

系统层增加 project 信息：

- project 路径与顶层目录结构摘要
- git 状态（如果是 git 仓库）
- 根目录的 `AGENTS.md` / `CLAUDE.md` 内容（与 Claude Code、Codex 的约定一致）

Bot 的文件工具以 project 为默认工作目录。

## 权限与保护

- 沙箱中 project 目录的挂载方式见 [10-sandbox.md](10-sandbox.md#文件系统规则)。
- 默认保护规则：禁止读取 `.env*`、`*.pem`、`*.key` 等敏感文件；每个 project 可以调整。
- Bot 默认只在 project 与自己的 workspace 中工作；用户要求处理 project 以外的文件时，经授权后可以访问和修改，见 [13-permissions.md](13-permissions.md)。
- `.git/config`、`.git/hooks` 在沙箱内不可写，防止 Bot 植入 git 钩子或篡改远程配置。
- git 远程操作（push / pull / fetch）以及 `git init`、`git remote add` 这类需要改写 git 配置的操作，由核心服务在沙箱外代为执行，**每次都需用户确认**。

## 并发：写入租约

> **D75 修订**：
> - 租约的适用面从 project 扩到 **workspace**（租约键 `ws:{botId}:{conversationId}`）。原先同一对话内的 workspace 并发写由串行 mailbox 兜底，D75 拆分后该兜底消失，改由租约承担：同一 workdir 同时最多一个写任务，只读任务不限。workspace 没有影子仓库检查点，故其写任务被取消时只列出文件工具写过的文件、**不提供整次回退**。
> - 写只发生在**写任务**里：对话轮与只读任务由网关硬拒一切写路径（`RUN_READ_ONLY`），不申请租约。写任务在启动前取 workdir 根的租约并**整个任务持有**（`pin`，与外部智能体的 run 同一语义），等租约期间不占调度名额；下文「写入类工具自动申请」「`acquire_project_write`」仍适用于写任务在其 workdir 之外的写入。
> - 同一 workdir 的第二个写任务在**任务层**排队（停在 submitted，任务卡与状态行显示「等写入租约（任务 … 持有）」），不在租约上等；对它「强制收回」无效，放行方式是取消持有方任务。强制收回只对租约层的等待（被非任务持有者挡住）出现（待确认，见 DEV-015）。
>
> 见 [30 §5](30-supervisor-and-tasks.md#5-并发与写互斥)。

多个 loop（同群的多个 Bot，或选用同一目录的多个对话）可能同时要修改同一个 project。

- 同一 project 同一时刻**只有一个 loop 持有写入租约**；其他 loop 可以读。
- 写入类工具（write、edit）自动申请租约。
- 未持有租约的 loop，沙箱中的 project 为只读；需要执行会改动文件的命令（例如安装依赖、格式化）时，先调用 `acquire_project_write()` 申请租约。
- 租约被占用时排队等待，对话中显示“等待 X 完成对项目的修改”。
- 租约在 loop 结束、中断或取消时释放；用户可以在界面中强制收回。
- 租约按目录生效，跨对话共用。
- 每个 loop 最多持有一个租约，不存在死锁。

## 过期检测

- 文件工具在读取时记录文件哈希，写入前比对。
- 文件在读取后被改动过（例如用户在自己的编辑器里改了），写入失败，要求 Bot 重新读取。

## 检查点与回退

Bot 修改的是用户的真实文件，必须可以撤销。

- 每个 project 在应用数据目录中有一个**影子 git 仓库**，不触碰项目自身的 `.git`。
- 在 loop 获得写入租约时，对工作区做一次快照；释放租约时再做一次。两次快照之差就是这次执行的全部改动（包括命令行造成的改动）。
- 快照遵循项目的 `.gitignore`，跳过 `node_modules` 等目录。
- 执行结束后，Bot 的消息附带**改动摘要卡片**：修改的文件列表、查看 diff、整次回退。
- 回退前检查冲突：如果涉及的文件在之后又被修改，提示用户确认。
- 检查点只保留最近一段时间（保留策略待定参数）。

## 删除

- 删除对话、删除 Bot 都不影响 project 目录中的文件。
- 用户从最近列表中移除某个 project 时，删除其 Project 记录与检查点。

## Windows

- project 目录**实时挂载**进 WSL2 私有发行版，只挂载 project 目录本身，不自动挂载整个 C 盘。
- 已知代价：大项目中 git、npm 等操作可能明显变慢。
