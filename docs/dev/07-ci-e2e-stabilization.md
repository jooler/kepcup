# CI 端到端修正备忘（r1–r10 全绿史）

- **分支**：`ci/e2e-flaky-fixes`（PR #4）。
- **终点**：全绿（E2E ubuntu / windows / macos + Tests ×3 + Lint），commit 链
  `b05ae28 → 71017a2 → 3b0a822 → bdb0efd → 323da2b → 204e2fb → 7c334a1 → deec7a2 → 1f0865b`。
- **写作目的**：另一条重量级分支（含 groups/project 迁移）合并时大概率再次触发同类失败。本文把
  「现象 → 根因 → 修法 → 自检」沉淀成速查，让下一次不需要再走 10 轮 CI。

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

### 已知但未修（超过本题范围，需另行立项）

- srt 上游：`allowLocalBinding` 只在 macOS profile 生效，linux bwrap 用户无法访问宿主回环——
  已用「loopback 宿主直连」级别的 workaround；若上游补齐可收缩。
- Windows 分区目录的「当场彻底删除」只能通过进程退出实现；产品文案可提示「删除将在重启时完全生效」。
- ubuntu runner 的 Xvfb 无 GPU 慢帧——只在动效断言上用可得时窗保护，没有系统性解法。
