/**
 * Tunable parameters (initial values from docs/dev/01-conventions.md, "Tunable parameters").
 * These constants must not be duplicated elsewhere in code.
 */

/** Max number of recent messages injected into context. */
export const RECENT_MESSAGES_MAX = 30;
/** Token budget for injected recent messages. */
export const RECENT_MESSAGES_TOKEN_BUDGET = 4000;
/** Update the rolling summary when unsummarized messages exceed this count. */
export const SUMMARY_TRIGGER_UNSUMMARIZED = 50;
/** Max depth of bot-to-bot @ chains. */
export const BOT_CHAIN_MAX_DEPTH = 3;
/** Total token budget shared by one bot-to-bot chain. */
export const BOT_CHAIN_TOKEN_BUDGET = 200_000;
/** Group-chat triage timeout in ms. */
export const TRIAGE_TIMEOUT_MS = 20_000;
/** Recent messages considered by group-chat triage. */
export const TRIAGE_RECENT_MESSAGES = 10;
/** Number of relevant memory entries injected. */
export const MEMORY_TOPK = 8;
/** RRF parameter for hybrid retrieval. */
export const RRF_K = 60;
/** Profile card token budget. */
export const PROFILE_CARD_TOKEN_BUDGET = 400;
/** Persona token budget. */
export const PERSONA_TOKEN_BUDGET = 800;
/** "My state" token budget. */
export const MY_STATE_TOKEN_BUDGET = 300;
/** Relevant-memory token budget. */
export const RELEVANT_MEMORY_TOKEN_BUDGET = 600;
/** Wiki topic index token budget. */
export const WIKI_TOPICS_TOKEN_BUDGET = 200;
/** Skills list token budget. */
export const SKILLS_LIST_TOKEN_BUDGET = 500;
/** Project info budget (incl. AGENTS.md). */
export const PROJECT_CONTEXT_TOKEN_BUDGET = 1500;
/** Max characters of a single tool output returned to the model. */
export const TOOL_OUTPUT_MAX_CHARS = 30_000;
/** Max turns of a single run. */
export const RUN_MAX_TURNS = 60;

// --- Host SubAgent (delegate_task, docs/design/23-mcp-and-subagent.md D66) ------

/** Max turns of one delegated subagent run. */
export const SUBAGENT_MAX_TURNS = 20;
/** Hard wall-clock budget of one delegated subagent run; over-budget aborts and compresses what exists. */
export const SUBAGENT_TIMEOUT_MS = 600_000;
/** Max characters of the compressed conclusion returned to the main loop. */
export const SUBAGENT_RESULT_MAX_CHARS = 4_000;
/** Max delegations a single response run may perform (serial execution). */
export const SUBAGENT_MAX_PER_RUN = 3;
/** Token budget (input+output) of one delegated subagent run. */
export const SUBAGENT_TOKEN_BUDGET = 150_000;
/** Light-model compression call timeout; failure falls back to truncation. */
export const SUBAGENT_COMPRESS_TIMEOUT_MS = 20_000;
/** Poll interval for the subagent token-budget check (engine has no budget hook). */
export const SUBAGENT_TOKEN_POLL_MS = 5_000;
/**
 * Max lanes one `delegate_task({ tasks })` fan-out call may start (D66 mode C,
 * docs/design/23-mcp-and-subagent.md); a larger request is rejected outright.
 */
export const SUBAGENT_FANOUT_MAX = 4;
/**
 * Max simultaneously *running* background branches per parent run (D66 mode B;
 * D75 §1.2: branches live inside the parent run — conversation-level
 * concurrency belongs to the task layer). Foreground fan-out lanes must also
 * fit under this cap: N + the parent's running background branches ≤ this.
 */
export const SUBAGENT_BACKGROUND_CONCURRENCY = 4;
/**
 * How long a parent run's end (`close()`) waits for its aborted sub runs to
 * settle before moving on (lease release, settle). A sub run that ignores the
 * abort keeps unwinding on its own; its writes are already refused once the
 * parent is terminal / released its lease (D75 writeDenial).
 */
export const SUBAGENT_CLOSE_GRACE_MS = 10_000;

// --- Butler & cross-bot delegation (D70 / D71, docs/design/27-butler-and-delegation.md) ---

/**
 * Max delegation depth (D71). First release is single-hop for every initiator
 * — the butler included: a delegated run may not delegate again (a 2-hop
 * chain would paste B's "已委托给 C" as A's result before C finishes).
 */
export const DELEGATION_MAX_DEPTH = 1;
/** B's final reply is truncated to this many characters on A's result card. */
export const DELEGATION_RESULT_MAX_CHARS = 2000;
/** Max characters of the task text one delegate_to_bot call may carry. */
export const DELEGATION_TASK_MAX_CHARS = 4000;
/**
 * system_event name of the follow-up injected into A when a delegation ends
 * (D71). (D66's former `delegate_result` injection is gone since D75: older
 * conversations may still hold such internal system messages.)
 */
export const DELEGATION_FOLLOWUP_EVENT = 'delegation_result';
/** Bounds of a butler `propose_team` proposal (D70). */
export const BUTLER_TEAM_SIZE_MIN = 3;
export const BUTLER_TEAM_SIZE_MAX = 5;
/** system_event name of the butler's route card (D70 suggest_route). */
export const ROUTE_SUGGESTION_EVENT = 'route_suggestion';
/** system_event name of the follow-up injected into the butler after a proposal is decided (D70). */
export const BUTLER_PROPOSAL_FOLLOWUP_EVENT = 'butler_proposal_result';
/**
 * system_event name of the follow-up injected into a bot after the user
 * decided on the propose_profile_change card a supervisor turn submitted
 * without waiting (D75 审查 M4).
 */
export const PROFILE_CHANGE_FOLLOWUP_EVENT = 'profile_change_result';

// --- Connected apps / MCP OAuth (D73, docs/design/29-connected-apps.md) ----------

/** KepCup 的 OAuth 客户端身份：CIMD 文档 URL 即 client_id，**永不更改**（设计 29 §5.2）。 */
export const KEPCUP_OAUTH_CLIENT_ID = 'https://kepcup.com/oauth/client.json';
/**
 * 本机 OAuth 回调的 3 个固定候选端口（RFC 8252 回环重定向，按序尝试；全占用再随机）。
 * 47615–47617 位于 IANA 用户端口段，未被 IANA 分配，也不在常见开发工具的默认端口内。
 */
export const OAUTH_CALLBACK_PORTS = [47615, 47616, 47617] as const;
export const OAUTH_CALLBACK_PATH = '/callback';
/** 一次交互授权流程的总时限。 */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;
/** access token 距过期不足该时长时 `token()` 主动刷新。 */
export const OAUTH_REFRESH_SKEW_MS = 60_000;
/** 发现 / 令牌端点响应体上限（防超大响应）。 */
export const OAUTH_METADATA_MAX_BYTES = 64 * 1024;

// --- MCP (D65, docs/design/23-mcp-and-subagent.md) -------------------------------

/** Single MCP tool call timeout (callTool). */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** MCP connect + tools/list budget for one (re)connect attempt. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
/** Per-server tool cap (防失控工具面；与模型侧 64 字符工具名上限对齐的整数). */
export const MCP_TOOLS_PER_SERVER_MAX = 64;
/**
 * 连接应用工具名（`app_{slug}_{tool}`）长度上限（D73，design 29 §7）：外部智能体经宿主桥看到
 * `mcp__kepcup__{name}`（再留 13 字符），部分厂商工具名上限 64。
 */
export const APP_TOOL_NAME_MAX = 50;
/**
 * 污点外发控制（D73 P2，design 29 §8.3）：(Bot, 对话) 读取过连接应用数据后的污点时长；
 * 每次成功读取续期。
 */
export const APP_TAINT_TTL_MS = 24 * 60 * 60_000;
/** 污点外发卡片的外发内容全文上限（字符；超出截断并注明）。 */
export const EGRESS_TARGET_MAX_CHARS = 20_000;
/** 提示词 `<available_apps>` 最多列出的未连接目录应用数。 */
export const AVAILABLE_APPS_MAX = 30;
/**
 * 应用工具「按需发现」阈值（D73 P2 §6.3，design 29 §7）：Bot 全部目录连接可暴露的应用工具
 * 总数超过它时，不再把这些工具逐个放进工具列表，只注入 `<connected_apps>` 摘要 + 两个稳定
 * 工具 `app_search_tools` / `app_call_tool`（run 内工具列表不变）。
 */
export const APP_TOOLS_INLINE_MAX = 40;
/** `app_search_tools` 一次最多返回的工具数。 */
export const APP_SEARCH_RESULTS_MAX = 20;
/**
 * 权限追加（step-up）计数窗口（D73 P2 §6.1，design 29 §5.4）：（对话, 连接）在该窗口内至多
 * 出一张 step-up 卡，超出时工具结果为普通失败文本。
 */
export const APP_STEP_UP_WINDOW_MS = 30 * 60_000;
/** stdio server crash retry cap before the server is marked failed. */
export const MCP_RECONNECT_MAX = 3;
/** Tools list cache TTL for HTTP servers that announce tool-list-change poorly. */
export const MCP_TOOL_LIST_CACHE_MS = 5 * 60_000;
/**
 * W5：对话轮 / 只读子代理工具面最多放多少个只读 MCP 工具（按 server 顺序取前
 * N 个；其余在任务中可用，系统提示里说明）。每轮请求都带这些 schema。
 */
export const TURN_MCP_READ_TOOLS_MAX = 20;
/**
 * W5：对话轮等待 MCP 工具列表（懒连接 + tools/list）的上限。对话轮是秒级的：
 * 超时则本轮不带 MCP 工具，连接在后台继续，下一轮命中缓存。
 */
export const TURN_MCP_RESOLVE_TIMEOUT_MS = 3_000;

// --- In-loop interim messages (loop 中间过程投送, todo/loop-interim-updates.md) ---

/**
 * Max interim text messages (toolUse assistant turns carrying prose) one
 * response run may deliver into the conversation; beyond the cap the text is
 * only recorded in run_steps, never sent as a message.
 */
export const INTERIM_TEXT_MAX_PER_RUN = 8;
/** Group conversations use a lower interim cap (several bots speak in turn). */
export const INTERIM_TEXT_MAX_PER_RUN_GROUP = 4;
/** Max characters of one interim text message; longer texts are truncated. */
export const INTERIM_TEXT_MAX_CHARS = 2_000;

// --- Loop continuation (Loop 续接, docs/design/02-execution.md "Loop 续接") ------

/**
 * A new batch replays the previous terminal response run's process record
 * without any model call when the run ended at most this long ago. The anchor
 * is the run's endedAt, not the message gap (a long task may have started
 * long before its end).
 */
export const CONTINUATION_WINDOW_MS = 30 * 60_000;
/** Token budget for the whole <continuation> segment (all replayed runs). */
export const CONTINUATION_REPLAY_TOKEN_BUDGET = 3_000;
/** Tool results longer than this render as "（已省略）" in the replay digest. */
export const CONTINUATION_TOOL_RESULT_INLINE_MAX_CHARS = 200;
/** Truncation length for assistant prose and steer/progress texts in the digest. */
export const CONTINUATION_TEXT_MAX_CHARS = 160;

// --- Conversational bot setup (setup interview) ---------------------------------

/** system_event name of a setup-interview question card (options carry the candidates). */
export const SETUP_QUESTION_EVENT = 'bot_setup_question';
/**
 * system_event name of the deterministic work-directory question inserted right
 * after the first interview answer, before any LLM call (docs/design/19,
 * D59): the direct-chat delivery gate holds every user message until this
 * card is answered (directory chosen or skipped).
 */
export const BOT_SETUP_PATH_QUESTION_EVENT = 'bot_setup_path_question';
/** system_event name of a group-creation question card (content carries the step). */
export const GROUP_SETUP_QUESTION_EVENT = 'group_setup_question';
/** Ordered steps of the conversational group creation (docs/design/19, D60). */
export const GROUP_SETUP_STEPS = ['title', 'purpose', 'members', 'project'] as const;
export type GroupSetupStep = (typeof GROUP_SETUP_STEPS)[number];
/**
 * Bot 内部事务事件名集合（docs/design/01-conversation.md 消息原则）：这些事件
 * 只服务 Bot 自己的执行与知识/环境管理，不是对话内容——消息写入侧带
 * `internal` 标记，读取侧按标记或本集合（历史存量行没有标记）一起过滤。
 */
export const INTERNAL_SYSTEM_EVENTS: ReadonlySet<string> = new Set([
  'wiki_ingested',
  'wiki_ingest_failed',
  'environment_pending_download',
  'environment_pending_system',
  'environment_install_denied',
  'environment_install_cancelled',
  'environment_installed',
  'environment_install_failed',
  'skill_imported',
  'skill_import_failed',
  'credential_warning',
  'schedule_fired',
  // W7：监看命中唤醒 Bot 的触发消息（用户看到的是监看卡）。
  'watch_alert',
]);
/** Hard cap of questions one setup interview may ask (soft target: 3~5). */
export const SETUP_MAX_QUESTIONS = 5;
/** Min/max candidate answers a setup question offers; the UI always adds a free-text custom answer on top. */
export const SETUP_QUESTION_OPTIONS_MIN = 2;
export const SETUP_QUESTION_OPTIONS_MAX = 4;
/** Default sandboxed-command timeout (docs/dev/phases/P02-sandbox-and-tools.md). */
export const BASH_TIMEOUT_DEFAULT_MS = 600_000;
/** Successes of the same kind of task before suggesting authoring a skill. */
export const SKILL_AUTHOR_REPEAT_THRESHOLD = 2;
/** Agent Skills spec cap for a skill description; longer ones are truncated (P08). */
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;
/**
 * Presentation cap for a description inside the <skills> prompt section
 * (BR-P08-005): the parse/storage layer caps at SKILL_DESCRIPTION_MAX_CHARS,
 * but CJK costs ~1 token per char, so one 1024-char description alone could
 * eat the whole SKILLS_LIST_TOKEN_BUDGET and crowd later skills out of the
 * progressive-disclosure index. The full text stays readable via SKILL.md.
 */
export const SKILL_PROMPT_DESCRIPTION_MAX_CHARS = 200;
/**
 * scan_json.files cap (BR-P08-010): the task doc scopes `files` to the script
 * list; a hostile repository must not be able to balloon the approval
 * payload / database row, so the list is scripts-only and bounded.
 */
export const SKILL_SCAN_FILES_MAX = 200;
/** Checkpoint retention in days. */
export const CHECKPOINT_RETENTION_DAYS = 30;
/** Default per-project protection rules (docs/dev/phases/P04-project.md). */
export const PROJECT_DEFAULT_PROTECT_RULES = {
  denyRead: ['.env', '.env.*', '*.pem', '*.key', '*.p12', 'id_rsa*'],
  denyWrite: [],
} as const;
/** Per-bot daily background-loop token budget default (docs/dev/phases/P07-memory.md 任务 12). */
export const BACKGROUND_DAILY_BUDGET_DEFAULT = 200_000;
/** Delay before the profile curation job runs, to batch proposals (P07 任务 8). */
export const PROFILE_CURATION_DELAY_MS = 60_000;
/** Commitments due within this horizon appear in <my_state> (P07 任务 10). */
export const MY_STATE_COMMITMENT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
/** Max simultaneously open per-bot memory.db connections (LRU-evicted, P07). */
export const MEMORY_DB_POOL_MAX = 8;
/** Consolidation runs once per local day after this hour (P07 任务 9). */
export const CONSOLIDATION_LOCAL_HOUR = 3;
/** Items per consolidation batch (docs/dev/04-agent-runtime.md "记忆整理"). */
export const MEMORY_CONSOLIDATION_BATCH = 50;
/** Cap for the <project> context top-level listing (two levels). */
export const PROJECT_CONTEXT_MAX_ENTRIES = 200;
/** Max recent projects shown in the selector. */
export const PROJECTS_RECENT_LIMIT = 10;
/** Max proactive messages per bot per day (Profile may override). */
export const MAX_PROACTIVE_PER_DAY = 5;
/**
 * A scheduled fire blocked by the guardrails retries after this long when the
 * block is not tied to a wall-clock boundary (P10: behavior.proactive=false
 * keeps the task alive and re-checks periodically; quiet hours defer to the
 * quiet end and the daily cap to the next local midnight instead).
 */
export const SCHEDULE_GUARD_RETRY_MS = 15 * 60 * 1000;
/** late_by is only reported to the bot above this threshold (P10 任务 4). */
export const SCHEDULE_LATE_BY_MIN_MS = 60_000;
/** system_event name of the visible schedule receipt card (D80). */
export const SCHEDULE_CREATED_EVENT = 'schedule_created';
/** system_event name of the schedule offer card (D80 offer_schedule). */
export const SCHEDULE_OFFER_EVENT = 'schedule_offer';
/**
 * Offer back-off (D80): once the user declined this many offers of one bot in
 * one conversation within the window, offer_schedule refuses until the user
 * asks for a schedule themselves.
 */
export const SCHEDULE_OFFER_DECLINE_MAX = 2;
export const SCHEDULE_OFFER_DECLINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Active schedules listed in the <schedules> context section (D80). */
export const SCHEDULE_CONTEXT_MAX = 8;
/** Routines per proposed bot (D80, butler proposals). */
export const BUTLER_ROUTINES_PER_BOT_MAX = 3;
/**
 * Terminal jobs (done / failed / cancelled) are purged after this long
 * (BR-P10-008): every scheduled fire and every 15-minute guard retry leaves a
 * terminal row, so an unpurged jobs table would grow without bound. Pending
 * and running rows are never touched.
 */
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Wiki lint runs once per bot per week since the last maintenance (P09). */
export const WIKI_LINT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Cap for one wiki ingest source (attachment / file / fetched URL, P09): the
 * material feeds an LLM loop, so multi-hundred-MB inputs are refused outright.
 */
export const WIKI_SOURCE_MAX_BYTES = 10_000_000;
/** Inline cap for source text embedded into the maintenance-loop prompt (P09). */
export const WIKI_SOURCE_INLINE_MAX_CHARS = 20_000;

/** Per-provider model-call concurrency limit (adjustable in settings). */
export const PROVIDER_CONCURRENCY_DEFAULT = 4;
/** Global concurrency limit for background loops. */
export const BACKGROUND_LOOP_CONCURRENCY = 2;

/** Grace period for the core service to shut down before being killed. */
export const CORE_SHUTDOWN_TIMEOUT_MS = 5_000;
/**
 * RPC 单次调用的默认超时（渲染进程 ↔ core 的端口 A、主进程 ↔ core 的端口 B
 * 都用它）。技能导入要 clone 外部仓库、环境安装要下载，birpc 自带的 60 秒
 * 不够；真正的进度/失败由各自的事件与日志透出，这里只兜底防止悬挂。
 */
export const RPC_CALL_TIMEOUT_MS = 30 * 60_000;
/** Backoff schedule for restarting the core service after a crash. */
export const CORE_RESTART_BACKOFF_MS = [1_000, 2_000, 5_000] as const;
/** Restart failures within this window count towards giving up. */
export const CORE_RESTART_FAILURE_WINDOW_MS = 60_000;
/** Consecutive restart failures before giving up. */
export const CORE_RESTART_MAX_FAILURES = 5;

// --- Browser (P11) -------------------------------------------------------------

/** Host viewport of a bot browser page (also the screenshot bounds). */
export const BROWSER_VIEWPORT_WIDTH = 1280;
export const BROWSER_VIEWPORT_HEIGHT = 800;
/**
 * Interactive elements listed per snapshot and page-text characters included
 * (both truncated with a note): a locally measured complex page exposes
 * ~1200 interactive nodes / 15k text characters — far beyond a useful prompt.
 */
export const BROWSER_SNAPSHOT_MAX_ELEMENTS = 150;
export const BROWSER_SNAPSHOT_MAX_TEXT_CHARS = 4000;
/** Base64 cap for one screenshot (a 1280x800 PNG stays far below this). */
export const BROWSER_SCREENSHOT_MAX_BASE64_CHARS = 4_000_000;
/** DNS results are cached per bot session before the interception decision. */
export const BROWSER_DNS_CACHE_TTL_MS = 60_000;
/** Failed lookups are negatively cached shortly (fail-closed in between). */
export const BROWSER_DNS_NEGATIVE_TTL_MS = 10_000;
/** One navigation may take at most this long before the tool reports failure. */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
/** Keys browser_press accepts (mapped to CDP Input.dispatchKeyEvent). */
export const BROWSER_PRESS_KEYS = [
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;
export type BrowserPressKey = (typeof BROWSER_PRESS_KEYS)[number];
/**
 * W1 重复动作熔断：同一动作签名连续这么多次执行后页面快照都没变，下一次同签名
 * 动作直接拒绝（BROWSER_NO_PROGRESS），提示换做法或 ask_user。
 */
export const BROWSER_NO_PROGRESS_LIMIT = 3;
/**
 * W8 自动接管：用户在查看窗口里点击 / 键入后页面归用户操作；用户这么久没有
 * 任何输入即自动交还给 Bot（与「交还给 Bot」按钮、关闭查看窗口同样通知任务）。
 */
export const BROWSER_USER_CONTROL_IDLE_MS = 600_000;
/** W8: a task gets at most one handback notice per this window (repeated takeovers). */
export const BROWSER_HANDBACK_COALESCE_MS = 30_000;
/** W8 共享浏览器资料：名称长度上限。 */
export const BROWSER_PROFILE_NAME_MAX_CHARS = 40;

// --- 确定性监看（W7，D79） ----------------------------------------------------

/** 监看检查间隔下限（秒）：后台抓页可能触发反爬，最短 5 分钟。 */
export const WATCH_MIN_INTERVAL_SEC = 300;
/** 监看检查间隔上限（秒）：7 天。 */
export const WATCH_MAX_INTERVAL_SEC = 7 * 24 * 60 * 60;
/** 每个 Bot 未停止（active + paused）的监看上限。 */
export const WATCH_MAX_PER_BOT = 20;
/** 全局未停止（active + paused）的监看上限。 */
export const WATCH_MAX_GLOBAL = 100;
/** 连续失败这么多次后监看自动暂停，并在对话里发一张可「恢复」的卡片。 */
export const WATCH_PAUSE_AFTER_FAILURES = 5;
/**
 * 失败退避上限（分钟）：next_check_at = now + max(间隔下限 5 分钟, min(60, 2^failures) 分钟)，
 * 即 5 / 5 / 8 / 16 / 32 / 60 分钟（复查后：重试不早于 WATCH_MIN_INTERVAL_SEC）。
 */
export const WATCH_BACKOFF_MAX_MINUTES = 60;
/**
 * 浏览器宿主未连接（启动时端口 B 尚未绑定、宿主断开）时的重试间隔（毫秒）：不计失败、
 * 不写 last_error，端口重新绑定后立即重查。
 */
export const WATCH_HOST_UNAVAILABLE_RETRY_MS = 60_000;
/**
 * 每个监看滚动 24 小时内最多提醒几次；再次触发时不唤醒，改为暂停监看并发卡片
 * （「提醒过于频繁」，用户放宽条件或延长间隔后恢复）。
 */
export const WATCH_MAX_ALERTS_PER_DAY = 24;
/**
 * 后台页一次取正文的总时限（毫秒，宿主侧）：导航 30 秒 + 渲染等待 + 读取文本都算在内，
 * 超时即关页（保证 finally 一定关掉后台页），按失败计。远小于端口 B 的 RPC 超时（RPC_CALL_TIMEOUT_MS）。
 */
export const WATCH_FETCH_DEADLINE_MS = 45_000;
/** 唤醒消息里页面增删改摘要的长度上限（字符）。 */
export const WATCH_DIFF_SUMMARY_MAX_CHARS = 1500;
/** 后台页返回的页面文本上限（字符，超出截断）。 */
export const WATCH_FETCH_TEXT_MAX_CHARS = 200_000;
/** 为下次做行 diff 而保存的上一版页面文本上限（字符，main.db watches.last_text）。 */
export const WATCH_STORED_TEXT_MAX_CHARS = 50_000;
/** contains / not_contains 条件文本与选择器的长度上限。 */
export const WATCH_CONDITION_TEXT_MAX_CHARS = 200;
export const WATCH_SELECTOR_MAX_CHARS = 300;

// --- Auto-update gate (P13 任务 2) ----------------------------------------------

/**
 * How often the update gate re-queries in-flight executions while waiting for
 * them to drain (docs/dev/phases/P13-release.md: 更新不得中断进行中的执行).
 */
export const UPDATE_ACTIVE_RUNS_POLL_MS = 5_000;
/**
 * Max time the gate waits for in-flight executions to drain after a download.
 * Not a deadline to interrupt: on expiry the gate parks in `awaiting-user` and
 * only an explicit user confirmation may cancel runs and install.
 */
export const UPDATE_WAIT_RUNS_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * After the user confirms an interrupt: how long cancelActive has to make all
 * runs terminal before the gate reports failure instead of installing.
 */
export const UPDATE_CANCEL_SETTLE_TIMEOUT_MS = 15_000;
/** First update check after launch (let the core reach ready state first). */
export const UPDATE_CHECK_INITIAL_DELAY_MS = 30_000;
/** Periodic re-check interval. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Bounded waits around update.cancelActive: per attempt grace + attempts
 * (runs unwind asynchronously; each failed attempt backs off).
 */
export const UPDATE_CANCEL_SETTLE_POLL_MS = 500;

// --- Migration backup (P13 任务 5) ----------------------------------------------

/** Backup copies of main.db kept before data migrations (P13 任务 5). */
export const MAIN_DB_BACKUPS_TO_KEEP = 3;

// --- External agents (D72, docs/design/28-external-agents-acp.md) --------------

/**
 * Upper bound of one external-agent prompt turn (session/prompt). On expiry the
 * engine sends session/cancel and settles the run failed (TIMEOUT).
 */
export const AGENT_RUN_TIMEOUT_MS = 60 * 60_000;
/**
 * An agent process with no active session exits after this long. Kept ≥
 * CONTINUATION_WINDOW_MS so a session reused within the continuation window
 * (P5) still finds its process alive.
 */
export const AGENT_IDLE_SHUTDOWN_MS = 35 * 60_000;
/** Spawn + ACP `initialize` must complete within this long. */
export const AGENT_INIT_TIMEOUT_MS = 60_000;
/**
 * Upper bound of one session-setup call before the prompt (`session/set_mode`,
 * `session/set_config_option`): an agent that does not answer is not trusted
 * with the session (P5-2 复审 #10).
 */
export const AGENT_SESSION_CALL_TIMEOUT_MS = 30_000;
/**
 * Upper bound of opening a session (`session/new` / `session/resume` /
 * `session/load`; agents connect their MCP servers and may replay history
 * meanwhile): no answer → the run fails TIMEOUT and the lease is released
 * (P5-2 第三轮审查 #10).
 */
export const AGENT_SESSION_OPEN_TIMEOUT_MS = 120_000;
/**
 * Minimum time a follow-up prompt gets when the run's own deadline
 * (AGENT_RUN_TIMEOUT_MS from the run start) is close or already past — e.g.
 * the single follow-up reporting timed-out background tools (P5-2 复审 #4).
 */
export const AGENT_FOLLOW_UP_MIN_MS = 5 * 60_000;
/** After session/cancel, how long to wait for the cancelled prompt response. */
export const AGENT_CANCEL_GRACE_MS = 10_000;
/**
 * Scheduler concurrency for `agent:{id}` when providerConcurrency has no override (P5);
 * only for agents whose provider declares `features.parallelSessions` (others: 1).
 */
export const AGENT_DEFAULT_CONCURRENCY = 2;
/**
 * Chain-budget equivalent of one external-agent model round whose tokens the
 * agent did not report (subscription agents often report none, P5): the bot
 * chain budget (BOT_CHAIN_TOKEN_BUDGET) then allows about 20 such rounds.
 */
export const AGENT_TURN_BUDGET_TOKENS = 10_000;
/**
 * A host-bridge tool call still running after this long is answered with a
 * "moved to the background" result and keeps running; its result reaches the
 * agent as a follow-up (P5). Below Codex's ~60 s MCP tool timeout, which ACP
 * cannot raise — tools waiting for the user's approval or generating a video
 * would otherwise be cut off (and their approval card cancelled).
 */
export const AGENT_BRIDGE_TOOL_DETACH_MS = 45_000;
/** After SIGTERM to an agent's process group, SIGKILL follows after this long. */
export const AGENT_KILL_GRACE_MS = 5_000;
/** Cap of a partial (newline-less) agent stderr line kept between chunks. */
export const AGENT_STDERR_TAIL_MAX_CHARS = 4_096;
/**
 * Upper bound of one background `complete()` on an external agent (P6: one-shot
 * minimal session — cold start of the agent process included). The callers'
 * own deadlines (triage, compaction …) still apply on top.
 */
export const AGENT_COMPLETE_TIMEOUT_MS = 3 * 60_000;
/** Model-turn cap of a one-shot `complete()` session (no tools: one turn suffices). */
export const AGENT_COMPLETE_MAX_TURNS = 3;
/**
 * Background loops running on an external agent only (no built-in model, P6):
 * reflection and conversation summary run once every this many triggers
 * (per bot / per conversation) — subscription quota is shared with the user.
 */
export const AGENT_BACKGROUND_EVERY_N_RUNS = 5;
/**
 * Upper bound of one background agent run (Wiki maintenance / skill authoring
 * on an external agent, 审查 C1): far below AGENT_RUN_TIMEOUT_MS — the run
 * holds one of the agent's scheduler slots.
 */
export const AGENT_BACKGROUND_RUN_TIMEOUT_MS = 10 * 60_000;
/**
 * Group-chat triage on an external agent (审查 C2): a one-shot session incl.
 * a possible cold start of the agent process needs longer than
 * TRIAGE_TIMEOUT_MS; still answered as `no_action` on expiry.
 */
export const AGENT_TRIAGE_TIMEOUT_MS = 60_000;
/**
 * Group-chat triage on an external agent runs at most once per this interval
 * per (bot, group) (审查 C2); in between the bot answers @ / replies only.
 */
export const AGENT_TRIAGE_MIN_INTERVAL_MS = 2 * 60_000;

// --- Supervisor turns & tasks (D75, docs/design/30-supervisor-and-tasks.md) -----

/**
 * Max model turns of one supervisor turn (`loop_type='turn'`, §2.1): a turn
 * talks and dispatches, it should never run a long tool chain; over the cap it
 * settles as failed.
 */
export const TURN_MAX_TURNS = 8;
/** Max simultaneously running tasks per conversation (§2.2); more wait as `queued` (submitted). */
export const TASK_CONCURRENCY_PER_CONVERSATION = 3;
/** Max simultaneously running tasks across all conversations (§2.2). */
export const TASK_CONCURRENCY_GLOBAL = 8;
/** Max tasks one supervisor turn may start (§4.1, counted by `origin_run_id`). */
export const TASK_START_MAX_PER_TURN = 2;
/** Wall-clock cap of one task (§3.2 reaper): a running task over it is forced to `failed`. */
export const TASK_MAX_WALL_MS = 4 * 60 * 60_000;
/**
 * Token budget (input+output, cumulative over all model calls) of one task
 * (§2.2). A task takes over today's long response run, which has no token cap
 * and is bounded only by RUN_MAX_TURNS (60); SUBAGENT_TOKEN_BUDGET (150k for
 * 20 turns) is far too small for that. 60 turns × ~30k context tokens per
 * call ≈ 1.8M, so the cap sits just above what a full-length run can consume.
 */
export const TASK_TOKEN_BUDGET = 2_000_000;
/**
 * Settlement reconciliation period (§3.2): the reaper re-delivers terminal,
 * unconsumed task results and enforces TASK_MAX_WALL_MS.
 */
export const TASK_SETTLE_SWEEP_MS = 60_000;
/**
 * Truncation of task progress / older task_event rows in the recent-message
 * window (§2.4.4); the full text stays reachable via get_messages_around.
 */
export const TASK_EVENT_CONTEXT_MAX_CHARS = 600;
/**
 * Hard cap of a task result rendered in full into the trigger segment of the
 * waking turn (§2.4.4, §12 item 6); beyond it the turn gets the head plus a
 * hint to use forward_task_result.
 */
export const TASK_TRIGGER_RESULT_MAX_CHARS = 12_000;
/**
 * Absolute lifetime of a one-time ("仅这一次") grant (D37 tightened, §7.3):
 * a backstop on top of "expires after the single tool call".
 */
export const GRANT_ABSOLUTE_TTL_MS = 10 * 60_000;
/**
 * Token budget of the process digest (`buildRunDigest`, tail kept) appended to
 * a task's failure entry (D75 §2.4.1): the last steps before it failed /
 * was cancelled / was interrupted.
 */
export const TASK_FAILURE_DIGEST_TOKEN_BUDGET = 600;
/** list_tasks (§4.1): settled tasks ended within this window are listed with the live ones. */
export const TASK_LIST_SETTLED_WINDOW_MS = 24 * 60 * 60_000;
/** start_task title cap (§4.1; the card / <tasks> line shows it). */
export const TASK_TITLE_MAX_CHARS = 80;
/** start_task / inject_task instruction cap (§4.1). */
export const TASK_INSTRUCTION_MAX_CHARS = 8_000;
/** Max source_message_ids per start_task / inject_task (§2.4.5 verbatim originals). */
export const TASK_SOURCE_MESSAGES_MAX = 20;
/**
 * A delivered task result whose consuming turn never reached a terminal state
 * (the delivery got lost in-process) is re-delivered by the reaper after this
 * long (§3.2 at-least-once).
 */
export const TASK_REDELIVER_AFTER_MS = 10 * 60_000;
/**
 * A delivered task result is handed to the bot at most this many times
 * (D75 审查 M4): turns that keep failing before they handle it (e.g. a throw
 * while building the context) would otherwise be woken every
 * TASK_REDELIVER_AFTER_MS forever. Past the cap the result is consumed with a
 * visible notice in the conversation.
 */
export const TASK_REDELIVER_MAX_ATTEMPTS = 5;
/**
 * How long a task waits on its open `ask_user` question (design 30 §2.4.6,
 * D75 审查 M3). The wait gives its provider slot back and does not count
 * toward TASK_MAX_WALL_MS; after this long the task is told 「用户未回答」 and
 * continues on its own judgement.
 */
export const TASK_QUESTION_TTL_MS = 24 * 60 * 60_000;
/** Max characters of one ask_user candidate answer (the card renders each as a button). */
export const ASK_USER_OPTION_MAX_CHARS = 200;
/**
 * Cancel card of a workspace write task (D75 W3, design 30 §5.2): at most this
 * many changed files are listed (the workspace has no checkpoint, so the card
 * lists what the task's file tools wrote instead of offering a revert).
 */
export const TASK_CHANGED_FILES_SHOWN = 20;
