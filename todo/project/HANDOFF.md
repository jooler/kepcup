# 项目组迁移 · 交接文档（HANDOFF）

> 写于 2026-10-18。本文件是「群聊→项目组」迁移的**进度与续作交接**，配合 [README.md](README.md)（任务书，规则与固定契约 §4 仍然全部有效）使用。新会话从本文件起步。

## 1. 一句话现状

**T1a 已收口**（WP8 审查通过）。11 个 WP 中仅剩 **WP10（wiki-surface，T1b 收口，跑全量）→ WP11（docs-sync）**，其余全部完成并经阶段审查修复，汇入集成分支 `feat/project/migration`（HEAD `3c567d3`）。每提交可构建；T1a 收口全量 `pnpm test`：**5526 通过 / 0 失败 / 23 skip**（不超基线）；e2e 新增/改名/改写 spec 全绿（workbench 1 例败者为 WP8 前即存在的环境项，已实证）。

## 2. 分支与提交拓扑

- 集成分支：`feat/project/migration`（未 push，合入 main 由用户决定）。
- 线性史（旧→新）：`5d9e933` 任务书 → WP0-1 `120374f` → WP0-2 `f162702` → 审查 `448fd6c` → WP1 `8926bd7`/`ea36bf8`/`9f1e98a`/审查 `b896b0a` → WP2 `d724a07`/`0e1d88d` → WP3 `dcdaeaa`/`c5c60a3` → WP9（分支合入）`596a834` → C1+D 审查 `050a01a` → WP4 `e7013fa`/`748d63d`/`f86e3b1` → WP5（分支合入）`6f42e49` → 交接文档 `f385f61` → WP6 `406c962`/`51c6d53`/`6c7ee28`/`f2a777a` → 审查 `08ef7b8`/`84b6c86` → 交接文档 `9eaec88` → WP7 `8909675`/`f93b8f9`/`943b342`/`f6c747d`/`054451d`/`9d47aac`/`cda8dca`/`c20feb2` → 审查 `aea4559` → 交接文档 `9449dba` → WP8 `ffea525`/`adb1941`/`8916aa4`/`dc96550`/`6ddbf86`/`7f84790`/`ed2808f`/`c6b15b6`/`0cf42cc`/`6d1ebe7`/`517c8c1`/`d4a90e8` → 审查 `cc9c1f2`/`3c567d3`。
- 边界指针（只读锚点，便于 diff/回溯）：`feat/project/wp0-1`、`wp0-2`、`wp1`、`wp2-episodes`、`wp3-routing`、`wp9-wiki-merged`(=596a834)、`wp4-integrations`、`wp5-ui-create`(=wp5-ui-create-done, 已合入)。
- worktree：`/Users/pengfeilee/www/kepcup-wp9`（分支 wp9-wiki-core，已合入）、`/Users/pengfeilee/www/kepcup-wp5`（分支 wp5-ui-create，已合入）。两处工作区干净，可 `git worktree remove` 回收；后续并行 WP（建议 WP6 与 WP7 前置核对期）可照此再开。
- stash 仅 1 条：`recovered: external workbench seam stash`——**别的会话**（ci/e2e-flaky-fixes）的 workbench 在途工作保险副本，与其自有提交 `006078ae` 冗余，**不要 pop 到本分支**，保留或交还原会话。（WP7 期间被执行代理误 pop 过一次，已原样重新 push 回 stash：消息与内容一致，底层 hash 有变。）

## 3. 已完成 WP 与审查结论

| WP | 内容 | 收口提交 | 审查 |
|---|---|---|---|
| WP0-1 | workdir→cwd 纯改名 + 迁移 runs 0013 | `120374f`…`576bc39` | 通过（修 6 处文档级漏项 `448fd6c`） |
| WP0-2 | 目录 project→workdir 纯改名 + 迁移 main 0038 + `08-project.md`→`08-workdir.md` | `f162702`…`667a708` | 通过（并入上条修复） |
| WP1 | shared 契约 + 迁移 0039/0040（FK 关闭指令运行器）+ ProjectsService + projects.* RPC + 删 D60 群后端 + project-modules.ts | `8926bd7`…`9f1e98a` | 通过（补全 isGroup→isProject 残留 `b896b0a`；历史重排保证每提交可构建） |
| WP2 | chains→episodes + 迁移 main 0041/runs 0014 + 熔断 12/8 + 暂停卡 + episodes.get/resume/stop | `d724a07`/`0e1d88d` | 通过（联合审查） |
| WP3 | ProjectTurnCoordinator：续接判断/负责人网关/静默路由/必答兜底 + project.turn | `dcdaeaa`/`c5c60a3` | 通过（修 WP3 任务书正文被覆盖事故 `050a01a`） |
| WP9 | wiki 后端 owner 泛化/项目级索引/台账/ACL/维护身份（独立分支并行开发后合入） | `a32afff`/`ab58b5f`/`5b0ba1d` | 通过（联合审查含合并质量） |
| WP4 | 提示词规则/propose_project、propose_bots、suggest_route/工作台/设置目录四卡/迁移 main 0042+memory 0003/'group' 残留清零 | `e7013fa`/`748d63d`/`f86e3b1` | 通过（零问题） |
| WP5 | 双轮创建 UI（先负责人后成员）+ ProjectComposeBar + store 契约 §4.11 | `0f3ec73`/`b4511d6` | 通过（零问题） |
| WP6 | 项目组外壳：两行实心顶栏/模块 tab/成员弹层/撤右栏/侧栏改名/`ProjectAvatarStack`/过渡壳详情页 + 深链改走 `openProjectSettings` | `406c962`/`51c6d53`/`6c7ee28`/`f2a777a` | 通过（修 ChatsArea 缩进 `08ef7b8` + 实施记录勘误 `84b6c86`；纯改名提交夹带过渡态行为变化已备案不重写历史） |
| WP7 | 真实详情页五分区 + `ProjectMembersEditor`/`ProjectMemberPicker` + 四设置卡内嵌与深链 + 删 GroupInfo/GroupSettingsDialog + 删 Bot 阻止负责人 | `8909675`/`f93b8f9`/`943b342`/`f6c747d`/`054451d`/`9d47aac`/`cda8dca`/`c20feb2` | 通过（补记 DEV-035 `aea4559`；代码零缺陷） |
| WP8 | 文案收尾 + 协作暂停卡 + 审批卡负责人下拉 + 路由卡改名 + `KEPCUP_TEST_EPISODE_LIMITS` 测试缝 + e2e 全面重写（project-chat/compose/shell/routing、episode-breaker 新增，7 个既有 spec 适配）——**T1a 收口** | `ffea525`…`d4a90e8`（12 个） | 通过（修 lint 死变量 `cc9c1f2`、补记 DEV-036 `3c567d3`；全量 5526/0/23） |

各 WP 细节、测试清单、表外命名登记均在各任务书文件末尾「实施记录」。

## 4. 剩余工作与建议执行序

依赖（README §3）现状：WP10 依赖全部就绪（WP9✓/WP6✓/WP4✓/WP7✓/WP8✓），可开工；WP11 等 WP10。

1. **WP10（wiki-surface，T1b 收口）**：wiki_search/read/enqueue/remove_source 工具暴露、Wiki tab 真实视图（替换 WP6 的 ModulePlaceholder）、删除确认框补 wiki 来源数 / 页面数（WP7 顺延）；testid 自行定义并列全；补跑 WP9 登记未跑的 e2e（wiki.spec/handover.spec 入参已改）。**收口跑全量**。
2. **WP11（docs-sync）**：01-conventions 常量表全面同步（多 WP 顺手做了部分）、docs/design 各文件 D92 横幅清理与正文改写（41 号定稿为正文）、README §7 收尾、ID 表。注意 `docs/design/40-capability-mounting.md`、`todo/supervisor-and-tasks.md` 等旧措辞（WP0-1 实施记录登记过）；WP8 审查顺延的 `groupMentionOnly` 旧名文档残留（`docs/dev/03-data-model.md`、`04-agent-runtime.md`、`design/28`、`todo/acp-external-agents.md`）。

## 5. 已登记偏差（docs/dev/DEVIATIONS.md）

- **DEV-031**（WP3）：forcedTarget 分支按 WP 字面保留并加可选入参使其可测（生产无调用方）。
- **DEV-032**（WP9）：验收 rg 自检 3 处命中核对为预期（enqueueIngest 执行者字段等）。
- **DEV-033**（WP4）：验收 rg 剩余 13 处 = 审批卡 testid / GroupSettingsDialog 锚点 / linear.tools.json 外部字段 / 0042 夹具，归 WP7/WP8。
- **DEV-034**（WP5）：rg 自检按「src 零残留」解读（原命令排除模式罩不住 test/e2e），命中全为 WP8 顺延项。
- **DEV-035**（WP7）：`group-members.ts`→`project-members.ts` 的 `git mv` 无从执行（文件已被 WP4 改名，仅剩导出名），以纯改名独立提交 `f6c747d` 收口，最终命名契约全达成。
- **DEV-036**（WP8）：`ProjectTurnStatusLine` 路由阶段可见性修正（WP 字面只写改名，原渲染条件使「正在确认由谁回复」永不显示，路由阶段恰为 `currentBotId=null`、`queue=[]`）。

后续编号从 **DEV-037** 起。

## 6. 执行方式（本线已验证有效的协议）

- **派发**：执行代理必读顺序 = README §1/§4 → 本 WP 任务书（含前序实施记录）→ 设计稿 41 → AGENTS.md/01/05-conventions；汇报限 40 行含提交/测试/偏差/遗留。名字以 §4 为准一个字母不改；「每提交可构建」；半成品无法拆分时允许合成一个提交并说明。
- **并行**：git worktree + 独立分支（`pnpm install` 秒级），合入用专门合并代理：`--no-ff`、「两边都保留」、重跑 typecheck+定向，README §6 顺序。
- **审查**：每阶段一个审查代理，范围 `git diff 上审查点..当前`，P0 契约逐项/残留 rg/测试非空壳/清账核对；发现任何级别直接修复提交。
- **中断协议（上游 5h 限额）**：代理收到限额错误先 commit WIP 再退出；总调度对未提交遗留做 `git stash push -u` + `git stash apply` 双保险快照（注意 stash 重号陷阱：drop 会重排索引，逐条按消息核对再 drop），重派时让新代理「核对→保留/修正→补齐→收口」——WP2/WP3/WP4/WP5 四次接力均成功。
- **全量纪律**：仅 WP 收口/合入质疑时跑一次；基线失败集合见 docs/dev/05-testing.md 与 PROGRESS.md；负载偶发项单跑复核。

## 7. 快速命令

```bash
git -C /Users/pengfeilee/www/kepcup log --oneline -5        # 现场核对
node scripts/run-tests.mjs run --project desktop            # desktop 定向
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck && pnpm lint
pnpm build && pnpm --filter @kepcup/desktop test:e2e test/e2e/<spec>.spec.ts   # e2e 先构建
```
