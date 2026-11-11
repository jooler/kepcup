# D123 并行写任务:交接说明

## 你要做什么

在 KepCup 仓库(`/Users/pengfeilee/www/kepcup`)实现 **D123 并行写任务与任务间协调**,按已定稿的执行方案分 W1–W7 七期推进,每期独立可交付。

## 已完成,不要重写

以下文档**已定稿**,是唯一依据(代码尚未动过一行):

- 设计:`docs/design/59-parallel-tasks-and-coordination.md`(D123)
- 执行方案:`todo/parallel-tasks-and-coordination.md`——契约、文件归属、逐波验收与定向测试命令全在里面
- 关联修订:`docs/design/30-supervisor-and-tasks.md`(§5 / §9.3 / §2.2 / §2.4.5 共 8 处 D123 修订)、`08-workdir.md`(租约粒度)、`02-execution.md`(执行模型表 + 写互斥节)、`README.md`(索引行 59 + D123 决策记录)

设计已定稿,不要重新讨论设计决策。

## 开工前必做

1. `git status`——上述 6 个文档改动**可能仍未提交**。先确认/提交(`docs(design): 新增 D123 并行写任务设计`)再动代码;未提交就开工会让后续 diff 混在一起。
2. 读:`AGENTS.md`(测试策略:先定向、后全量)、`docs/dev/01-conventions.md`、设计 59 全文、执行方案全文。
3. 实测 runs 迁移最大号(`ls packages/core/migrations/runs/`),确认下一空号是文档写的 `0015`,不是就以目录实况为准。
4. 建议在新分支上推进,不要直接在 `heads/v0.5.10` 上改。

## 推进顺序

```
W1 写域地基 → W2 调度与租约 → W3 执行期强制 ┃ W4 任务间协调(可与 W3 并行)
             → W5 认领 → W6 提示词与界面 → W7 收口
```

单人顺序推进即可。每波做完只跑该波「验收」里给的定向命令;全量 `pnpm test` 只在 W7 跑一次。

## 三个已标记的坑(细节见执行方案 §2.5 / §2.6)

1. `leaseKeysConflict` 在 `LeaseService` 内部**三处**调用(L63 / L161 / L204)都要走注入谓词;`SlotYieldingLeaseService extends LeaseService`,构造必须透传 `conflict`——漏了会让调度器实例静默退回前缀规则,测试也不报错。
2. `ensureWriteLease` 有**四个**调用点,只有 `orchestrator.ts:3729`(任务钉住)换成域键;其余三处(`orchestrator.ts:3630`、`gateway/index.ts:605`、`tools/index.ts:847`)保持整根键,行为不变。
3. 唯一允许的可见行为差异是排队原因文案(「等写入租约(任务 … 持有)」→「等写域(任务 … 持有 …)」);既有测试断言的更新范围已在执行方案 §2.6 列出,别漏。

## 红线

- `writes: true` 的写任务与只读任务,行为必须与改动前逐字节一致(文案除外)。
- glob 相交判定**保守化**:判不了即判冲突。假阴性禁止,假阳性可接受。
- 越域不提供运行期扩域,一律 `ask_user` 回对话轮改派。
- 设计与代码冲突 → 写 `docs/dev/DEVIATIONS.md`(新号顺延)并停下受影响部分,不改设计决策。
- 代码/标识符/注释英文;界面文案 `zh-CN` 与 `en-US` 同时补齐。

## 不要顺手改

`docs/design/README.md` 有两处**既有缺口**(与 D123 无关):design/58 未进索引表、D122 未登记决策记录。留给用户决定,不要在本任务里补。

## 完成定义

W1–W7 全部落地;全量测试失败集合与既有基线一致(不新增失败);typecheck / lint 0 error;执行方案 §6「实施记录」补齐提交列表、验证证据与偏差。

## 一句话起手

> 读 `todo/parallel-tasks-and-coordination.md` 与 `docs/design/59-parallel-tasks-and-coordination.md`,按 W1 开始实现 D123;先 `git status` 确认那 6 个文档改动是否已提交。
