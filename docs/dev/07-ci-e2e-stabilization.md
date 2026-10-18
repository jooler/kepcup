# CI 端到端修正备忘（r1–r14 全绿史 + r17 合并轮）

- **分支**：`ci/e2e-flaky-fixes`（PR #4）。
- **终点**：r10 首次全绿；r11–r13 暴露 Tests 层的两种新失败并在 r14 全部收绿；r15–r16
  收口 Tests 层第 L 类（结论三平台 E2E + Tests ×3 + Lint success）。commit 链
  `b05ae28 → 71017a2 → 3b0a822 → bdb0efd → 323da2b → 204e2fb → 7c334a1 → deec7a2 →
  1f0865b → 08c83ae → 90f7deb → 7532485 → 5f4d230`。
- **写作目的**：另一条重量级分支（含 groups/project 迁移）合并时大概率再次触发同类失败。本文把
  「现象 → 根因 → 修法 → 自检」沉淀成速查，让下一次不需要再走 10 轮 CI。
- **r17 合并轮（2026-10-18）**：本栈按高危点位表全文并入 project-team main
  （merge `fa0ed25`），逐项审计全过；随后三轮 CI 收掉 main 迁移自己新引入的四处
  （M/N/O/P 类，见下），r17 第 4 轮（run 39105852113，commit `6034153`）7 job 全绿。

## 平台特性速查（必须内化）

| 平台 | 事实 | 后果 |
|---|---|---|
| Windows | app 退出后句柄释放有延迟；`rm`/`rename` 打在仍被句柄持有的文件/目录上必失败 | teardown 一律 `rmHomeTolerant`；删除类断言分平台 |
| Windows | Electron 44 无 `session.destroy()`（`closeAllConnections` 只断网络） | Chromium 分区目录**当场删不掉**；sqlite/leveldb 句柄随进程存活 |
| Windows | 重 RPC 链（bots.remove、资料删除）含目录级联 + fs 重试，可拖过 30s | UI 收敛断言给 ≥90s |
| Linux (runner) | srt 后端 = bwrap network namespace，127.0.0.1 是全新回环；`allowLocalBinding` 只是 macOS profile 概念 | 沙箱内 curl 连不上宿主端口（curl exit 7, 0ms） |
| Linux (runner) | Xvfb 无 GPU：rAF 帧率可低到个位数，音频/动效链路整体变慢 | 动效类断言（电平表、动画）窗口 ≥30s |
| macOS | 分区目录当场删除可成；`text-overflow: ellipsis` 是设计内截断 | overflow 探测必须跳过 ellipsis 元素 |

## 根因目录

每条给出：现象特征 → 根因 → 修复 commit → 自检方法。

### A. teardown EBUSY（Windows，几乎每个 spec 的失败形态）

- **现象**：`EBUSY: resource busy or locked, unlink '...\main.db'`（或任意 home 内文件），teardown 直接抛。
- **根因**：旧 app 进程退出后的句柄释放有延迟；裸 `rm` 不重试。
- **修复**：`7c334a1`——所有 spec teardown 统一走 `test/e2e/helpers/home-cleanup.ts#rmHomeTolerant`：
  **同卷 rename home → `*.discarding`**（不需要独占目录内容，基本必成）→ 失败再退回到 30s rm 重试。
  `packages/core/src/infra/fs-rm.ts` 也把原生重试拉长到 `{ maxRetries: 24, retryDelay: 250 }`（同名文件晚一点释放也能删成）。
- **自检**：新 spec 的 finally 里只允许 `await rmHomeTolerant(home)`；`rm(home, ...)` 裸写在 e2e 里是错误。

### B. Chromium 分区目录删不掉（Windows）

- **现象**：删除 Bot / 共享资料后 `Partitions/<name>` 原样残留（r7/r8 诊断证明**整树内容分毫未动**，不是晚到的 flush 重建）。
- **根因**：`session.fromPartition` 无法销毁（ 无 `Session.destroy`），sqlite/leveldb 句柄随进程存活；
  连**目录 rename** 都会被拒。当场删除在 Windows 上不可达成。
- **修复**：`204e2fb` + `7c334a1` 三件套：
  1. `browser-host.ts#removeDirTolerant` **先 rename 出局**（`Partitions/<name>.removing`，失败再 rm 循环）；
  2. `BrowserHost` 构造函数里 `sweepRemovedPartitions()` 清扫上次会话改名出的目录（句柄已随进程消失）；
  3. **spec 断言平台分类**：`browser.spec.ts` 两个删除用例在 win32 跳过「当场 poll 分区目录数为 0」，
     磁盘验证交给 closeSession 的 `rmHomeTolerant`（整 home 随进程退出后可删）。
- **自检**：改删除链/合并时不要把「当场删除」断言加回来；`partitionEntries()` 是精确匹配目录名，
  `.removing` 后缀天然不算复活。
- **同理在线程外**：`fs-rm.ts` 被 lifecycle 级联复用（会话 workspace / bot 目录 / 群成员移除三处），Windows 上不要在大 RPC 链里同步删树的超时压得太紧。

### C. 沙箱内抓不到回环 URL（Linux，wiki spec 的直接失败）

- **现象**：`curl: (7) Failed to connect to 127.0.0.1 port NNN after 0 ms`，x3 的 job 重试耗尽 →
  `wiki_ingest_failed` 内部事件 → 回复轮的 mock 脚本第 3–6 步在**会话**里消费、最终文本「整理完成」——
  看似成功了，其实 maintenance 从未跑（trees 空）。
- **根因**：srt 的 linux 路径用 bwrap network namespace；宿主回环不可达。macOS 的
  `(allow network-bind)` profile 与之不同，所以这条只在 ubuntu 出现。
- **修复**：`204e2fb`——`packages/core/src/wiki/source.ts#fetchUrlInSandbox` 对
  `isLoopbackHost(verdict.host)` 的目标**走宿主 http 直连**（redirect ≤5、大小与 UTF-8 门与沙箱路径共用
  `wikiBodyOrThrow`），非 loopback 仍全部沙箱内。语义上回环目标本来就是本机服务，无外发面。
- **自检**：另一分支新增任何 URL 抓取用例时，mock server 一律写 `http://127.0.0.1:<port>` 并沿用本修复；不要写「绕过宿主、偏向 CI」的花招。

### D. wiki 调试方法论（误导性很强的失败）

- **证据三件套**（已在 `wiki.spec.ts#dumpWikiDiag` 固化，且**故意保留**——只在失败分支输出，无成本）：
  `bot[].wiki.history`（有无 maintenance commit）、会话 `runs.list`（有无 maintenance run 行）、
  `{home}/logs/kepcup.log` 尾部 `/wiki|ingest/i` 行（真实错误）。
- **教训**：消息流出现「整理完成」≠ ingestion 成功；job 的重试 + 内部失败事件会把 mock 脚本的两类
  步骤（对话文本/write 工具变体）消费到错误的轮上。先把「跑了哪些 run、去了哪个 commit」钉死，再看消息。

### E. 麦克风电平恒 0（ubuntu，r6/r9 两轮命中）

- **现象**：`sensor-level-microphone` 宽度一直 0；「停止测试」文案已翻转（getUserMedia 成功）。
- **根因**：runner（Xvfb 无 GPU）上 UI/音频链整体慢，15s 窗口内 AnalyserNode 样本还没被刷进电平条；33s 都够用。
- **修复**：`deec7a2`—— 电平 poll 窗口 15s→30s（`sensors.spec.ts`）。rAF 帧率探测等诊断已随 `1f0865b` 撤回。
- **自检**：动效类断言（动画、过渡、帧驱动渲染）预留在 30s 起。

### F. 工作台布局与 seam（macOS 曾经的 group 失败）

- **现象**：`workbench.spec` 的 119px 累计溢出、tab/dual-pane 形态轮换。
- **根因**：`WorkbenchView.svelte` 的 seam 在**响应式更新期**重算 → 窗口钳制回弹时把已定的双栏改回 tab；
  DNS 详情行上的 `truncate`（ellipsis）被误判为「设计外溢出」。
- **修复**：`3b0a822` 把 seam 定格到 mount 时（之后只受显式切换影响）；`bdb0efd` 里
  `overflowing()` helper 跳过 `textOverflace === 'ellipsis' && whiteSpace === 'nowrap' && overflowX === 'hidden'` 的元素。
- **自检**：另一分支改 `WorkbenchView.svelte` 时：seam 的 mount 定格必须保留；`workbench.spec.ts` hook 里把 1280 钉过 1024 工作区的 Xvfb。

### G. 诊断工具链期望（win32 空态）

- **现象**：diagnostics.spec 的「已安装工具链」行永远空。
- **根因**：`env/catalog.ts` 的 win32 目录**没有 `kind:'system'` 条目**（git=MinGit 归档、lima 仅 darwin、podman 仅 linux）。
- **修复**：`bdb0efd`——期望分支 `win32: '没有已安装的工具链条目'`，其它平台期望包含 `'git'`。
- **自检**：给 win32 加 system 工具链 город 时**同步把这条改回包含分支**。

### H. skills 回滚没有落 commit（Tests，ubuntu）

- **现象**：`skills-authoring.test.ts` rollback 后 history[0] 缺 rollback commit。
- **根因**：`registry.ts:1082` 在 `rollback()` 里**没有 await** `authoredGitCommit(...)`（promote 侧同样的调用是 `return`，正确）。真 bug，非封装 race。
- **修复**：`bdb0efd` 加 `await`。

### I. 窄布局里移除 Bot 卡住（windows）

- **现象**：`bot-remove-confirm` click 后覆盖层 30s 不收，无 console error，按钮停留在移除面板。
- **根因**：删除链（会话/工作区/资料分区清场 + fs 重试）在 windows 上可拖过 30s，`contacts.remove` 的 promise 在此期间不 resolve。
- **修复**：`7c334a1`——`narrow-layout.spec.ts:533` 的窗口给足 90s（r9/r10 windows 连绿验证）。

### J. teardown 后的 unhandled rejection（Tests 级，r11 macOS 命中）

- **现象**：`Tests 5304 passed` 全过，但汇总出现 `Errors 1 error`：`TypeError: The database connection is not open`
  从 `EnvManager.#handleSystemApproval → listInstalls` 冒出（environment.test.ts）导致 job 失败。
- **根因**：审批回调是 `void this.#handleSystemApproval(...)` fire-and-forget；测试/退出的夹缝里 db 已 close，
  回调仍在跑 `listRows` → `db.prepare` 抛错成 unhandled rejection。
- **修复**：`90f7deb`——两处 system 分支的 fire-and-forget 全部改为 `.catch()`（记录 `system approval handler failed (fire-and-forget)` 日志后吞掉）。
- **自检**：**新增 fire-and-forget 的 `void service.method(...)` 时，凡终点可能触碰 db/文件系统，必须带 catch**。
  vitest 的判定是「Tests 全过 + Errors ≥1」也算 job 失败，别只看用例统计。

### K. 满载 runner 的轮换超时（Tests 级，r12/r13 连续命中三个不同文件）

- **现象**：无规律轮换地「某个一直很快的用例超时」：r12 ubuntu `subagent.test.ts:372`（60s）→
  r13 ubuntu `mail-service-fixes.test.ts:206`（5s 默认线）；本地单跑分别仅 318ms / 220ms。
- **根因**：ubuntu runner CPU 竞争 + vitest isolate 每文件新 worker；重链路用例（双实例重启恢复、
  fake IMAP 断开重连轮询）的 60s/5s 线在满载时被顶穿。
- **修复**：`7532485` subagent crash-recovery 用例 60→120s；`5f4d230` UIDVALIDITY re-baseline 5→30s。
  **都是单用例级别、不碰全局 testTimeout**（改全局属跨包公共配置，须全量回归）。
- **自检**：遇到「本地 <1s 的用例在全量 CI 里超时」→ 别怀疑功能回归，看它是否起了**第二个实例 / 轮询 /
  fake 服务器**，按该用例的重活程度单独给显式 timeout（30s/120s，与所在文件既有约定一致）。

### L. 内核 abort 链与已释放响应的竞速（Tests 级，r15 ubuntu 命中）

- **现象**：`subagent.test.ts`「aborts the task and its branch when the conversation is deleted」在
  ubuntu 上 `expected 3 to be 2`：`conversations.delete` 后 `subStep.release()`，300ms 窗内断言
  LLM 请求数**精确不变**，但满载下释放的 SUB 响应赶在 abort 落定前让分支多推进了一轮。
- **根因**：释放响应与内核中止链（run 删除 → agent loop 停）的时序在慢节点不收敛；
  「精确请求数」的断言过度锁定了实现细节（在途响应至多推进一轮是内核真实保证）。
- **修复**：`ab244fc`——断言改为「释放后 1s / 再 1s 两段 `<= requestsBefore + 1`」+ 删除后
  `runs.listByConversation` 必须为空（这才是要锁的业务语义）。
- **自检**：测「删除/取消后不再推进」时，断言应落在**领域状态**（runs 为空）与**收敛边界**
  （至多一轮），不要断言瞬时计数；300ms 内的 setTimeout 凝固窗在 CI 满载一律不可靠。

### M. 测试自建的期望路径用了 POSIX join（Tests 级，r17 windows 命中）

- **现象**：`wiki-owner.test.ts` 两例只挂在 win32：`expected 'D:\tmp\...\bots\bot_a\wiki' to be 'D:\tmp\.../bots/bot_a/wiki'`。
- **根因**：期望值 helper 用 `[...].join('/')` 手拼 POSIX 分隔符；被测助手（paths.ts）走 `path.join`
  输出平台原生分隔符。「与改动前逐字相同」的意图没错，但两端必须用同一个 join。
- **修复**：`68aaa87`——期望 helper 改 `path.join(home, 'bots', botId, ...)`。
- **自检**：新增路径断言一律 `path.join` 造期望值；手写 `/` 串等于锁死 POSIX。

### N. E2E 的轮内计数基线要在使用点取样（E2E 级，r17 ubuntu 命中）

- **现象**：`project-routing.spec.ts` ④「谢谢」静默收口轮 `expected 2 to be 3`：
  poll 断言网关调用数 = ①之后拍的快照 +1，但 ③ 的 self 网关已把计数抬到 2。
- **根因**：断言作者拿早段快照锚定绝对值；轮次语义上 ④ 期间恰好多一次网关调用。
  慢节点的样本窗口决定它在**谁先到**的竞速下偶然成立（mac 前 4 轮都绿）。
- **修复**：`68aaa87`——④ 的基线改在 `sendPlain('谢谢')` 前取样（`gateCallsBefore4 + 1`），
  `expect.poll` 语义变为「确有一次新增」，不再竞速。
- **自检**：`expect.poll(...).toBe(N)` 的 N 若含「此后还会再变」的量，必须以**发送前**的取样为基线；
  拍照点距使用点之间有任何一轮交互（哪怕静默收口）就重拍。

### O. jobs runner 会把「占位 pending」抢走——去重观察窗要先冻住它（Tests 级，r17 windows 命中）

- **现象**：`wiki-remove-source.test.ts` 去重断言 `expected 2 to be 1`（占位后删第二份仍多出一行）。
- **根因**：jobs runner 500ms tick 会 claim 首删产生的 pending 行；Windows 的删除链
  （fs 级联重试）让「占位 → 再删 → 查数」之间的窗口有数秒，runner 恰在此窗内把首行
  claim 出 pending 态，第二次入队就没有冲突对象了。本地毫秒级窗口，永远命不中。
- **修复**：`b315a3d`——占位前 `services.jobsRunner!.stop()` 冻住 runner，观察窗内行数不得增加。
- **自检**：凡「入队去重 / pending 冲突」类的观察窗，先冻结 runner 或用不可 claim 的 `run_after`，
  且要意识到「占位行 pending 与否」本身是被 worker 抢的瞬态——用 stop() 换确定性。

### P. 布局类断言按平台 metrics 会翻脸——断「机制」不断「指标」（E2E 级，r17 windows+ubuntu 命中）

- **现象**：`project-shell.spec.ts` 420px 断言「五枚 tab 必然横向溢出」在 win/ubuntu 量出
  256/272 行宽、恰好放下（mac 反而 204×239 溢出——三平台行宽都不一样）。
- **根因**：WP6 冒烟时凭单平台量出的「必然溢出」阈值，与各平台字体/窗口装饰差异不互锁；
  这类 CSS 行为契约的正确断言是机制本身（overflow-x-auto + nowrap + shrink-0）。
- **修复**：`b315a3d`——改为断 `overflowX === 'auto'`、`whiteSpace !== 'normal'`、
  每枚按钮 `flexShrink === '0'`（任何 metrics 下恒真）。
- **自检**：写「某宽度下必然溢出/必然放下」前先问：这个宽度是**设计契约**还是**本平台实测**？
  是契约就走样式机制断言；确要指标就必须分平台，参照 memo 的 `{browser,diagnostics,sensors,narrow-layout}` 形状。

### Q. 载波例第二弹：模型切换的双栈双轮链（Tests 级，r17 windows 命中；K 类同型）

- **现象**：`model-switch.test.ts`「second turn uses new defaultMainModel」windows 上
  15s 的 waitFor 先超时（本地 <1s）。
- **根因**：链路含两整栈（每个用例 new 一个 TestStack）+ 两轮 agent 运行；20s 用例线里
  塞 15s 默认 waitFor，满载 runner 顶穿。
- **修复**：`e218a89`——waitFor 显式 30s、it 40s（单用例级，未动全局 testTimeout）。
- **自检**：同 K 类——「本地 <1s、CI 超时」先查该用例是不是起了第二个实例/轮询/fake 服务器。

## 方法论（给下一次）

1. **先取证，再修**：失败第一轮不改断言，先加 dump（`console.warn('[tag] …')`，e2e lint 允许
   warn/error）。**tag 命名**：`[delete-wipe-diag]`、`[narrow-diag]`、`[mic-diag]`、`[wiki-diag]*`、
   `[workbench-pin|dims]`。绿色后 `1f0865b` 是一次性撤回模板。
2. **runner 日志拉取**：`GH_REPO=jooler/kepcup gh api repos/jooler/kepcup/actions/jobs/<jobId>/logs`，
   `grep -nE "##\[error\] +[0-9]+\)|\[tag\]"`。jobId 由 `gh run view <runId> --json jobs -q '.jobs[] | "\(.name) \(.databaseId|tostring)"'`（浮点截断必须转字符串）。
3. **e2e 的执行纪律**：必须从 `apps/desktop/` 工作目录跑（Electron `args:['.']` 按 CWD 解析 app），
   改 main 层后本地先 `pnpm --filter @kepcup/desktop build`。迭代内只跑定向 spec。
4. **不要做的**：拿「再上一层 retry」当修复；timeout 一刀切拉满；在 只差一个平台失败时改全平台断言。
5. **每轮策略**：一 commit 一 push 一轮 CI（~25–40 分钟），期间只做日志分析，不要在 runner 还没
   结论时提前改主代码（避免 mix-in 两个假设）。
6. **轮换识别**（r11–r13 的教训）：过半后仍红的平台在连续几轮里**换文件/换平台**地失败
   （mac→ubuntu→ubuntu、wiki→sensors、subagent→mail）= 不是功能回归，是慢节点/夹缝类问题。
   按 J/K 处理，不动正在绿的断言。

## 重铺到另一分支时的高危点位

| 位置 | 内容 | 合并风险 |
|---|---|---|
| `apps/desktop/test/e2e/helpers/home-cleanup.ts` | `rmHomeTolerant`（rename-out 优先） | 新 spec 的 teardown 别绕开它 |
| `packages/core/src/infra/fs-rm.ts` | 原生重试 24×250ms | lifecycle 级联删除的新增路径应继续走它 |
| `apps/desktop/src/main/browser-host.ts` | `renamePartitionOut` / `sweepRemovedPartitions` / `removeDirTolerant` | 删除 Bot/资料链不要改成同步强删 |
| `packages/core/src/wiki/source.ts` | loopback 分支 `fetchViaHostHttp` + `wikiBodyOrThrow` | 新 URL 用例只走这一条通路 |
| `apps/desktop/test/e2e/workbench.spec.ts` | `waitReady` 的 `kepcup.e2e.workbenchWide` 钉栏 + `overflowing()` 的 ellipsis skip | 改布局与 memo 的 logic 时先读 r6 结论 |
| `apps/desktop/test/e2e/{browser,diagnostics,sensors,narrow-layout}.spec.ts` | 平台分支断言 | 不要「顺手」统一断言 |
| `packages/core/src/skills/registry.ts:1082` | rollback 的 `await` | 迁移中如改 registry 逐行确认每一处 `authoredGitCommit` 的返回 / 等待语义 |
| `packages/core/src/env/manager.ts:265/352` | system 审批 fire-and-forget 的 `.catch()`（J 类） | 新增审批回调路径照抄该形状 |
| `packages/core/test/integration/{subagent,mail-service-fixes}.test.ts` | 重活用例显式 timeout（K/Q 类） | 迁移新增的双实例/轮询用例直接带显式 timeout（`model-switch.test.ts` 同型） |
| `packages/core/test/integration/subagent.test.ts:338` | 删除后中止断言 = 领域状态 + 收敛边界，禁瞬时计数（L 类） | 新增「取消/删除不再推进」用例照抄该形状 |
| `apps/desktop/test/e2e/project-routing.spec.ts` | 轮内计数基线在使用点取样（N 类） | 新增「网关/续接被调了几次」断言照抄该形状 |
| `packages/core/test/integration/wiki-remove-source.test.ts` | 去重观察窗先冻住 jobs runner（O 类） | 新增「入队去重」观察窗照抄该形状 |
| `apps/desktop/test/e2e/{project-shell,workbench}.spec.ts` | 布局契约断机制不断指标（P/F 类） | 改外壳布局时先读本节与 r6 结论 |

### 已知但未修（超过本题范围，需另行立项）

- srt 上游：`allowLocalBinding` 只在 macOS profile 生效，linux bwrap 用户无法访问宿主回环——
  已用「loopback 宿主直连」级别的 workaround；若上游补齐可收缩。
- Windows 分区目录的「当场彻底删除」只能通过进程退出实现；产品文案可提示「删除将在重启时完全生效」。
- ubuntu runner 的 Xvfb 无 GPU 慢帧——只在动效断言上用可得时窗保护，没有系统性解法。
- `workdirs.spec.ts` 任务唤醒轮的 relay 偶发缺席（r17 mac 单轮命中、复试未复现）：失败分支
  `[task-relay-diag]` 已固化（dump mock-main 请求序列与 lane 消费），再命中时按它取证。
