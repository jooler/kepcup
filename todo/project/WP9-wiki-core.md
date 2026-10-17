# WP9 · 项目 wiki 后端：owner 泛化、项目级索引、来源台账、ACL、维护身份

> 依赖：WP1 已合入（项目 = 根会话，`ProjectsService`、`canManageEntry`）。可与 WP2–WP8 并行（改 `wiki/`、`jobs`、`lifecycle`，与 `dispatch/` 路由类 WP 不冲突；若与 WP4 同时改 `lifecycle.ts`，后合入者解决冲突）。分支：`feat/project/wp9-wiki-core`。
> 先读 [README.md](README.md) §1、§4.13–§4.14；设计依据 [41 §8](../../docs/design/41-project-team.md)、[36 §3.1–§3.2、§6](../../docs/design/36-wiki-multimodal-ingest.md)（资产台账结构，本 WP 首次落地其**文本子集**）、[05](../../docs/design/05-wiki-and-skills.md)。

## 1. 目标与模型（已定，不得改）

**模型 C**：每个项目一个共享 wiki，**一条串行维护队列**（互斥键 `project:{id}`）。
- **来源（raw）条目有创建者**（`user` 或 `bot:{id}`），登记在 `raw/_assets/{assetId}.json`；页面由维护 loop 综合并带出处。
- 成员可读全部；**用户与负责人可删全部来源，成员只能删自己创建的**（`canManageEntry('wiki', …)`）。
- **执行者付费**：成员 `wiki_enqueue` 的入库，维护 loop 以**该成员**身份运行（模型、用量、后台每日预算记在该成员名下）；用户添加的来源与定期体检以**负责人**身份运行。
- 项目 wiki 有**自己的索引库** `projects/{id}/wiki.db`；Bot 个人 wiki 仍在各自 `memory.db`，**完全隔离**（D9 不破）。

本 WP 做后端闭环（存储、索引、台账、ACL、任务、生命周期、RPC 契约与事件的 owner 化）；**工具、提示词、UI 归 WP10**。

不做：D85 的二进制 / 派生（`wiki_derive`、`wiki-store` 实际使用）、Bot wiki 启用台账、页面手工编辑、移交项目 wiki。

## 2. 固定契约

- shared：`WikiOwner = { kind: 'bot'; id: string } | { kind: 'project'; id: string }`，`wikiOwnerSchema`（`z.discriminatedUnion('kind', …)`），放 `packages/shared/src/domain/wiki.ts` 并从 `index.ts` 导出；`wikiOwnerKey(owner): string` = `` `${owner.kind}:${owner.id}` ``（互斥键、去重键共用）。
- 台账条目（`raw/_assets/{assetId}.json`，**对齐 D85 §3.2 的结构**，仅用其文本子集 + 新增 `createdBy`）：

```ts
interface WikiAssetEntry {
  id: string;                         // 'ast_' + sha256 前 24 位十六进制
  sha256: string;                     // 64 hex，内容哈希
  kind: 'text' | 'html';              // 本期只有文本类
  fileName: string;
  bytes: number;
  storage: 'git';                     // 本期恒为 git（原件在 rawRelPath）
  rawRelPath: string;                 // 例 'raw/20261017-3f9a0c1b2d4e-notes.md'
  createdBy: { kind: 'user' } | { kind: 'bot'; id: string };   // 第一个提交该内容的人；之后相同内容只追加 sources
  sources: Array<{ type: 'attachment' | 'file' | 'url'; ref: string; conversationId: string | null; at: number }>;
  status: 'maintained';
  createdAt: number;
  updatedAt: number;
}
```

- 路径助手（`infra/paths.ts`）：`projectRoot(paths, projectId)` = `<home>/projects/{projectId}`；`projectWikiRoot` = `…/wiki`；`projectWikiStoreRoot` = `…/wiki-store`；`projectWikiDbPath` = `…/wiki.db`；以及按 owner 的泛化助手 `wikiRoot(paths, owner)` / `wikiRawDir(paths, owner)` / `wikiPagesDir(paths, owner)` / `wikiStoreRoot(paths, owner)`；原 `botWikiRoot` 等**保留为薄封装**（Bot 的路径不变：`bots/{id}/wiki`）。
- jobs：`wiki_ingest` / `wiki_lint` 的 payload 增 `owner: WikiOwner`（`wiki_ingest` 另增 `createdBy`）；`bot_id` = **执行者**（成员入库 = 该成员；用户来源与体检 = 项目负责人），`conversation_id` = 项目 id；去重键 `wiki_ingest:${wikiOwnerKey(owner)}:${sourceType}:${ref…}`、`wiki_lint:${wikiOwnerKey(owner)}:weekly`。Bot wiki 的 job 同样带 `owner: { kind: 'bot', id }`（统一形态，不保留旧 payload 兼容）。
- 事件：`wiki_changed: { owner }`、`wiki_ingested: { owner, botId, conversationId, rawPath, skipped }`（`botId` 为执行者）；`wiki_ingest_failed`（internal 事件）同样带 `owner`。
- RPC 契约（breaking，无兼容）：`wiki.tree|page|search|history|rollback|deletePage` 的入参 `{ botId, … }` → `{ owner: WikiOwner, … }`（schema 名 `wikiBotIdInputSchema` 等同步改为 `wikiOwnerInputSchema` 等）。
- 服务层新增（`WikiService`）：`listSources(owner): WikiAssetEntry[]`、`removeSource(input)`（见步骤 5）、`sourceCount(owner): number`、`prepareProjectDeletion(projectId)`。

## 3. 开工前核对

```bash
ls packages/core/src/wiki
rg -n "botWikiRoot|botWikiRawDir|botWikiPagesDir|botWikiStoreRoot" packages -g '!node_modules' -g '!**/dist/**' -l
rg -n "storeFor\(|WikiFtsFacade" packages/core/src --glob '*.ts'
rg -n "wiki_ingest|wiki_lint|wiki_suggestion|enqueueIngest|enqueueDueLints|lastDoneAt" packages/core/src --glob '*.ts' | head -30
rg -n "wiki_changed|wiki_ingested|wiki_ingest_failed" packages apps --glob '*.ts' --glob '*.svelte' -g '!**/dist/**' -l
```

必读源码（**全文**）：`wiki/service.ts`（1074 行，先读类方法清单：`runExclusively`、`wikiRoot`、`exists`、`enqueueIngest`、`search`、`readPage`、`tree`、`history`、`rollback`、`#reindexAllFromDisk`、`deletePage`、`topicsSection`、`enqueueDueLints`、`reconcileFts`、`reconcileFtsFor`、`pageCount`、`prepareBotDeletion`，以及仅 Bot 间移交用的 `pageStats` / `pageConflict` / `copySize` / `copyForHandover` / `discardHandoverLeftovers` / `sweepHandoverLeftovers`——**后一组保持 Bot 专用，不动**）、`wiki/{ingest,maintenance,maintenance-tools,lint,init,git,fts,source,topics}.ts`、`tools/wiki-tools.ts`（本 WP 只改它的调用以便编译，签名改动归 WP10）、`infra/paths.ts`、`infra/crypto.ts`（`deriveKey`、`memoryDbKeyInfo`）、`memory/manager.ts`（`MemoryDbManager` 开库方式）、`memory/store.ts`（`wikiUpsertPage` 等 FTS 方法，约 l.577–630）、`domain/jobs.ts`（`enqueue`、`lastDoneAt`）、jobs runner（`rg -n "wiki_ingest" packages/core/src -l` 找到 `jobs-runner.ts`；`#runJob` 与 `JOB_PURPOSES`、预算延后）、`domain/lifecycle.ts`（`deleteConversation`、`deleteBot` 中 wiki 相关）、`rpc/bindings.ts`（约 l.1391–1412 的 `wiki.*`）、`start.ts`（`WikiService` 装配约 l.1546–1553、`reconcileFts` 约 l.2708、周期体检）。

## 4. 步骤

### 步骤 1：shared 与路径

1. `packages/shared/src/domain/wiki.ts`：`wikiOwnerSchema`、`WikiOwner`、`wikiOwnerKey`；导出。
2. `infra/paths.ts`：加 §2 的路径助手；`botWiki*` 改为内部调用 `wikiRoot(paths, { kind: 'bot', id })` 等（路径不变）。**注意**：WP0-2 已把检查点目录移到 `workdirs/{id}/…`，`<home>/projects/` 此时是空的新目录，没有冲突；开工前 `rg -n "'projects'" packages/core/src` 再确认一次。
3. 单测 `test/unit/wiki-owner.test.ts`：路径（bot 路径与改动前逐字相同；project 路径在 `projects/{id}/` 下）、`wikiOwnerKey`、schema 拒绝未知 `kind` / 空 id。

### 步骤 2：项目级索引库 `wiki/index-store.ts`

1. 新建 `WikiIndexStore`（构造入参 `db: SqliteDatabase`），把 `MemoryStore` 里的 wiki FTS 方法**原样提取**：`wikiUpsertPage(pagePath, title, content)`、`wikiDeletePage(pagePath)`、`wikiClearPages()`、`wikiSearch(queryText, limit)`、`wikiPageCount()`、`wikiPagePaths()`（SQL 与分词调用 `segmentForFts` / `buildFtsOrQuery` 一字不改）。`MemoryStore` **改为内部持有一个 `WikiIndexStore` 并委托**这六个方法（Bot wiki 继续用 `memory.db`，行为不变，避免两份实现）。
2. 抽出接口 `WikiIndex`（六个方法的签名）。`WikiFtsFacade.storeFor(botId)` → `indexFor(owner: WikiOwner): WikiIndex`：bot → `MemoryService.storeFor(botId)`（它实现 `WikiIndex`）；project → `WikiIndexManager.forProject(projectId)`。
3. `wiki/index-manager.ts`：`WikiIndexManager`（依赖 `paths`、`masterKey`、`clock`、`logger`）。`forProject(projectId): WikiIndexStore`：`mkdirSync(dirname(projectWikiDbPath))`；`openDatabase({ path: projectWikiDbPath(...), key: deriveKey(masterKey, wikiDbKeyInfo(projectId)) })`（在 `infra/crypto.ts` 新增 `wikiDbKeyInfo(projectId) => \`db:wiki:${projectId}\``）；**建表 DDL 内嵌在代码里**（不新增迁移目录，避免打包遗漏），打开时执行并写 `PRAGMA user_version = 1`：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
  segmented_text, page_path UNINDEXED, title UNINDEXED, tokenize = 'unicode61'
);
```

   （DDL 与 `migrations/memory/0002_p09_wiki_fts.sql` 完全一致；两处的一致性由测试保证。）连接池用与 `MemoryDbManager` 同样的 LRU（上限沿用 `MEMORY_DB_POOL_MAX`）；`closeProject(projectId)`、`closeAll()`、`exists(projectId)`。
4. 单测 `test/unit/wiki-index-store.test.ts`：六个方法（含中文分词检索命中、`wikiClearPages`、`wikiPagePaths`、`wikiPageCount`）对内存库与 `WikiIndexManager` 打开的真实加密库**行为一致**；`MemoryStore` 委托后既有 `wiki.test.ts` 的 FTS 用例不变；DDL 一致性（读 `0002_p09_wiki_fts.sql` 与内嵌 DDL 规范化比较）。

### 步骤 3：`WikiService` 的 owner 泛化

按下表把 `botId` 参数改为 `owner: WikiOwner`（**移交相关方法保持 Bot 专用**）：

| 方法 | 改动 |
|---|---|
| `runExclusively(owner, body)` | 互斥键 `wikiOwnerKey(owner)`；`#mutex.forget` 同步改键 |
| `wikiRoot(owner)`、`exists(owner)` | 走 `wikiRoot(paths, owner)` |
| `enqueueIngest({ owner, botId, conversationId, source, createdBy })` | `botId` 是**执行者**；入队 payload 带 `owner`、`createdBy`；去重键见 §2；`conversationId` 对项目 wiki 必须是项目 id（不符 → `INVALID_INPUT`） |
| `search(owner, query, limit?)`、`readPage(owner, pagePath)`、`tree(owner)`、`history(owner)` | owner 化；`search` 经 `indexFor(owner)` |
| `rollback(owner, commitOid)`、`#reindexAllFromDisk(owner)`、`deletePage(owner, pagePath)` | owner 化；互斥 / 索引 / 提交流程不变 |
| `topicsSection(owner)` | owner 化（项目对话的主题注入归 WP10，本 WP 只改签名并保持 Bot 调用方行为不变） |
| `enqueueDueLints()` | 额外遍历**存在项目 wiki 的项目**（`projects/*/wiki/.git` 存在且会话仍存在）：入队 `wiki_lint`，`botId = 项目负责人`（`conversations.leadBotId`），`conversationId = 项目 id`，去重键 `wiki_lint:project:{id}:weekly`；周期判断用新增的 `jobs.lastDoneAtFor(owner, types)`（步骤 6） |
| `reconcileFts()` / `reconcileFtsFor(owner)` | 启动对账同时覆盖项目 wiki（枚举 `projects/*/wiki`） |
| `pageCount(owner)`、新增 `sourceCount(owner)` | owner 化 / 台账条数 |
| `prepareBotDeletion(botId)` | 不变（只管 Bot wiki）；**新增** `prepareProjectDeletion(projectId)`：标记 `#deleting`、`#mutex` 排空并 `forget` |

`wiki/init.ts`：`initWiki(paths, owner, logger)`；`SCHEMA.md` 模板按 owner 分两个：Bot 版保持不变；**项目版** `PROJECT_WIKI_SCHEMA_TEMPLATE` 需包含（措辞由你写，保持与 Bot 版相同的章节结构与风格，中文）：①这是项目组共享的知识库，来源由多位成员与用户提交；②每份来源登记在 `raw/_assets/*.json`，**页面必须引用来源**，引用写法 `[源：文件名](../raw/_assets/ast_….json)`；③页面里**不得出现用户或成员的个人信息**（与 Bot 版一致，体检检查）；④原件在 `raw/` 与 `raw/_assets/` 对维护 loop 只读；⑤同一事实出现多处来源时合并到一页并列出全部来源。`index.md` / `log.md` 模板沿用。

> 项目 wiki 在**首次入库时**惰性初始化（与 Bot wiki 一致）；未初始化时 `tree` 返回空、`readPage` 抛 `NOT_FOUND`、`search` 返回空——这些读路径必须容忍 `exists(owner) === false`。

### 步骤 4：台账与入库 `wiki/assets.ts`、`ingest.ts`

1. `wiki/assets.ts`（纯函数 + 薄 IO）：`assetIdOf(sha256: string): string`（`'ast_' + sha256.slice(0, 24)`）；`ledgerPath(root, id)` = `raw/_assets/{id}.json`；`readLedger(root): WikiAssetEntry[]`（目录不存在 → `[]`；单个文件解析失败 → 跳过并记日志，**不抛**）；`writeLedgerEntry(root, entry)`（原子写：写临时文件再 `rename`）；`appendSource(entry, source, now)`（同 `type` + `ref` 已存在则不重复；更新 `updatedAt`）；`removeLedgerEntry(root, id)`。zod 校验 `WikiAssetEntry`（读时 `safeParse`）。
2. **`ingest.ts` 的 `runWikiIngestJob`**：
   - 解析 payload：`owner`、`createdBy`、`sourceType`、`ref`、`note`；缺 `owner` → 任务失败（`INVALID_INPUT`，不兼容旧 payload）。`botId = job.bot_id`（执行者）。
   - 互斥与根目录一律按 `owner`（`runExclusively(owner, …)`、`initWiki(paths, owner, logger)`、`wikiRawDir(paths, owner)`）。
   - `resolveSource(deps, { botId, conversationId, sourceType, ref })`：用**执行者**的身份与会话（`conversationId` 对项目 wiki 是项目 id；执行者必须仍是该项目的成员，否则任务失败并记原因——成员被移出后它排队的入库作废）。
   - **仅当 `owner.kind === 'project'`** 写台账：在原件写入 `raw/` 之后、调维护 loop 之前，算 `assetId`；台账里已有同 `assetId`（内容相同）→ **`appendSource` 后跳过再次维护**（同现有「同哈希已提交则跳过」的语义；`createdBy` 保持首位创建者）；否则新建条目（`createdBy` 取 payload）。台账文件与原件一起由维护提交的 `commitWikiTree`（`git add -A`）带入同一次提交。
   - 维护 loop 的任务消息（`maintenance.ts` 的 `taskMessage`）对项目 wiki 增加两行：`来源资产：{assetId}（登记在 raw/_assets/{assetId}.json）`、`来源提交者：{用户 / Bot 名字}`；提示词要求页面按 SCHEMA 的引用写法引用该资产。
   - 失败通知（最后一次重试失败时通知用户）：按**提交者**与会话处理——Bot 提交的，沿用「内部事件唤醒该 Bot 用自己的话交代」；用户提交的（`createdBy.kind==='user'`），改为 `app.notice` 轻量提示（不落库）。
3. **`maintenance.ts`**：`runWikiMaintenance` 的 `task.input` 增 `owner`；根目录 `wikiRoot(paths, owner)`；`routeFor(deps, 'wiki_maintenance', botId)` 的 `botId` 是执行者；`runs.create({ botId, conversationId, … })` 的 `conversationId` 对项目 wiki 是项目 id；FTS 更新走 `indexFor(owner)`；循环后「Bot 是否还活着」的检查对项目 wiki 增加「项目是否还存在、执行者是否仍是成员」；`MAINTENANCE_PROMPT` 里「personal wiki for a bot」按 owner 种类切换措辞（项目版：「shared project wiki maintained for a team」）。用量 `recordUsage(…, botId, conversationId, …)` 照旧记在执行者名下。
4. **`lint.ts`**：payload 读 `owner`；执行者 = `job.bot_id`；项目版体检额外检查：页面里指向 `raw/_assets/*.json` 的链接是否仍存在（悬空引用）、页面是否至少引用一个来源（在体检提示词里加这两条）。
5. **`maintenance-tools.ts`** 不改（它只认 `wikiRoot`）。**`init.ts` / `git.ts` / `topics.ts` / `source.ts`** 只改路径 / owner 入参。

### 步骤 5：来源删除 `removeSource`（首次实现 D85 §6 的 `wiki.deleteAsset`）

```ts
export type WikiActorRole = 'user' | 'lead' | 'member';
removeSource(input: {
  owner: WikiOwner;                   // 仅 project；bot owner → AppError('NOT_SUPPORTED', 'Bot wiki 没有来源台账')
  sourceId: string;                   // 'ast_…'
  actor: { role: WikiActorRole; botId?: string };   // 由调用方（RPC / 工具）按会话成员关系算好
}): Promise<void>;
```

在 `runExclusively(owner, …)` 内：
1. 读台账找到条目（找不到 → `NOT_FOUND`「来源不存在或已删除」）；
2. **ACL**：`canManageEntry('wiki', actor.role, entry.createdBy, actor.botId)`（shared，WP1）为假 → `AppError('FORBIDDEN', '只能删除自己添加的来源')`（若无 `FORBIDDEN` 错误码就用 `INVALID_INPUT`，**不要新增错误码**）；
3. 删除原件文件 `entry.rawRelPath`、台账文件；在 `log.md` 追加一行（格式同 `deletePage` 追加的那行：日期 | 删除来源 | 文件名 | 操作者）；`commitWikiTree`；
4. 入队一次体检 `wiki_lint`（`botId` = 项目负责人，`conversationId` = 项目 id，payload `{ owner, trigger: 'source_removed' }`，去重键 `wiki_lint:project:{id}:source_removed`）清理悬空引用；
5. 发布 `wiki_changed { owner }`。
索引 `wiki_fts` **不动**（只索引 `pages/`，不索引 `raw/`）。回滚到更早提交会把已删来源带回（git 历史如此，与 `deletePage` 一致）；文档注明即可。

`listSources(owner)`：读台账，按 `createdAt` 倒序；`sourceCount` 同源。

### 步骤 6：jobs、runner、生命周期、装配、RPC

1. **`domain/jobs.ts`**：新增 `lastDoneAtFor(owner, types)`：bot → 原 `lastDoneAt(botId, types)`；project → `select max(updated_at) from jobs where conversation_id = ? and status = 'done' and type in (…) and json_extract(payload_json, '$.owner.kind') = 'project'`（`json_extract` 需要 SQLite JSON1，better-sqlite3-multiple-ciphers 默认带；单测覆盖）。
2. **jobs runner**：`wiki_ingest` / `wiki_lint` 的 `#runJob` 分支不变（`runWikiIngestJob` / `runWikiLintJob` 内部已读 owner）；预算延后仍按 `job.bot_id`（执行者付费，设计如此）；`JOB_PURPOSES` 不变。
3. **`lifecycle.ts`**：
   - `deleteConversation`：会话是 `project` → 在删库前 `await wiki.prepareProjectDeletion(id)`（排空互斥）；已有的 `jobs.cancelByConversation` 会取消该项目的所有 wiki job；删库与附件清理之后 `rmSync(projectRoot(paths, id), { recursive: true, force: true })`（wiki、wiki-store、wiki.db 一起），并 `wikiIndex.closeProject(id)`（先关库再删文件）。
   - `deleteBot`：不需要改 wiki（Bot wiki 随 `bots/{id}` 目录删除；该 Bot 在项目 wiki 里的来源**保留**，台账里 `createdBy` 仍是它的 id，界面显示占位——WP10；它排队中的入库 job 被 `cancelByBot` 取消）。
   - `removeProjectMember`：该成员在该项目 wiki 里**排队中**的入库 job 一并取消（`jobs` 里 `bot_id = 成员 and conversation_id = 项目 and type = 'wiki_ingest' and status = 'pending'`）；已完成入库的来源保留。
4. **`start.ts`**：装配 `WikiIndexManager`；`WikiService` 的依赖里 `memory: WikiFtsFacade` 换成新的 `indexFor`；周期体检、启动 `reconcileFts` 已按步骤 3 覆盖项目；项目会话删除时的关闭连接（`closeProject`）与退出时 `closeAll`。
5. **RPC 与事件（契约 breaking）**：`shared/rpc/methods.ts` 的 `wiki.*` 入参改 `{ owner, … }`；`wiki.page` 等输出不变；`shared/rpc/events.ts` 的 `wiki_changed` / `wiki_ingested` 带 `owner`；`rpc/bindings.ts`：`wiki.*` 处理器按 owner 调 `WikiService`；`project` owner 需校验会话存在且 `type==='project'`（否则 `NOT_FOUND`）；`deletePage` / `rollback` 来自 RPC 即**用户**，不做 ACL（用户恒可写）。
6. **`tools/wiki-tools.ts`**（本 WP 只为编译）：三个工具内部改传 `{ kind: 'bot', id: identity.botId }`；`wiki_enqueue` 的 `enqueueIngest` 调用补 `createdBy: { kind: 'bot', id }`、`owner`、`botId`。**工具签名与 `scope` 参数归 WP10。**
7. **renderer 最小编译修复**：`stores/wiki.svelte.ts` 与 `WikiTab.svelte`（右栏单聊的 Wiki 页签）所有 `wiki.*` 调用改传 `{ owner: { kind: 'bot', id: botId } }`；订阅 `wiki_changed` 时按 `owner.kind === 'bot' && owner.id === 当前 botId` 过滤。**界面行为不变。**

## 5. 测试

**改写**（保证既有 Bot wiki 行为不变）：`test/unit/wiki.test.ts`、`wiki-maintenance-delete.test.ts`、`wiki-source-sniff.test.ts`、`test/integration/wiki.test.ts`、`wiki-url.test.ts`、`test/unit/handover-wiki-copy.test.ts`、`apps/desktop/test/e2e/wiki.spec.ts` 里的 `wiki.*` 入参、job payload、事件载荷、`WikiService` 方法签名按新形态改；**断言的行为不变**。

**新增**：
1. `test/unit/wiki-owner.test.ts`、`test/unit/wiki-index-store.test.ts`（步骤 1、2）。
2. `test/unit/wiki-assets.test.ts`：`assetIdOf`；`writeLedgerEntry` / `readLedger` 往返；坏文件被跳过不抛；`appendSource` 去重；原子写。
3. `test/integration/wiki-project.test.ts`（**必须有**，经完整 core + mock LLM）：项目组（负责人 L，成员 M、N）：
   - 经服务入队两条来源（M 提交一份文本，N 提交另一份）：两个 job 的 `bot_id` 分别是 M、N，`conversation_id` 是项目 id；**两次维护串行**（用互斥键断言：第二个在第一个提交后才进入锁；可在测试里用可控的 mock LLM 延迟来观察顺序）；
   - 台账：每份来源有 `raw/_assets/ast_….json`，`createdBy` 分别为 `{bot:M}` / `{bot:N}`，`sha256` 与 `assetId` 对应；**相同内容再由 N 提交** → 不新建条目、不再维护，`sources[]` 追加一条，`createdBy` 仍是 M；
   - 用量：M 的入库用量记在 M 名下、N 的记在 N 名下（`usage_ledger.bot_id`），`runs` 里维护 run 的 `bot_id` / `conversation_id` 分别是执行者与项目 id；
   - 索引：项目页面写入 `projects/{id}/wiki.db`；M、N、L 三个 Bot 的 `memory.db` 里**都没有**这些页面（`wikiPagePaths()` 为空）；`wiki.search({ owner: project })` 命中；
   - **用户来源与体检用负责人身份**：经服务以 `createdBy: user` 入队 → `job.bot_id` 是 L；`enqueueDueLints()` 为项目入队的 `wiki_lint` 的 `bot_id` 是 L，去重键 `wiki_lint:project:{id}:weekly`；
   - **Bot wiki 不受影响**：M 个人 wiki 的入库、检索、移交复制全部照旧，且互不可见（N 的 `wiki.search({ owner: bot M })` 走 RPC 是用户行为，不在此测；只断言存储隔离：目录与索引库不同）。
4. `test/integration/wiki-remove-source.test.ts`：ACL 全表（用户 / 负责人删任意来源；成员删自己的成功、删别人的被拒、删用户来源被拒；Bot owner 调用 → `NOT_SUPPORTED`）；删除后：原件与台账文件消失、`log.md` 有记录、新增一次提交、入队了 `source_removed` 体检（去重）、`wiki_changed` 发布、`wiki_fts` 行数不变；成员已被移出项目后其来源仍在、仍可由用户 / 负责人删。
5. `test/integration/wiki-project-lifecycle.test.ts`：删除项目组 → `projects/{id}/` 整个目录与 `wiki.db` 消失、该项目的 wiki job 全部取消、连接已关闭；移出成员 → 其排队中的入库 job 取消、已入库来源保留；删除成员 Bot → 来源保留（`createdBy` 仍是其 id）、其排队 job 取消；项目 wiki 在**未初始化**时 `tree` / `search` / `sourceCount` 安全返回空。
6. `test/unit/jobs-last-done-for.test.ts`：`lastDoneAtFor` 对 bot / project 两种 owner。
7. 启动对账：`reconcileFts` 对项目 wiki 的索引库与磁盘页面不一致时修复（参照 `wiki.test.ts` 里 Bot 的对账用例）。

## 6. 验证

```bash
pnpm --filter @kepcup/shared run build && pnpm --filter @kepcup/shared typecheck
pnpm --filter @kepcup/core run build && pnpm --filter @kepcup/core typecheck
pnpm --filter @kepcup/desktop typecheck && pnpm lint
node scripts/run-tests.mjs run packages/core/test/unit/wiki-owner.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/wiki-index-store.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/wiki-assets.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/jobs-last-done-for.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/wiki-project.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/wiki-remove-source.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/wiki-project-lifecycle.test.ts
node scripts/run-tests.mjs run packages/core/test/integration/wiki.test.ts
node scripts/run-tests.mjs run packages/core/test/unit/handover-wiki-copy.test.ts
node scripts/run-tests.mjs run --project desktop
```

本 WP 改了 shared 契约（RPC / 事件 breaking），结束前**跑一次全量**，失败集合不超出基线。

## 7. 验收清单

- [ ] 项目 wiki 全链路：入库（执行者付费）、台账（`createdBy`、去重追加 `sources`）、项目级索引库、串行互斥、体检（负责人身份）、`removeSource` + ACL、生命周期（删项目、移出成员、删 Bot）。
- [ ] Bot 个人 wiki 行为不变、存储与索引与项目 wiki 完全隔离；handover 复制测试不变且通过。
- [ ] RPC 与事件已 owner 化；renderer 单聊 Wiki 页签行为不变。
- [ ] 自检：

```bash
rg -n "wikiBotIdInputSchema|storeFor\(botId|botWikiRoot\(deps|botId: input\.botId" packages/core/src/wiki packages/core/src/rpc -g '!**/dist/**'
rg -n 'wiki_ingest:\$\{botId|wiki_lint:\$\{bot' packages/core/src
```

  应为空（`copyForHandover` 等 Bot 专用方法里保留 `botId` 参数是预期）。
- [ ] `0` 个新增迁移目录（项目索引 DDL 内嵌在代码里，且与 `migrations/memory/0002` 一致，测试保证）。
- [ ] 全量失败集合不超出基线；实施记录已填。

## 8. 风险与陷阱

- **最险三处**（设计 41 §8.8）：①索引与存储布局——别让 `MemoryStore` 委托改动破坏 Bot wiki；②执行者付费与串行队列的归因 / 预算——job 的 `bot_id` 必须是执行者，预算延后按它判定；③来源 ACL 与删除在并发入队下的正确性——所有台账读改写都在 `runExclusively(owner, …)` 内。
- **排队的 job 会占着后台槽位**等互斥锁（一个项目的 N 个成员同时入库，最多占 N 个槽位）。**本 WP 接受这个行为**，不做额外调度；只在实施记录里记一笔观察到的最坏情形。
- 台账读取必须**容忍损坏文件**（跳过 + 日志），否则一个坏文件会让整个项目 wiki 的来源列表打不开。
- 不要把项目 wiki 的页面索引进任何 Bot 的 `memory.db`；不要让项目 wiki 出现在 handover 适配器里。
- `json_extract` 过滤 payload 的写法要有单测，避免 SQLite 编译选项差异。
- 不要动 D85 的 `wiki-store/`、`wiki_derive`、`wiki.deleteAsset` 的二进制路径；本期台账的 `storage` 恒为 `'git'`。
- 不要提前做 WP10 的工具 `scope`、新 RPC（`wiki.addSource` / `sources` / `deleteSource`）、提示词与界面。

## 9. 实施记录

- **分支**：`feat/project/wp9-wiki-core`（基于集成分支早期点，含 WP0-2 / WP1 / WP2。**未 rebase**：主集成分支其后的 WP3 改动（`events.ts`、`orchestrator.ts` 等）的合入冲突由总调度处理；本分支收口以自身现状为准）。
- **接续说明**：前代理完成步骤 1-2 并提交 `a32afff`（shared `WikiOwner` / `wikiOwnerKey`、`infra/paths.ts` 项目路径助手与 owner 泛化助手、`crypto.wikiDbKeyInfo`、`wiki/index-store.ts` / `index-manager.ts` / `assets.ts`、jobs `lastDoneAtFor` + `cancelPendingByBotInConversation` 及 4 个单测）；步骤 3-7 以约 22 个未提交半成品遗留（wiki/ 服务层、jobs runner、lifecycle、orchestrator、start、bindings、tools、shared rpc、desktop store 与 e2e、integration wiki-project）。本代理逐块核对其与任务书一致性，补齐缺口、修正偏差并收口。半成品相互咬合无法拆成多个可构建提交，按 README §1.5 合成一个实现提交（本条即说明）。
- **提交列表**：
  - `a32afff` `feat(shared,core): wiki owner foundations for project wikis (D92 T1b WP9 steps 1-2)`
  - `ab58b5f` `feat(shared,core)!: generalize wiki domain to owners — project wikis (D92 T1b WP9 steps 3-7)`
  - 文档提交（本条 + README §7 + DEVIATIONS）。
- **半成品的核对结论与修正**（本代理改动）：
  1. `handover/adapters/wiki.ts` 遗漏 owner 化：复制完成后仍发布 `{ botId }` 形态的 `wiki_changed` → 改为 `{ owner: { kind: 'bot', id } }`（漏改的 `handover-adapters-p2.test.ts` 断言一并修正）。
  2. `external-agent-p6.test.ts` 的 wiki_lint 用例仍入队旧 payload（无 `owner`）→ 按 breaking 契约更新（job 终态 failed→done 复核通过）。
  3. 重复来源跳过分支的台账登记改为**仅新增 source 记录时提交**：完全相同的 (type, ref) 重复提交只重写相同字节、不产生空提交（`ensureLedgerEntry` 返回是否追加）。
  4. `app.notice` 失败提示文案按 owner 种类区分「项目 Wiki / Wiki」。
  5. 清理 4 处未使用 import（lint）。
  6. `wiki-project.test.ts` 三处测试 bug 修正（`runs` 表在 `runsDb` 不在 `mainDb`；`wiki.tree` 输出形状是 `{ pages }`；重启对账用例两个 stack 须共用同一 memory keystore），并补齐 N 的维护 loop 脚本、体检到点用的 done 行回拨、M 的 memory.db 只含私有页面的断言。
  7. 新增缺失测试：`test/integration/wiki-remove-source.test.ts`（ACL 全表、删除级联、去重、移出成员后仍可删）、`test/integration/wiki-project-lifecycle.test.ts`（删项目 / 移出成员 / 删 Bot）。
- **关键取舍**（任务书未明说、由本代理判断）：
  1. `removeSource` 的 ACL 拒绝用 `INVALID_INPUT`（仓库无 `FORBIDDEN` 错误码，按 WP 指示不新增）；Bot owner → `NOT_SUPPORTED`；来源不存在 → `NOT_FOUND`。
  2. 用户提交来源的终态失败通知经 `app.notice`（key `wiki-ingest-failed:{jobId}`，warning，不落库）；Bot 提交的沿用内部事件 `wiki_ingest_failed` 唤醒执行者。该内部事件是消息文本通道（`deliverEventToBot(botId, conversationId, event, text)`），无结构化 payload 可带 `owner`——归属按 `createdBy` 分流已即 WP「同样带 owner」的意图。
  3. renderer 最小编译修复只动了 `stores/wiki.svelte.ts`（`WikiTab.svelte` 全部经 store 调用，无需改动）；`wiki_changed` 订阅按 `owner.kind==='bot' && owner.id===当前 botId` 过滤，界面行为不变。
- **观察到的槽位占用**（§8）：全局后台并发 `BACKGROUND_LOOP_CONCURRENCY = 2`。一个项目的 N 个成员同时入库时，被认领的 job 在互斥队列里等锁，最多占满 2 个后台槽位（N>2 时其余仍 pending 不占槽），期间同项目的维护串行推进、其它后台 loop（记忆整理等）被推迟。WP 接受，未做调度。
- **验收清单核对**：
  - rg 自检 #1：非空，3 处命中逐一核对为预期——`service.ts` `enqueueIngest` 的执行者字段（WP §2 明文保留）、`ingest.ts` `resolveSource` 内部 identity、`bindings.ts` `skills.import`（非 wiki 方法）→ 记 **DEV-032**；`wikiBotIdInputSchema` / `storeFor(botId` / `botWikiRoot(deps` 在 wiki/ 与 rpc/ 下零命中。
  - rg 自检 #2：空（去重键全部 `wikiOwnerKey` 形态）。
  - 迁移目录：**0 个新增**（DDL 内嵌 `wiki/index-manager.ts` 并写 `PRAGMA user_version = 1`，与 `migrations/memory/0002` 的一致性由 `wiki-index-store.test.ts` 保证）。
  - 项目 wiki 全链路 / Bot wiki 隔离 / handover 复制不变 / RPC 与事件 owner 化 / renderer 行为不变：由下述测试覆盖。
- **测试结果**：
  - typecheck：shared / core / desktop（含 svelte-check）全过；`pnpm lint` 过。
  - 定向：unit 8 文件 59 例（wiki-owner 5、wiki-index-store 6、wiki-assets 5、jobs-last-done-for 4、wiki 22、wiki-maintenance-delete 4、wiki-source-sniff 6、handover-wiki-copy 7）全绿；integration `wiki.test` 21、`wiki-url` 3、`handover-p2` 7、`wiki-project` 9、`wiki-remove-source` 3、`wiki-project-lifecycle` 3、`external-agent-p6`、`handover-adapters-p2` 全绿；desktop 单测 767 全绿。
  - 全量（收口一次）：5406 通过 / 2 失败 / 24 skip——2 例均为前代理改写遗漏的测试文件（`external-agent-p6` 旧 wiki_lint payload、`handover-adapters-p2` 旧 `wiki_changed` 断言），已修复并单跑复核通过，不超基线。
  - e2e（`wiki.spec` / `handover.spec` 的 owner 入参已改）未在本 WP 运行（§6 未列；e2e 归 T1a 收口）。
- **偏差**：DEV-032（验收自检 rg#1 的解读）。无其它 WP 偏差。
