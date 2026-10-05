# 开发指导

本目录用于驱动开发（包括由编程代理执行开发）。每个阶段文档都是一份可以独立交付的任务说明：目标、范围、任务、接口、测试、验收标准。

## 文档结构

| 文档 | 内容 | 何时阅读 |
|---|---|---|
| [01-conventions.md](01-conventions.md) | 仓库结构、技术栈与版本、编码规范、命名、日志、错误处理 | 开始任何工作之前，必读 |
| [02-architecture.md](02-architecture.md) | 进程与模块划分、进程间通信、核心服务内部模块与接口、一条消息的完整链路、执行（Run）状态机 | 开始任何工作之前，必读 |
| [03-data-model.md](03-data-model.md) | 三类数据库的完整表结构、迁移规则、删除级联表 | 涉及数据的任务 |
| [04-agent-runtime.md](04-agent-runtime.md) | pi 的封装方式、上下文组装、工具目录与规范、各类提示词与结构化输出 | 涉及 loop、工具、提示词的任务 |
| [05-testing.md](05-testing.md) | 测试分层、模拟模型服务、端到端测试、平台测试、CI 矩阵 | 所有阶段 |
| [phases/](phases/) | 分阶段开发计划，每个阶段一份文档 | 执行对应阶段时 |
| [PROGRESS.md](PROGRESS.md) | 阶段进度与验收记录 | 每个阶段开始与结束时更新 |
| [DEVIATIONS.md](DEVIATIONS.md) | 偏差与待确认问题 | 发现问题时记录 |

## 阶段总览

| 阶段 | 名称 | 依赖 |
|---|---|---|
| [P00](phases/P00-scaffold.md) | 工程骨架与基础设施 | — |
| [P01](phases/P01-direct-chat.md) | 单聊最小闭环 | P00 |
| [P02](phases/P02-sandbox-and-tools.md) | 沙箱与编码工具 | P01 |
| [P03](phases/P03-permissions.md) | 授权与确认体系 | P02 |
| [P04](phases/P04-project.md) | Project | P03 |
| [P05](phases/P05-group-chat.md) | 群聊 | P01（建议在 P04 之后） |
| [P06](phases/P06-environment.md) | 环境管理器 | P03 |
| [P07](phases/P07-memory.md) | 记忆与用户画像 | P05、P06 |
| [P08](phases/P08-skills.md) | Skills | P06、P07 |
| [P09](phases/P09-wiki.md) | Wiki | P07 |
| [P10](phases/P10-proactive.md) | 主动消息与调度 | P07 |
| [P11](phases/P11-browser.md) | 浏览器工具 | P04 |
| [P12](phases/P12-windows-and-enhanced-sandbox.md) | Windows WSL2 与增强沙箱 | P04、P06 |
| [P13](phases/P13-release.md) | 打包发布与首次启动 | 全部 |
| [P14](phases/P14-interactive-exec.md) | 命令行交互执行 | P02、P03 |
| [P15](phases/P15-inline-setup.md) | 对话内设置引导 | P01、P13 |
| [P16](phases/P16-path-and-group-setup.md) | 对话工作路径与群创建 | P04、P05、P15 |
| [P17](phases/P17-conversation-media.md) | 对话附件与媒体 | P01、P15 |
| [P18](phases/P18-web-search.md) | 联网检索工具 | P15 |
| [P19](phases/P19-file-skill-routing.md) | 文件技能路由 | P08、P17、P18 |

阶段严格按依赖顺序执行。无依赖关系的阶段可以并行，但同一时间修改同一模块的阶段不要并行。

## 执行规则（给执行代理）

### 开始一个阶段前

1. 阅读本文件、[01-conventions.md](01-conventions.md)、[02-architecture.md](02-architecture.md)。
2. 阅读阶段文档，以及其中“设计依据”列出的 `design/` 文档章节。
3. 确认所有依赖阶段在 [PROGRESS.md](PROGRESS.md) 中已标记为“已验收”。
4. 在 [PROGRESS.md](PROGRESS.md) 中把本阶段标记为“进行中”。

### 执行中

- **只做阶段文档“范围”中列出的内容**。“不包含”中列出的内容即使顺手也不要做。
- 阶段文档没有写明的细节，按以下顺序确定：`design/` 文档 → `dev/` 的 01～05 → 与现有代码保持一致 → 最简单且不妨碍后续阶段的做法。仍无法确定时，按下文“偏差与问题”处理。
- 不修改 `design/` 中已定的决策。
- 依赖版本全部锁定为精确版本（不使用 `^`、`~`）。
- 新增数据时，同步维护 [03-data-model.md](03-data-model.md#删除级联) 中的删除级联：每个阶段引入的数据，必须在该阶段内接入对话删除、Bot 删除、群成员移除的清理逻辑。
- 界面组件优先使用 shadcn-svelte CLI 添加的组件及 [design/09-tech-stack.md](../design/09-tech-stack.md#前端) 中列出的库，不手写已有的组件。
- 阶段文档中标注“需验证”的技术点，先写最小验证代码确认可行，再展开实现；验证结论写入该阶段在 PROGRESS.md 中的记录。

### 结束一个阶段

1. 逐条核对阶段文档中的验收标准，全部满足。
2. 本阶段要求的自动化测试全部通过；CI 在要求的平台上通过。
3. 在 [PROGRESS.md](PROGRESS.md) 中逐条记录验收结果（通过的证据：测试名称、截图路径或手工验证步骤）。
4. 如有偏差，确认已记录在 [DEVIATIONS.md](DEVIATIONS.md)。
5. 把本阶段标记为“待验收”，由人工确认后改为“已验收”。

## 偏差与问题

遇到以下情况，**停止相关部分的实现**，在 [DEVIATIONS.md](DEVIATIONS.md) 中记录，然后继续不受影响的部分：

- 设计与技术现实冲突（例如某个库不支持文档假设的能力）。
- 阶段文档与 `design/` 文档不一致。
- 验收标准无法达成。
- 需要引入文档未列出的新依赖（小型工具库除外，见 [01-conventions.md](01-conventions.md#依赖管理)）。

记录内容：问题、影响范围、可选方案及推荐、是否阻塞。由人工决定后，更新相应文档，再继续。
