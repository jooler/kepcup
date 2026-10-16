# 能力目录与按需挂载（D91）执行规划

> 设计：[docs/design/40-capability-mounting.md](../docs/design/40-capability-mounting.md)（已定稿，2026-10-16 用户确认三项选择）。
> 工作区：worktree `/home/jyy/wt/kepcup-capmount`，分支 `t/capmount`（基于 main d5122cf）。**所有改动只在这个 worktree 里做**；主 checkout `/home/jyy/www/kepcup` 有其他会话的未提交改动，不要碰。
> 早期阶段：不做向后兼容，旧名字（`app_search_tools` / `app_call_tool` / `turnMcpNote` / `<connected_apps>` / `appToolsDeferred` / `TURN_MCP_RESOLVE_TIMEOUT_MS` / `APP_TOOLS_INLINE_MAX`）直接替换，不留别名。
> 不提交（不 `git commit`），由调度会话统一收口。

## 0 通用约定（每个执行者都要遵守）

- Node：`export PATH=$HOME/.nvm/versions/node/v24.13.0/bin:$PATH`（默认 PATH 上是 v12）。
- 类型检查 / lint 在宿主机跑：`pnpm --filter @kepcup/core typecheck`、`pnpm --filter @kepcup/shared typecheck`、`pnpm --filter @kepcup/desktop typecheck`、`pnpm lint`。
- 测试只在容器里跑，且只用 `node scripts/run-tests.mjs run <文件…>`（**绝不**在容器里 `pnpm test` / `pnpm install`）：
  ```
  WT=/home/jyy/wt/kepcup-capmount; NODE_DIR=$HOME/.nvm/versions/node/v24.13.0
  docker run --rm --name capmount-$RANDOM -v $WT:$WT -v $NODE_DIR:$NODE_DIR:ro -w $WT --user $(id -u):$(id -g) \
    -e HOME=/tmp/home -e PATH=$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin kepcup-test:trixie \
    bash -c "mkdir -p /tmp/home && node scripts/run-tests.mjs run <测试文件…>"
  ```
  定向跑：改动文件对应的测试 + 新增测试；不跑全量（全量只在 P4 跑一次）。
- 不启动 Electron（含 xvfb e2e）。
- 先定向、后全量（见 `AGENTS.md`）。注释密度、命名、中文注释风格与周边代码一致；新代码的 doc 注释注明 `D91`。
- 每个阶段结束时在本文件对应阶段下勾选完成项，并追加「实施记录」：改了哪些文件、跑了哪些测试与结果、与设计的偏差（如有，写明原因）。

## P0 能力目录 + 两件套 + 对话轮工具面（执行者 A）

目标：对话轮不再逐个挂外部工具、run 开头不再解析 MCP 工具；`<capabilities>` 段 + `capability_search` / `capability_call` 上线。任务面在 P0 暂时保持「挂全部能力」的旧行为（但用新的两件套取代 `app_search_tools` / `app_call_tool`，阈值常量改名），P1 再改成按声明挂载。

- [x] shared `constants.ts`：`APP_TOOLS_INLINE_MAX` → `EXTERNAL_TOOLS_INLINE_MAX`（40）；`TURN_MCP_READ_TOOLS_MAX` → `SUBAGENT_MCP_READ_TOOLS_MAX`（20）；删除 `TURN_MCP_RESOLVE_TIMEOUT_MS`；新增 `CAPABILITY_RESOLVE_TIMEOUT_MS = 10_000`、`TASK_CAPABILITIES_MAX = 8`（P1 用）。`APP_SEARCH_RESULTS_MAX` 可改名 `CAPABILITY_SEARCH_RESULTS_MAX`。
- [x] core 新目录 `src/capabilities/`：
  - `catalog.ts`：`CapabilityEntry`（设计 §2.1）与 `buildCapabilityCatalog({ connectedApps, mcp, appConnectionIds, mcpServerIds, ... })`——纯读取，不连接；id 规则 `app:{slug}` / `mcp:{serverId}`；状态映射见设计 §2.1（自定义 OAuth MCP 查 `custom:{serverId}` 连接行）。
  - `prompt.ts`：`capabilitiesPromptBody({ entries, surface: 'turn' | 'task', mounted?: string[], hasDiscovery })`，文案按设计 §2.2；复用 / 迁移 `apps/prompt.ts` 的 `oneLine`、`STATUS_TEXT`、`UNTRUSTED_RULE`、`RECONNECT_RULE`。`<available_apps>`（`availableAppsPromptBody`）保留在 `apps/prompt.ts`；`connectedAppsPromptBody` / `connectedAppsSectionBody` / `DISCOVERY_RULE` 删除。
  - `discovery.ts`：由 `apps/discovery.ts` 泛化迁来（删除原文件）：`CapabilityDiscovery { search({query, capability?}), call(name, args, ctx), originOf(name) }`；**懒解析**——构造时只拿「待解析的 server 列表 + 解析函数 + 包装函数 + 条目过滤谓词」，首次 `search`（或指定了未解析的能力）时调 `resolveMcpToolEntries`，带 `CAPABILITY_RESOLVE_TIMEOUT_MS` 超时，结果 run 内缓存；`call` 只接受已解析索引里的名字（未解析过 = 拒绝，提示先 search）。搜索结果带能力 id；对话轮附「该能力另有 N 个工具只在任务中可用」。授权问题（`AppAuthRequiredError`）在结果里写明需要重连 + connection_id。
- [x] `tools/app-tools.ts`：`buildAppDiscoveryTools` → 新文件 `tools/capability-tools.ts` 的 `buildCapabilityTools(discovery)`，工具名 `capability_search` / `capability_call`（常量导出），描述按设计 §3。`AppToolFacade.discovery` 移除，改为 `ResponseToolDeps.capabilities?: CapabilityDiscovery`。
- [x] `tools/index.ts`：对话轮分支不再放 `mcpTools`，放 `capabilityTools`（有 discovery 时）；`app_request_connection` 等保留。任务分支 P0 仍放 `mcpTools`（全部内联，超阈值的应用工具改走两件套，等价于旧行为）+ `capabilityTools`。`dropBuiltinNameConflicts` 的 external 集合照旧。更新文件头注释与 `ResponseToolDeps.mcp` 注释。
- [x] `dispatch/orchestrator.ts`（约 3637–3700、3887–3947、4300–4335 行附近）：
  - 每个 run 先 `buildCapabilityCatalog`（不连接）。
  - 对话轮：**不调用** `#mcpEntriesFor` 解析工具；构建对话轮 discovery（索引谓词 = `allowedOnReadOnlySurface`，`countFailures:false`），`toolDeps.capabilities = discovery`；不传 `mcp`。
  - 任务：沿用 `#mcpEntriesFor(…, isTask=true)`（P1 再按声明过滤）；超阈值应用工具改走任务面 discovery（谓词 = 全部已启用）。
  - 子代理：P0 改为基于任务自身的解析结果（只读 + auto，≤`SUBAGENT_MCP_READ_TOOLS_MAX`）+ 只读 discovery；不再引用对话轮的 `readOnlyMcp`。
  - 系统提示：`connectedApps` / `mcpTurnNote` 字段换成 `capabilities`（`capabilitiesPromptBody` 结果）；`availableApps` 不变。
  - `#appToolFacade` 去掉 discovery 参数；`unavailable` 来源：对话轮来自目录状态（不再有 run 开头的 listTools），任务来自解析结果 + 目录状态。
- [x] `agent/context/system-prompt.ts`：删除 `turnMcpNote` 与 `mcpTurnNote` / `connectedApps` 输入，新增 `capabilities` 段（标签 `<capabilities>`），两种引擎的模板都改；平台规则里 `APP_REQUEST_CONNECTION_RULE` 的出现条件改为「有 capabilities 段或 available_apps 段」。外部引擎模板里按工具门控的规则表（约 647 行）补两件套。
- [x] `apps/exposure.ts`：删除 `appToolsDeferred`；其余不变。
- [x] `agent/effects/classify.ts`：`app_search_tools`/`app_call_tool` → `capability_search: 'none'` / `capability_call: 'external'`（仍经 `mcpOf` 细分）。`agent/types.ts` 注释同步。
- [x] `settings/context.ts`（约 146 行，外部内容工具名单）：替换为两件套名字；确认对话轮 `touchedExternal` 判定仍覆盖 `capability_call`。
- [x] `agent/external/capabilities.ts` 与 shared `domain/host-capabilities.ts`：两件套登记为 `mcp` / `apps` 两包共有（设计 §7）。若 `capabilityOfTool` 只能返回一个包，新增 `isHostToolInjected` 的特例：任一包选中即注入；外部引擎任务构建 discovery 时按选中的包过滤条目（`entry.app !== undefined` ↔ `apps`）。
- [x] desktop `features/chats/tool-labels.ts`：两件套展示名；删旧名。i18n 键如有同步改。
- [x] 测试：
  - 改写 `test/unit/app-step-up-discovery.test.ts`、`test/integration/connected-apps-p2-stepup-discovery.test.ts`、`test/integration/connected-apps-p2-discovery-acp.test.ts`、`test/integration/mcp-loop.test.ts`、`test/unit/settings-catalog-host.test.ts` 中引用旧名字 / 旧行为的用例。
  - 新增 `test/unit/capability-catalog.test.ts`（id、状态映射、不调用 listTools、清洗）、`test/unit/capability-discovery.test.ts`（懒解析只发生一次、超时、对话轮只读过滤与「另有 N 个」、call 未解析名字拒绝、授权错误）、对话轮集成用例（工具列表无 `mcp_*` / `app_*_*`、有两件套、run 开头 listTools 计数 0、写入工具经 `capability_call` → 拒绝）。
  - 全仓搜一遍其他断言对话轮 MCP 工具 / `<connected_apps>` / `turnMcpNote` 的测试（`grep -rn "connected_apps\|mcp_\|turnMcpNote\|TURN_MCP" packages/*/test`），逐个修正。
- [x] typecheck（shared / core / desktop）+ lint 通过；定向测试通过（与基线对比，新增失败必须为零）。

## P1 任务声明能力（执行者 B，P0 完成后）

- [x] 迁移 `packages/core/migrations/runs/0012_task_capabilities.sql`：`ALTER TABLE runs ADD COLUMN task_capabilities TEXT;`（JSON 数组，非任务 NULL），注释写 D91。核对迁移注册方式（是否有清单 / 测试列迁移文件）。
- [x] shared：`Run` 类型 / schema 增 `taskCapabilities: string[] | null`；`domain/runs.ts` 读写（create 接受 `taskCapabilities`）。
- [x] `tools/task-tools.ts`：`start_task` 增可选 `capabilities: string[]`（描述：取 `<capabilities>` 里的 id，任务只挂这些；不列也能经两件套用，但会慢），`StartTaskInput.capabilities`；参数校验（字符串数组、去重、≤`TASK_CAPABILITIES_MAX`）。
- [x] `dispatch/tasks.ts` `TaskHost.start`：按该 Bot 当前能力目录校验 id（不存在 → `INVALID_INPUT`，信息列出可用 id）；`continues_task_id` 取并集；落库；任务简报事件（`appendTaskEvent` brief）带 `capabilities`，任务卡 / `<tasks>` 段可见（检查 shared 里 brief 事件的 schema）。宿主内部 start（orchestrator 约 4655 行 §8.4 降级）不传 → 空数组。重试路径（约 2114 行的 retry 重建简报）保留能力。TaskHost 需要的目录查询经构造参数注入一个窄接口（如 `capabilityIdsFor(botId): string[]`），不直接依赖 orchestrator。
- [x] `dispatch/orchestrator.ts` 任务分支：`#mcpEntriesFor` 只解析「声明 ∩ 当前目录且 ready」的 server；声明能力工具数 ≤`EXTERNAL_TOOLS_INLINE_MAX` 时内联，否则并入 discovery；其余 ready 能力进任务面 discovery（懒解析，`countFailures:true`）。任务提示词 `<capabilities>` 用 `surface:'task'`、`mounted` = 实际内联的能力。
- [x] 子代理（`buildSubagentResearchTools` 调用处）：内联 = 任务内联条目中只读 + auto（≤20）；discovery = 任务可达的全部能力中只读 + auto（去掉已内联的）。
- [x] 对话轮 `<capabilities>` 规则行与 `start_task` 描述措辞一致（P0 已写好的话这里只核对）。
- [x] 测试：`start_task` 参数校验与落库、未知 id 报错列出可用 id、接续取并集、任务工具列表只含声明能力 + 两件套、> 40 工具不内联、排队期间取消勾选后不再挂、子代理只读子集、§8.4 降级任务全部走两件套。现有任务相关测试（`tasks*.test.ts`、`supervisor*`）里断言 `start_task` schema / 简报事件的用例同步。
- [x] typecheck + lint + 定向测试通过；迁移改动按 `05-testing.md` 属于「跨包公共部分」——P1 结束时由执行者 B 跑 `packages/core/test/integration` 下与 runs / tasks / migrations 相关的文件，全量留给 P4。

## P2 邮箱门控 + MCP 用途说明 + 文档（执行者 C，P1 完成后）

- [x] 邮箱（设计 §6）：`tools/index.ts` / `tools/mail-tools.ts` 的注册条件改为按 `mail.accountsForBot(botId)`：0 → 只 `mail_request_setup`；≥1 → 五个工具、无 `mail_request_setup`。`buildMailTools` 增参数或拆两个构建函数；`system-prompt.ts` `hasMail` 拆为 `hasMailTools` / `hasMailSetup`，`mailRequestSetupRule` 只随 `mail_request_setup` 出现；orchestrator 传参同步。测试：0 / 1 绑定两种工具面、提示词规则出现条件、绑定后 retry 拿到五个工具（如已有集成用例可扩展）。外部引擎 `mail` 包注入随之自然变化，核对 `host-capabilities.ts` 的工具数预估（desktop `agent-capabilities.ts` 的 `toolCountOf`）是否需要说明为「最多」。
- [x] `McpServer.description`（设计 §2.3）：shared `mcpServerObjectSchema` 增 `description: z.string().max(200).optional()`；core MCP 设置读写透传；目录 `mcp:` 条目使用它；desktop 扩展中心 MCP 添加 / 编辑表单（`features/extension-center/ExtensionMcp.svelte` / `features/settings/McpSection.svelte` / `mcp-server-patch.ts`，以实际代码为准）加一个可选「用途说明」输入，i18n 中英文都加。测试：schema、patch、目录行使用 description 与缺省文案。
- [x] 文档修订（设计 §9）：design 23（W5 只读工具面 → 两件套；子代理）、29 §7（按需发现泛化，`<connected_apps>` → `<capabilities>`）、30 §2.1 工具面表与 §4.1 `start_task`、28 §4.1 能力包表、35（邮箱工具注册条件），每处加一句「D91 修订」并指向 40；`docs/dev/04-agent-runtime.md` 工具目录与系统提示词模板段（`<capabilities>`、两件套、`start_task.capabilities`、邮箱门控）；`docs/dev/03-data-model.md` 加 `runs.task_capabilities` 与 `McpServer.description`。
- [x] typecheck（三个包）+ lint + 定向测试通过。

## P3 评审（独立评审者，P2 完成后）

- [x] 评审者只读审查 `git diff main`，对照设计 40 逐条核验：安全语义是否不变（两件套是否总转调同一 `wrapMcpTool`、对话轮写入是否被网关硬拒、台账分级、污点）、对话轮 run 开头是否真的零 `listTools`、提示词稳定性（段内无每轮变化的数字）、懒解析超时与错误路径、迁移、外部引擎包过滤、邮箱门控、死代码与旧名字残留（`grep -rn "app_search_tools\|app_call_tool\|turnMcpNote\|connected_apps\|appToolsDeferred\|APP_TOOLS_INLINE_MAX\|TURN_MCP_" packages apps docs`）。
- [x] 发现的问题交回对应执行者修复，修完再复核（修复见实施记录「P3 评审修复」；复核由调度会话做）。

## P4 收口（调度会话）

- [x] 全量 `pnpm typecheck` + `pnpm lint`。
- [x] 容器内全量测试跑**一次**（`node scripts/run-tests.mjs run`），与基线对比（`docs/dev/05-testing.md` / `docs/dev/PROGRESS.md` 记录的最近基线），新增失败为零；偶发失败只单跑该文件复核。
- [x] 更新 `docs/dev/PROGRESS.md`（如该文件按惯例记录每个 D 的落地）。
- [ ] 向用户汇报，等用户决定提交 / 合入 main。

## 实施记录

（各阶段执行者在此追加）

### P0（执行者 A，2026-10-16）

**改动文件**

- shared：`constants.ts`（`APP_TOOLS_INLINE_MAX`→`EXTERNAL_TOOLS_INLINE_MAX`、`APP_SEARCH_RESULTS_MAX`→`CAPABILITY_SEARCH_RESULTS_MAX`、`TURN_MCP_READ_TOOLS_MAX`→`SUBAGENT_MCP_READ_TOOLS_MAX`、删 `TURN_MCP_RESOLVE_TIMEOUT_MS`、新增 `CAPABILITY_RESOLVE_TIMEOUT_MS`=10s / `TASK_CAPABILITIES_MAX`=8）、`domain/host-capabilities.ts`（新增 `CAPABILITY_SEARCH_TOOL` / `CAPABILITY_CALL_TOOL` / `CAPABILITY_DISCOVERY_TOOLS`；描述符增 `sharedTools`，`mcp` 与 `apps` 都登记；`capabilityOfTool` 认 `sharedTools`；`isHostToolInjected` 任一共有包选中即注入）。
- core 新增：`capabilities/catalog.ts`（`CapabilityEntry`、`buildCapabilityCatalog`、`readyCapabilities`、`markUnavailable`、`STATUS_TEXT`）、`capabilities/prompt.ts`（`capabilitiesPromptBody`）、`capabilities/discovery.ts`（`createCapabilityDiscovery`、`formatCapabilitySearch`）、`tools/capability-tools.ts`（`buildCapabilityTools`）。
- core 修改：`apps/discovery.ts` 删除（泛化迁入 `capabilities/discovery.ts`）；`apps/prompt.ts`（只留 `oneLine` / `REASON_TEXT` / `availableAppsPromptBody` / `APP_REQUEST_CONNECTION_RULE`）；`apps/exposure.ts`（删 `appToolsDeferred`，增 `ConnectedApps.connectionStatus`）；`mcp/tools.ts`（`McpToolResolution.failed`、`McpToolFacade` 去 `omitted`、`selectReadOnlyMcpEntries` 默认上限改名）；`tools/app-tools.ts`（去发现门面与两个旧工具）；`tools/index.ts`（`ResponseToolDeps.capabilities`；对话轮放 `capabilityTools` 不放 `mcpTools`；任务放 `mcpTools` + `capabilityTools`；`buildSubagentResearchTools` 增 `capabilities`）；`dispatch/orchestrator.ts`（见下）；`agent/context/system-prompt.ts`（删 `turnMcpNote` / `mcpTurnNote` / `connectedApps`，增 `capabilities` 段，两种引擎模板、平台规则条件、ACP 规则表补两件套，`<tool_policy>` 不认领两件套）；`agent/effects/classify.ts`、`settings/context.ts`、`agent/types.ts`（改名）；`agent/external/capabilities.ts`（共有工具注入、不加「补充能力」前缀、`READ_ONLY_TOOLS` 改名）。
- desktop：`features/chats/tool-labels.ts`（两件套展示名）。
- 测试：见下。

**orchestrator 要点（P1 执行者接手点）**

- 每个 run 先 `buildCapabilityCatalog(...)`（纯读取）。`scopeCaps` = ready 能力（外部智能体任务按所选能力包过滤：`apps`↔目录连接、`mcp`↔自定义 MCP，`#externalCapabilityKinds`）。
- 对话轮：不解析任何工具；`discovery = createCapabilityDiscovery({ surface:'turn', capabilities: scopeCaps, resolve: #resolveCapabilityTools(servers,false), include: allowedOnReadOnlySurface })`，`toolDeps.capabilities = discovery`。
- 任务：`taskResolution = await #resolveCapabilityTools(自定义 MCP 在前、应用在后的 scopeCaps 的 server, true)`（**P1 在这里改成只解析「声明 ∩ 目录且 ready」的能力**）；`appsDeferred = 应用工具数 > EXTERNAL_TOOLS_INLINE_MAX`（**P1 改为按声明能力的工具总数**）；内联 = `mcpEntries` → `toolDeps.mcp`；任务面 `discovery` 的范围 `taskDiscoveryCaps` = 被推迟的应用能力 + 列工具失败的能力（`include` 恒真，已解析好的直接复用 `taskEntries`，其余走真实懒解析）——**P1 把「未声明的 ready 能力」并入 `taskDiscoveryCaps` 即可**（它们走真实懒解析，`countFailures:true`）；`mountedIds` 供 `capabilitiesPromptBody({surface:'task', mounted})`。
- 子代理：`subInline = selectReadOnlyMcpEntries(mcpEntries)`（对话轮为空）；子 run 各自 `createCapabilityDiscovery({ surface:'subagent', capabilities: scopeCaps, include: 只读+auto, exclude: subInline 的名字 })`。P1 把 `capabilities: scopeCaps` 换成「任务可达的全部能力」即可（目前恰好是全部）。
- `#appToolFacade` 去掉 discovery 参数；`unavailable` 是可变数组（任务解析的授权问题 + 两件套懒解析时 `onAuthRequired` 追加），自定义 OAuth server 的 `reason` 在没有实时信号时取连接行状态（`not_connected`/`needs_scope`/其余 `expired`）。

**接口**

- `buildCapabilityCatalog({ connectedApps: Pick<ConnectedApps,'forBot'|'connectionStatus'>|null, mcp: Pick<McpService,'serversForBot'>|null, appConnectionIds, mcpServerIds }) → { entries: CapabilityEntry[]; apps: BotAppsExposure }`；`CapabilityEntry` 增字段 `toolPrefix`（`app_{slug}_` / `mcp_{serverId}_`）与 `tier`；`markUnavailable(entries, unavailable)`；`readyCapabilities(entries)`。
- `capabilitiesPromptBody({ entries, surface:'turn'|'task', mounted?, hasDiscovery })`。
- `createCapabilityDiscovery({ surface:'turn'|'task'|'subagent', capabilities, resolve(servers), wrap(entries), include(entry), exclude?, onAuthRequired?, timeoutMs?, logger? }) → { search({query, capability?}), call(name,args,ctx), originOf(name) }`。解析按能力逐个、并行；超时 / 连不上的能力不缓存（下次 search 重试）；授权问题与成功结果缓存。索引会丢弃与内置 `app_request_connection` 等同名的工具并告警。

**测试**

- 新增：`unit/capability-catalog.test.ts`（12 个 it，状态映射参数化后 19 例）、`unit/capability-discovery.test.ts`（18）；`shared/test/unit/agent-catalog.test.ts`（共有工具注入）；`unit/external-agent-p2.test.ts`（外部智能体两件套注入）；`unit/app-prompt-capabilities.test.ts`（两件套规则行）；`integration/connected-apps-p2-discovery-acp.test.ts` 增「只选 mcp 包」一例。
- 改写：`unit/app-step-up-discovery.test.ts`（只留 step-up / wrapMcpTool / buildAppTools）、`unit/app-exposure.test.ts`、`unit/mcp-tools-auth.test.ts`、`unit/app-prompt-capabilities.test.ts`、`unit/settings-catalog-host.test.ts`、`unit/tool-effects.test.ts`（扫描名单加 `capability-tools.ts`）、`unit/mcp-tools.test.ts`；`integration/mcp-loop.test.ts`（对话轮零 listTools、两件套、写入名被拒、改 ask 后不进索引、调用时 `RUN_READ_ONLY`）、`app-tools-e2e`、`app-exposure-e2e`、`connected-apps-e2e`、`connected-apps-runtime`、`connected-apps-p1-gate`（含 `searchTurn` 助手）、`connected-apps-p1-gate-acp`、`connected-apps-p2-discovery-acp`、`connected-apps-p2-stepup-discovery`、`app-tool-lock`、`local-connectors`。
- 结果（容器 `kepcup-test:trixie`，`node scripts/run-tests.mjs run`）：最终一轮：core + shared 全部单元测试与相关集成 / contract 测试共 260 个文件 3420 例全部通过。另 `external-agent-p3` 的「agent write task holds the project lease」在一轮并发跑里失败，是 PROGRESS.md 已记录的环境基线失败（与 main 一致，用例不涉及 MCP / 能力），最终轮未含该文件。
- typecheck：shared / core / desktop 通过；`pnpm lint` 通过。

**与设计的偏差**

1. `McpServer.description` 属 P2：P0 的 `mcp:` 目录行恒用缺省文案（`catalog.ts` 的 `mcpDescriptionOf` 是 P2 接入点）。
2. `<capabilities>` 的对话轮规则行已按终稿写入 `start_task` 的 `capabilities` 参数，而参数本身是 P1 才加——P0 与 P1 之间模型会看到一个尚不存在的参数（工具 schema 里没有它，传了也无效；P1 核对措辞即可）。
3. 状态行格式统一为「状态[（connection_id: …）] —— 说明」（设计示例里 `—— ` 前有无空格不一致，统一带空格）。
4. 授权问题的两件套结果文本写明 `app_request_connection({ connection_id })`；索引撞名丢弃用固定名单（`app_request_connection` 等 + 两件套自身），因为只有 `app_` 前缀的内置工具能与动态工具撞名。
5. 外部智能体步骤归属：两件套在 shared 里归「登记表第一个共有它的包」`mcp`（`bridgeToolMeta` 的 `capability` 字段；只影响统计，两包的 `overlapsNative` 都是 null）。
6. 对话轮任务由 `runs.retry` 续跑后工具面不再有「run 开头已解析」的概念，授权问题只在 `capability_search` / `capability_call` 当次出现，提示词里的状态来自连接行（`reconnect`）。

**遗留 / 注意**

- 对话轮的 `capability_call` 在「本 run 没有 search 过」时一律拒绝（提示先 search），跨 run 不继承索引；模型凭历史记忆直接调用工具名会多一步。
- 旧名字仅作为「由…改名」的历史注释残留在 `capability-tools.ts` / `capabilities/prompt.ts` / `constants.ts` / `system-prompt.ts` / `app-prompt-sanitize.test.ts` 的注释与字面量里，P3 的 grep 会命中这几处注释。

### P1（执行者 B，2026-10-16）

**改动文件**

- 迁移 `packages/core/migrations/runs/0012_task_capabilities.sql`（`runs.task_capabilities TEXT`，迁移按目录下 `NNNN_*.sql` 连续编号自动发现，`runMigrations` 要求连续；无清单文件）。
- shared：`domain/types.ts`（`Run.taskCapabilities: string[] | null`；`taskEventContentSchema.capabilities?`；`TaskView.capabilities?`）。
- core：`domain/runs.ts`（读写 `task_capabilities`；空数组存 NULL）、`domain/messages.ts`（`appendTaskEvent.capabilities`，brief 带声明）、`tools/task-tools.ts`（`start_task.capabilities` 参数 / 校验 / 描述，`StartTaskInput.capabilities`，`StartTaskResult.notReadyCapabilities`，`TaskSummary.capabilities`）、`agent/context/tasks-segment.ts`（`<tasks>` 行带「能力：…」）、`dispatch/tasks.ts`（`TaskHostDeps.capabilitiesOf(botId): {id, ready}[]`；`start` 校验 id、接续取并集、落库、brief；`retry` 沿用；`view` / `#summary` 暴露）、`dispatch/orchestrator.ts`（`#capabilityCatalog(bot)` 复用；`capabilitiesOf` 注入 TaskHost；任务装配改为按声明挂载，见下）、`capabilities/prompt.ts`（对话轮规则行补「没列出的任务里也能用，但要先查一步，更慢」，与 `start_task` 描述一致）。
- testkit：`viaTask({ capabilities })`。
- 设计稿 `40-capability-mounting.md` §2.2 示例规则行同步改了同一句。

**orchestrator 任务装配（最终形态）**

- `declaredCaps = scopeCaps ∩ exec.task.taskCapabilities`（scopeCaps = ready 能力，外部智能体按能力包过滤）；只对它们 `#resolveCapabilityTools(…, true)`。
- 声明能力已启用工具总数（应用 + 自定义 MCP 一起算）> `EXTERNAL_TOOLS_INLINE_MAX` → 一个都不内联（`declaredDeferred`）；否则全部逐个挂（`mcpEntries`）。
- 任务面 discovery 范围 `taskDiscoveryCaps` = 未声明的 ready 能力（真正懒解析，`countFailures:true`）+ 被推迟的声明能力 + 列工具失败的声明能力（授权已失效的不进）；已解析的声明能力复用 `taskEntries`。
- `mountedIds` = 实际内联的声明能力。子代理 `subCaps` = scopeCaps 去掉授权已失效的（= 任务可达的全部能力），`subInline = selectReadOnlyMcpEntries(mcpEntries)`。
- §8.4 宿主内部 `#taskHost.start` 不传能力 → `task_capabilities` NULL → 全部经两件套（走的是与「未声明」相同的代码路径，由未声明用例覆盖）。

**测试**

- 新增 `integration/capability-mounting-tasks.test.ts`（9 例：声明挂载 / 行与 brief / 工具列表只含声明能力 + 两件套 / 提示词「本任务已挂上」；未声明全经两件套且 `capability_call` 成功；>40 工具不内联；未知 id → INVALID_INPUT 且列出可用 id、不建任务；无能力的 Bot；`continues_task_id` 并集；排队期间取消勾选后不再挂（取消勾选会按 W3 中断同 Bot 运行中的任务，用例据此构造）；retry 沿用；子代理只读子集 + 两件套）；`unit/task-tools-capabilities.test.ts`（5 例：schema / 去重 / 非法值 / 上限 / not-ready 提示 / `<tasks>` 行）。
- 现有任务里调用 `mcp_*` / `app_*` 的集成用例按新语义加 `capabilities`：approvals、app-tool-lock、app-tools-e2e、connected-apps-{e2e,p1-gate,p1-gate-acp,p2-egress,p2-stepup-discovery,p3-tier-directory,runtime}、local-connectors(-review)、mcp-apps-ui(-approvals)、mcp-loop、tasks-interrupt、tool-effects、task-subagent-read-only、security/{connected-apps-tokens,mcp-apps-ui-tokens}、support/mcp-apps-ui-env；`create-core` 迁移版本 11 → 12。`connected-apps-p1-gate` 的「重试」用例改为经 `capability_search` / `capability_call` 到 Notes（原任务因 Bot 当时没有 Notes 而未声明，见遗留）。
- 结果（容器）：`packages/core` + `packages/shared` + `packages/testkit` 全量一轮：4151 例，失败 31，其中本阶段造成的 3 个文件（p1-gate、connected-apps-tokens、mcp-apps-ui-tokens）已修并复跑通过；其余为环境基线（environment、external-agent-p3、projects、skills、skills-authoring、wiki-url、workspace-tools、sandbox/*），另 `tasks-review-fixes-e` 的 L5/L6 用例断言 `changes` 非空，而 `#describeTaskWorkdir` 早已「退役 changes 永远 null」，与 MCP / 能力无关，属既有陈旧断言。
- typecheck（shared / core / desktop）+ `pnpm lint` 通过。

**偏差**

1. 未改 desktop 任务卡 UI：`TaskView.capabilities` 已带出，界面展示留作后续（计划里的「任务卡可见」只做到数据层 + `<tasks>` 段）。
2. `capabilitiesOf` 返回 `{id, ready}` 而不是纯 id 列表，用来在 `start_task` 结果里提示「声明了但当前不是 ready 的能力不会挂上」。
3. 阈值按设计 §4.2 把自定义 MCP 也计入总数（旧行为只算应用工具、MCP 始终内联）。
4. 不在目录里的 id 校验；接续取并集时不再按当前目录过滤（启动时与目录求交已保证不挂失效能力）。

**遗留 / 给 P2 的提示**

- 「应用未连接 → `app_request_connection` → 任务失败 → 连接后 `runs.retry`」链路：原任务发起时 Bot 没有该应用，无法声明；retry 沿用空声明，续跑的任务经两件套访问该应用（多一步 search）。如要无感，可在 setup 链路上对 connect-app 重试自动补声明——未做。
- 讨论 P2 邮箱 / `McpServer.description` 时，`capabilities/catalog.ts` 的 `mcpDescriptionOf` 仍是 P2 接入点；文档修订清单里 30 §4.1 要写 `start_task.capabilities`、`runs.task_capabilities`、TaskView / brief 的 `capabilities`。
- 部分测试文件经 prettier 重排（仓库里这些文件原本未格式化），diff 里有少量纯格式变化。

### P2（执行者 C，2026-10-16）

**改动文件**

- 邮箱门控：`core/src/tools/mail-tools.ts`（`buildMailTools` 增必填 `bound: boolean`——真 → 五个读写工具，假 → 只有 `mail_request_setup`；新增 `mailBoundFor(mail, botId)`；`mail_accounts` 的「没有邮箱」分支简化为不再指向已不存在的 `mail_request_setup`）、`tools/index.ts`（`ResponseToolDeps.mailBound?`，缺省按 `mail.accountsForBot` 现算；`mailTools` 在对话轮与任务两个分支共用同一份）、`dispatch/orchestrator.ts`（run 开头算一次 `mailBound`，同时喂 `toolDeps.mailBound` 与提示词 `hasMailTools` / `hasMailSetup`）、`agent/context/system-prompt.ts`（`hasMail` → `hasMailTools` / `hasMailSetup`，`mailRequestSetupRule` 只随 `hasMailSetup`；外部引擎模板的规则表本来按 `mail_request_setup` 工具是否注入门控，无需改）、`mail/prompt.ts`（规则措辞改成「没有绑定、没有 mail_* 工具」）。desktop `bot-panel/agent-capabilities.ts`（`toolCountOf('mail')` 6 → 5：两组工具互斥，任一时刻最多 5 个；文案本来就是「预计注入」，不用改）。
- `McpServer.description`：shared `domain/types.ts`（`description: z.string().max(200).optional()`）；core `capabilities/catalog.ts`（`mcpDescriptionOf` 读它，经 `oneLine` 清洗，空白 → 缺省文案；MCP 设置读写本来是整份 JSON 透传，无需改动）；desktop `features/settings/McpSection.svelte`（编辑 / 新建表单加「用途说明（可选）」输入，列表卡片显示说明）、`mcp-server-patch.ts`（`withNormalizedDescription` 保存前 trim / 截 200 / 空串去字段，`MCP_DESCRIPTION_MAX`；`editedServerForSave` 是通用的逐键 diff，无需改）、`i18n/locales/zh-CN.ts`（`settings.mcpDescription*` 三个键）。
- 任务卡（P1 遗留）：`features/tasks/task-view.ts`（`TaskCardModel.capabilities`）、`TaskCard.svelte`（标题下一行小字「能力：app:github、mcp:notes」，无声明不显示）、`zh-CN.ts`（`task.capabilities`）。
- 文档：design 23 / 28 / 29 / 30 / 35 / 38（邮件规则门控一句话）各加「D91 修订」并链接 40，旧内容保留；dev 04（`<capabilities>` 段与示例、两件套 / 懒解析 / 索引范围 / 任务挂载 / 子代理 / ACP 的「能力按需发现与任务挂载」段、`start_task.capabilities`、`<tasks>` 行的「能力：」、工具目录 `capability_*` / `mail_*` / `mail_request_setup` 行；旧的 `<connected_apps>` / `<mcp_tools>` / `app_search_tools` 段落是现状文档，直接改写而不是留历史）；dev 03（`runs.task_capabilities`、brief 事件 `capabilities`、`McpServer.description`）。

**测试**

- 新增：`unit/mail-gating.test.ts`（`buildResponseTools` 对话轮 / 任务各 4 例：0 绑定、1 绑定、`mailBound` 显式值优先、无 Bot）；`integration/capability-mounting-p2.test.ts`（真实 core + 假 IMAP / SMTP：未绑定的一轮只有 `mail_request_setup` 且提示词带规则，`mail.accounts.create` 绑定后的下一轮——与 `runs.retry` 重建工具同一路径——拿到五个工具、无 `mail_request_setup`、提示词无规则；`description` 经 `settings.update` 落库、进 `<capabilities>`、`<` `>` 被清洗、没填的写缺省文案）；`unit/capability-catalog.test.ts` 增 2 例（description 与缺省 / 清洗）；`shared/test/unit/connected-apps.test.ts` 增 2 例（schema 可选 / ≤200）；desktop `mcp-server-patch.test.ts` 增 3 例、`task-view.test.ts` 增 1 例、`agent-capabilities.test.ts` 增 1 例。
- 改写：`unit/mail-request-setup.test.ts`（`bound` 参数、互斥断言、`mail_accounts` 空分支）、`unit/context-assembly.test.ts`（`hasMail` → `hasMailSetup`，加规则出现条件用例）。
- 结果（容器）：定向 30 个文件 379 例全过；另整跑 `packages/shared` + `apps/desktop/src` + `packages/core/test/unit`：323 个文件 3836 例全过。
- typecheck（shared / core / desktop）+ `pnpm lint` 通过。

**与设计 / 任务书的偏差**

1. `buildMailTools` 没有拆成两个函数，而是加必填参数 `bound`；判定放在 `tools/index.ts` / orchestrator（`mailBoundFor`），所以 orchestrator 的提示词布尔与工具注册同源、run 内只判定一次。
2. `hasMailTools` 目前只作为「邮件读写工具已注册」的标记传入提示词输入，没有任何规则依赖它（`<mail_accounts>` 段本身已覆盖有绑定的情形）；保留它是按任务书拆分，并有测试断言它不会带出 `mail_request_setup` 规则。
3. `MAIL_REQUEST_SETUP_RULE` 文案按新语义改写（原文里「若你已有绑定邮箱……直接用 mail_*」「一次性看信仍用 mail_*」在门控后不会再被模型看到、且会误导）。有绑定的 Bot 因此看不到「要接过另一个 Bot 的邮箱 → 找持有者或管家发起 propose_handover」那句指引（它只随 `mail_request_setup` 出现，设计 §6 如此规定）；管家规则 `BUTLER_RULES` 里仍有 `propose_handover` 的说明。
4. 桌面只有 `zh-CN` 一份 locale（没有英文文件），所以「中英文都加」只加了中文键。
5. MCPB 包安装（`apps/mcpb/install.ts`）没有把 manifest 的描述写进 `description`；设计只要求「预置目录将来带说明时安装一并写入」，目前预置目录为空，未做。
6. dev 04 里旧的 `<connected_apps>` / `app_search_tools` 段落直接改写成现状（dev 文档按现状维护），design 文档则按惯例保留原文并加「D91 修订」。

**遗留 / 后续项**

- 「应用未连接 → `app_request_connection` → 连接后 `runs.retry` 复用原声明（为空）」的缺口**未实现**：重连后续跑的任务原声明为空，只能经两件套访问该应用（多一步 search）。要无感的话，可在 `connect-app` setup 完成、`runs.retry` 时把新连接的 `app:{slug}` 补进该任务的 `task_capabilities`（需 setup 链路传递连接结果）。
- 有绑定邮箱的 Bot 想再加一个邮箱时，模型没有 `mail_request_setup`，只能指路「扩展中心 → 邮件」（`decideMailSetupRequest` 的拒绝文案本就如此建议）。
- `hasMailTools` 暂无规则消费者，若 P3 评审认为多余可删。

### P3 评审修复（执行者，2026-10-16）

逐条（先核实再改）：

- **m1 `capability_search` 不响应 abort**：已修。`CapabilityDiscovery.search(input, signal?)`，`capability_search` 的 `execute` 把 `ctx.signal` 传进去；`ensure` 的 race 加 abort 分支（入口已 abort 则直接返回、不启动任何解析），返回 `{ cancelled: true }`，工具回 `ok:false, errorCode:'CANCELLED'`「执行已取消，未完成能力查找」。**没有**把 signal 透传给 `resolve` / `resolveMcpToolEntries` / `McpService.listTools`：解析的 pending Promise 按能力在 run 内共享（并行 search 复用同一个），连接又被 `McpService.#pending` 跨调用共享（`#ensureConnected` 不收 signal），透传会让一次取消打断别人在等的解析；只在本次等待层 race，被放弃的解析在后台跑完（`MCP_CONNECT_TIMEOUT_MS` 兜底）并照常缓存。代码注释已写明原因。测试（`capability-discovery.test.ts`）：abort 后 search 立即返回（timeout 设 60s 仍秒回）、入口已 abort 不启动解析、abort 不破坏共享解析（之后的 search 仍拿到结果且只解析一次）、`buildCapabilityTools` 的 execute 收到已 abort 的 ctx 返回 `CANCELLED`。
- **p1 永久不可达的服务器每次 search 都重试**：核实结论——**没有**退避。`McpService.#ensureConnected(server, countFailure)` 只在 `countFailure:true` 时累加 `#failures`，到 `MCP_RECONNECT_MAX` 才抛 `MCP_SERVER_FAILED`；对话轮的 `resolveMcpToolEntries` 传 `countFailures:false`，失败既不计数也无冷却，`#connect` 每次都真的重连，`listTools` 失败（非授权）直接抛出；对话轮因此对永久不可达的服务器每次 search 都白等一轮连接（任务有预算，但也只是次数上限，不是时间退避）。修法：shared 新增 `CAPABILITY_UNREACHABLE_COOLDOWN_MS = 30_000`；discovery 对 `failed`（及解析抛错）的能力记冷却截止时刻（`createCapabilityDiscovery` 新增可注入的 `cooldownMs` / `now`，orchestrator 传 core `clock`，对话轮 / 任务 / 子代理三处共用同一个 run 内实例或各自实例），冷却期内 `ensure` 不重连，结果里直接报「暂时不可达」；冷却结束后下次 search 才重试，成功即清除冷却，再失败再冷却。测试：失败 → 冷却内（即使服务器已恢复）不重连且健康能力不受影响 → 冷却后重试成功；仍失败的服务器重试后重新进入冷却（4 次 search 只解析 2 次）。原用例「失败后下一次 search 重试」改为带冷却的版本。
- **m3 能力 id 进提示词没清洗**：已修，选「规范 id」而非 schema 正则。`catalog.ts` 新增 `safeIdText`（只留字母 / 数字 / `._:-`，其余换 `_`，空 → `_`），目录条目 id 用 `app:{safeIdText(slug)}` / `mcp:{safeIdText(server.id)}`，撞名加 `_2` 序号；`toolPrefix` 用与真实工具名（`mcpToolName`）一致的 `[A-Za-z0-9_-]` 替换。`start_task` 校验（`capabilitiesOf`）、任务挂载、`capability_search` 的 `capability` 匹配都基于目录条目的 id，所以显示的 id 与校验 / 挂载认的是同一个；到真实 server 的映射在 `entry.server`，不靠 id 反解。`reconnect` 行的 `connection_id` 与 `capability_search` 结果里的 `connection_id: "…"` 经 `safeIdText` 输出（不可信 id 的连接 id 因此不是可解析值，工具会拒绝并给出可读报错——边缘情形，换取不能逃出本段）。理由：给 `McpServer.id` 加 schema 正则会让存量里不合规的 id 整份 MCP 设置读不出来；生成的 id（`mcp_{时间}`）和目录 slug 本来就是规范形式，对现有数据与测试几乎零影响（全部既有用例未改即通过）。测试（`capability-catalog.test.ts`）：带 `</capabilities>`、换行、引号、伪造 `- app:fake` 行的 id 不能逃出本段；撞名清洗后 id 各异；规范 id 不变；reconnect 行不输出不安全 id。
- **m4 混合场景测试**：已补。`connected-apps-p2-discovery-acp.test.ts` 的 `setupEnv` 增 `withCustomMcp`（无认证 HTTP 自定义 MCP `open`，经 `mcp.refreshTools` + `apps.connections.reviewTools` 过工具锁），新增两例：只选 `mcp` 包 → 外部智能体经桥 `capability_search`（空 query 浏览）只得到 `mcp_open_echo`、无 `app_notes_*`，`<capabilities>` 只含 `mcp:open`；只选 `apps` 包 → 反过来。
- **n1 `app_request_connection` 规则出现条件**：已修。`SystemPromptInput` 新增 `hasAppRequestTool`，规则只在它为真时追加；orchestrator 以 `appFacade !== undefined`（即 `app_request_connection` 实际注册的条件）传入。测试：`app-prompt-capabilities.test.ts` 改为带 flag，新增「只有 `<capabilities>`（stdio MCP）没有该工具 → 无规则」。
- **n2 外部智能体任务的 `<capabilities>`**：已修。orchestrator 的 `promptCapabilities` 在 `markUnavailable` 之后按 `externalKinds` 过滤（内置引擎 `externalKinds === null` 不变）。`connected-apps-p2-discovery-acp.test.ts` 里承认该问题的断言改为：只选 `mcp` 包且无自定义 MCP 时提示词不含 `app:notes`、不含 `<capabilities>` 段；m4 两例也断言 `<capabilities>` 只列选中包的能力。
- **n3 删除 `hasMailTools`**：已删（`system-prompt.ts` 两处类型字段与 orchestrator 传参）；`context-assembly.test.ts` 去掉只断言它的两行；`hasMailSetup` 保留。design 40 / 35 / 38、dev 04 里相应文字同步。
- **m2 文档残留**：`docs/dev/01-conventions.md` 常量表改为 `SUBAGENT_MCP_READ_TOOLS_MAX`、删 `TURN_MCP_RESOLVE_TIMEOUT_MS`、补 `CAPABILITY_RESOLVE_TIMEOUT_MS` / `CAPABILITY_UNREACHABLE_COOLDOWN_MS` / `CAPABILITY_SEARCH_RESULTS_MAX` / `TASK_CAPABILITIES_MAX` / `EXTERNAL_TOOLS_INLINE_MAX`；`02-architecture.md` 把 P2 的 `apps/discovery.ts` 行改写成 `capabilities/{catalog,discovery,prompt}.ts` + `tools/capability-tools.ts` 的现状行，`apps/prompt.ts` / `apps/exposure.ts` / `tools/app-tools.ts` 行改成现状；`04-agent-runtime.md` 去掉旧常量 / 旧工具名的「取代」说明，补取消 / 冷却 / 规范 id / 规则条件 / 外部智能体 `<capabilities>` 过滤；`05-testing.md`、`DEVIATIONS.md` 的 `<connected_apps>` / `app_*_tool` 改为现状；`design/38` 的 `APP_REQUEST_CONNECTION_RULE` 条目改为新条件（D91 修订）；`design/23` 一处补 D91 注；`design/40` 新增 §11「P3 评审修订」。`docs/dev/PROGRESS.md`：表里补 D91 一行（已实现、未合入；全量待调度会话收口时补），D73 P1 / P2 的历史记录保留原文、仅在两处加「D91 起已泛化」注。全仓复查 `grep -rnE "connected_apps|app_search_tools|app_call_tool|appToolsDeferred|apps/discovery\.ts|TURN_MCP_|APP_TOOLS_INLINE_MAX" docs`：dev 文档剩余命中只在 PROGRESS 的 D73 历史记录与 D91 新行（说明「取代」）里；design 文档的命中都在 D91 修订说明或 D91 之前的历史叙述处。

**测试 / 检查**

- 容器内定向 21 个文件 227 例全过：`capability-catalog` / `capability-discovery` / `context-assembly` / `mail-gating` / `app-prompt-capabilities` / `app-prompt-sanitize` / `tool-effects` / `external-agent-engine` / `settings-prompt-acp` / `app-step-up-discovery` / `connected-apps-p2-discovery-acp`（4 例，含 m4 两例）/ `connected-apps-p2-stepup-discovery` / `capability-mounting-p2` / `capability-mounting-tasks` / `mcp-loop` / `app-exposure-e2e` / `app-tools-e2e` / `app-tool-lock` / `connected-apps-p1-gate` / `connected-apps-p1-gate-acp` / `task-subagent-read-only`。
- shared / core / desktop typecheck 通过；`pnpm lint` 通过（shared 导出新增常量后先 build 了 shared 与 core）。

**遗留**

- 按任务书不处理：n4（prettier 重排）、`capability_call` 须先 search 的语义、重连后不自动补声明。
- 冷却期内的能力在结果里与「超时未返回」一样只报「暂时不可达」，没有单独的「冷却中」措辞（模型行为相同：稍后再试）。
- 带不安全字符的 OAuth 自定义 MCP 的 `connection_id` 在提示词里是清洗后的文本，`app_request_connection` 会拒绝；这类 id 只可能手写进设置，生成的 id 不受影响。

### P4 收口（2026-10-16，调度会话）

- `pnpm typecheck`、`pnpm lint` 全部通过。
- 容器全量 `node scripts/run-tests.mjs run`：461 文件 / 5306 用例，28 失败 / 10 文件：environment、external-agent-p3（项目租约）、projects（OS 沙箱端口）、skills / skills-authoring（es-git）、wiki-url、workspace-tools（沙箱执行）、sandbox/* 均为已记录环境基线；tasks-review-fixes-e 为 main 已在 fab5ee5 修复的旧问题（本分支基于 d5122cf）。无新增失败。
- 未提交；合入 main 前需先提交本分支并合入最新 main（main 的 fab5ee5 也改了 `mcp-apps-ui.test.ts`，可能冲突），合后复跑冲突文件。
- 后续项：重连新应用后 `runs.retry` 不自动补声明；`capability_call` 须先 search；diff 中的 prettier 重排（n4）。

### 后续改动（用户 2026-10-16 决定）

三项：连好应用后任务重试自动补声明；对话里给 Bot 绑定更多邮箱；MCP 服务器 id 在参数校验层拒绝不合规值。设计见 `docs/design/40-capability-mounting.md` §4.1 / §6 / §12。

#### 一、连接新应用后，任务重试自动补声明

**核实结论**

1. **重试路径**：`runs.retry` → `orchestrator.retryRun` 对 `loopType === 'task'` 且 `failed|interrupted` 的 run 直接转 `TaskHost.retry`（`dispatch/tasks.ts`），重建简报、新建 run 时 `taskCapabilities` 来自失败任务行。
2. **setup 需求存放处**：失败 run 行的 `setup` 字段（`runs.error_json` 里的 `setup`，`Run.setup`），任务结算时由 `outcome.setup` 写入；`app_request_connection`（orchestrator `#appToolFacade` 写 `setupHit`）与应用工具授权失效（`mcp/tools.ts` 的 `onSetupRequired`）产生的都是 `{kind:'connect-app', target:{kind:'catalog', connectorId}|{kind:'custom', serverId}, …}`。目录目标的 `connectorId` 就是目录 slug（`view.slug`），与 `catalog.ts` 的 `app:{slug}` 同一个值。
3. **连好后是否自动加入 Bot 的 `app_connection_ids`**：已有现成逻辑，没有改。连接卡（`ConnectAppPanel`，默认勾选「连接后授权给当前 Bot」）把 `grantBotId` 交给 `apps.connect`，core 在流程完成时 `BotAppGrantWriter.grant(botId, connectionId)`（`BotsService.grantConnection`，同应用已有别的账号则替换）。即「连接卡由哪个 Bot 发起就绑给哪个 Bot」。用户在卡上取消勾选则不绑，此时并入的 `app:{slug}` 在目录里不存在，挂载取「声明 ∩ 目录 ready」，等于不挂，安全。集成用例里直接断言了连好后 Bot 的 `app_connection_ids` 含该连接。

**改动**

- `capabilities/catalog.ts`：导出 `appCapabilityId(slug)` / `mcpCapabilityId(serverId)` 与 `capabilityIdOfSetup(requirement)`（`connect-app` + catalog 目标 → `app:{connectorId}`；custom 目标 → `mcp:{serverId}`；其他 → null）。
- `dispatch/tasks.ts`：`TaskHost.retry` 用新的 `#retryCapabilities(task)` 取代「直接沿用」：沿用失败任务声明，再并入 setup 指向的能力 id；已声明不重复；`declared.length + 1 > TASK_CAPABILITIES_MAX` 时不并入并 `logger.warn`；失败任务本来没有声明（NULL）时声明就是这一个 id。落库的 `task_capabilities` 与新简报事件的 `capabilities` 用同一份。宿主挂载逻辑（声明 ∩ 当前目录 ready）未动。对话轮的重试走对话轮重放，不经这里，不受影响。

**测试**

- `integration/capability-mounting-tasks.test.ts` 新增 4 例：custom 目标并入 `mcp:beta`（行 + 简报 + 工具内联）；未声明的任务 + catalog 目标 → 声明只有 `app:github`；已声明不重复、`mail-account` setup 不动声明；超过 `TASK_CAPABILITIES_MAX` 时不并入。
- `integration/connected-apps-p2-stepup-discovery.test.ts` 新增 2 例（假 OAuth MCP 服务器，真实连接流程）：任务调 `app_request_connection` → 失败 → `apps.connect`（带 `grantBotId`，断言 Bot 的 `app_connection_ids` 含该连接）→ `runs.retry` → 新任务 `taskCapabilities == ['app:notes']`、`app_notes_list_notes` 内联且调用成功，重复 retry 仍是幂等的同一个任务；对话轮触发的 connect-app 重试后没有任务、所有 run 的 `taskCapabilities` 为 NULL。
- 改写 `integration/connected-apps-p1-gate.test.ts` 的 §5.11 端到端：重试后不再「经 `capability_search` / `capability_call` 访问 Notes」（P1 记录里的已知缺口），改为断言 `retried.taskCapabilities == ['app:notes']`、`app_notes_create_note` 内联、提示词「本任务已挂上：app:notes」、不注册两件套。
- `unit/capability-catalog.test.ts`：`capabilityIdOfSetup`。

#### 二、对话里支持给 Bot 绑定更多邮箱

**改动**

- `tools/mail-tools.ts`：`buildMailTools` 在有 `setup` 门面时**始终**注册 `mail_request_setup`；`bound` 为真时另外注册五个读写工具（顺序：五个在前，`mail_request_setup` 在后）。`decideMailSetupRequest` 不再因有绑定而拒绝：已有绑定时返回的消息列出现有邮箱、说明会**新增**一个、原有的保持不变，并提示要转另一个 Bot 的邮箱改用 `propose_handover`；仍保留「不要让用户把授权码贴进聊天」。工具描述改为「用户要接管 / 添加（更多）邮箱时立刻调用；已有绑定也一样，会新增一个」，去掉「已有绑定时不要调用 / 再加账号去扩展中心」。
- `mail/prompt.ts`：`MAIL_REQUEST_SETUP_BASE` 重写为「用户说接管 / 添加（更多）邮箱时立刻调用 `mail_request_setup`；已有绑定也一样，再新增一个；不要索要授权码」，保留普通 Bot / 管家两个版本的 `propose_handover` 指引；不再断言「你目前没有任何已绑定邮箱」。
- `dispatch/orchestrator.ts`：`hasMailSetup` 改为有 `deps.mail` 即为真（与工具注册同源）；`mailBound` 只决定五个读写工具。`agent/context/system-prompt.ts`、`tools/index.ts` 注释同步。
- `mail/service.ts`：`create` 在测连之前检查「同一地址（不区分大小写）已绑给 `botIds` 里的某个 Bot」→ `INVALID_INPUT`。**现状核实**：此前 core 里没有任何重复账号校验（同一地址能建出多个账号、多路监听），任务书写的「按现有校验报错」落不了地，所以补了这一条最小校验（只查同一个 Bot 的绑定，不限制别的 Bot 绑同一地址）。
- desktop `bot-panel/agent-capabilities.ts`：撤销 P2 加的 `mail: -1` 预估修正（现在 6 个工具可同时注入，预估按登记的 6 个计），对应单测改为 6。

**链路核实（对话里的「添加邮箱」卡 → 保存 → 绑定 → retry）**

- 设置卡：`SetupRequiredCard` 把 `mail-account` 转成 `kind:'setting'`（`mail.account`）→ `SettingCardEmbed` 渲染 `MailAccountAddForm`，`bindBotId` 为当前 Bot。**没有**「已有邮箱则不出卡」的门禁（唯一的门禁是「没有当前 Bot 时不嵌入表单」），无需改。
- 保存：表单调 `mail.accounts.create({ …, botIds: [当前 Bot] })`——新建一个账号并只为它写绑定，是追加；该 Bot 的其他账号绑定不动。**没有**使用 `mail.bots.setAccounts` / `setAccountsForBot`（整体覆盖接口，只在扩展中心的 Bot 勾选等处使用）。保存成功 → `onSaved` → `chat.continueAfterSetup` → `runs.retry`，重建的工具与 `<mail_accounts>` 列出全部邮箱。

**测试**

- `unit/mail-request-setup.test.ts`：已有绑定仍得到 `mail-account` 需求（消息含现有地址 / 「新增」/ `propose_handover` / 不贴授权码）；有绑定的 Bot 调用得到 SETUP_REQUIRED；工具描述不再有「不要调用」；有绑定时工具集 = 五个 + `mail_request_setup`。
- `unit/mail-gating.test.ts`：0 绑定只有 `mail_request_setup`；1 绑定 = 五个 + `mail_request_setup`（对话轮 / 任务）。
- `unit/context-assembly.test.ts`：标题与注释同步（规则只随 `hasMailSetup`）。
- `integration/capability-mounting-p2.test.ts`：绑定后下一轮仍有 `mail_request_setup`、提示词规则仍在（含「添加（更多）邮箱」）；已有一个邮箱的 Bot 调 `mail_request_setup` → run 以 `mail-account` setup 失败（不是拒绝）→ 再 `mail.accounts.create` 第二个账号 → 该 Bot 绑定数 2、原绑定仍在 → 同一地址（大小写不同）再建被拒且绑定不变 → `runs.retry` 的提示词里两个邮箱都在。

#### 三、MCP 服务器 id 在参数校验层拒绝不合规值

**id 来源核实**

- 桌面添加表单**不让用户填 id**：`McpSection` 的 `emptyDraft` 生成 `mcp_{Date.now() 的 36 进制}`（现抽成 `newMcpServerId`）；所以没有「可填 id 的表单」，没有加即时校验输入框；改为保存时按同一规则兜一次（`isValidMcpServerId`，不合规 toast `settings.mcpIdInvalid`，中文 i18n）。
- MCPB 安装：`mcpb_${randomBytes(6).toString('hex')}`；预置目录（`mcp-presets`，当前为空）条目 id 的正则是 `[a-z0-9-]`；本机连接 / 目录连接是 `app_connections` 行（`conn_…`），不进 `settings.mcpServers`（另有 `conn_` 前缀保留检查）；`settings.update` RPC 入参用同一个 `mcpServerSchema`；对话内 `settings_change` 的 `mcp.servers` 适配器只改已有服务的 `enabled`，不新增条目。生成的 id 都满足新规则。

**改动**

- shared `domain/types.ts`：导出 `MCP_SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` 与中文 `MCP_SERVER_ID_MESSAGE`；`mcpServerObjectSchema.id` 改为 `z.string().regex(…)`。
- core `domain/settings.ts`（读路径）：设置是整体 zod 解析，一条坏 id 会让整份设置读不出来。`SettingsService.get()` 先逐条 `mcpServerSchema.safeParse`，不合规的条目丢弃并 `logger.warn`（同一条只报一次；`SettingsService` 构造新增可选 `logger`，`start.ts` 传入），其余照常读。写路径（`update()`、`settings.update` 入参）一律拒绝。无迁移：下次保存设置时被丢弃的条目不再写回。
- core `capabilities/catalog.ts`：删除评审修复里的 `safeIdText` / `uniqueId`（撞名序号）；能力 id = `mcp:{真实 id}`；`reconnect` 行与 `capability_search` 授权提示里的 `connection_id`（`custom:{id}`）原样输出（`prompt.ts` / `discovery.ts` 去掉 `safeIdText`）。保留 `toolPrefixSegment`（与真实工具名 `mcpToolName` 一致：id 允许 `.`，工具名不允许）。`buildCapabilityCatalog` 增可选 `logger`：直接构造的非法 id 的 server 被跳过并 warn，不崩、不逃出段（orchestrator 传入 logger）。应用 slug 与 `oneLine` 清洗不变。
- desktop：`mcp-server-patch.ts` 增 `newMcpServerId` / `isValidMcpServerId`，`McpSection.svelte` 用之，`zh-CN.ts` 增 `settings.mcpIdInvalid`。

**测试**

- shared `connected-apps.test.ts`：`mcpServerSchema.id` 正例（含生成形态、64 字符、`.` `_` `-`）、反例（空、65 字符、非字母数字开头、空白 / 引号 / 尖括号 / 冒号 / 斜杠 / 换行 / 非 ASCII、`</capabilities>`）、中文错误信息、`settingsSchema` 整体解析也拒绝。
- core `unit/settings-service.test.ts`：读路径丢弃非法条目、保留合法条目与其余设置、warn 一次、无 logger 不崩；写路径 `update` 拒绝非法 id 且不写库、下次保存时坏条目不再写回。
- core `integration/capability-mounting-p2.test.ts`：`settings.update` RPC 拒绝 `x</capabilities>` / `a b` / `a:b` / `_lead` 且什么都不存，合规 id（`fs-notes.v2`）写入成功。
- core `unit/capability-catalog.test.ts`：原「带 `</capabilities>` 的 id 逃不出本段」改写为「schema 拒绝这样的 id」+ 目录层防御断言（手工构造非法 server：跳过、warn 一次、提示词里无标签 / 伪造行、无 logger 不崩）；id 原样（含 `.`、toolPrefix 随真实工具名）；`reconnect` 行带真实 `connection_id`。
- desktop `mcp-server-patch.test.ts`：生成的 id 满足 shared 规则与 schema；保存兜底与 schema 的接受 / 拒绝集一致。

#### 文档

design 40（决策 6、§2.1、§4.1、§6 重写、§10 验收、§11 的清洗条改注、新增 §12）；design 35（D91 注改为现行版本）、18、28、38、README（D91 行）；dev 02（catalog 行）、03（`McpServer.id` 约束）、04（任务挂载补重试补声明、`<capabilities>` 的 id 说明、邮箱门控两行）、PROGRESS（D91 行）。

#### 验证

- typecheck：`@kepcup/shared` / `@kepcup/core` / `@kepcup/desktop`（svelte-check 0 错）通过；`pnpm lint` 通过（改 shared 导出后先 build shared）。
- 容器 `kepcup-test:trixie`，`node scripts/run-tests.mjs run`：
  - 定向 34 个文件（`capability-*`、`mail-*`、`mcp-loop`、`connected-apps*`、`context-assembly`、`tasks*`、`settings-service`、`mail*` 集成、shared `connected-apps`、desktop `agent-capabilities` / `mcp-server-patch`）：337 例通过，仅 `tasks-review-fixes-e` 的「a running task view does not query the audit log…」失败，是已记录的旧问题（main 已在 fab5ee5 修复，本分支基于 d5122cf，与本次改动无关）。`connected-apps-p1-gate` 的 §5.11 端到端首轮失败是因为它断言旧行为（重试经两件套访问），已按新行为改写，重跑 4 例全过。
  - `packages/shared` 全部 + `packages/core/test/unit` 全部 + `apps/desktop/src` 全部：323 个文件全部通过。

#### 遗留

- 同一地址的重复校验只查「同一个 Bot 已绑定」；同一地址绑给别的 Bot 仍允许建多个账号（既有行为）。
- 取消勾选「连接后授权给当前 Bot」时，retry 并入的 id 因目录里没有该连接而不挂载；任务仍可经提示词指引请用户重连，无新增风险。
- 没有可填 id 的表单，所以没有「输入框即时校验」；若以后加（如预置目录手动安装），沿用 `isValidMcpServerId` 与 `settings.mcpIdInvalid`。
- 存量设置里不合规 id 的 MCP 条目会在读取时被静默丢弃（日志有 warn）；其 Bot 的 `mcp_server_ids` 引用成了悬空 id，目录/挂载对悬空 id 本就忽略。
