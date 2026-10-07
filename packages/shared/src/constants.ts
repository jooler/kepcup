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
 * Max simultaneously *running* background subagent runs per conversation (D66
 * mode B 的对话级并发封顶). Foreground fan-out lanes must also fit under this
 * shared cap: N + already-running background sub runs ≤ this constant.
 */
export const SUBAGENT_BACKGROUND_CONCURRENCY = 4;
/** system_event name of the deterministic background-delegation follow-up injection (D66 mode B). */
export const SUBAGENT_FOLLOWUP_EVENT = 'delegate_result';

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
 * (D71). Distinct from D66's `delegate_result` (SUBAGENT_FOLLOWUP_EVENT).
 */
export const DELEGATION_FOLLOWUP_EVENT = 'delegation_result';
/** Bounds of a butler `propose_team` proposal (D70). */
export const BUTLER_TEAM_SIZE_MIN = 3;
export const BUTLER_TEAM_SIZE_MAX = 5;
/** system_event name of the butler's route card (D70 suggest_route). */
export const ROUTE_SUGGESTION_EVENT = 'route_suggestion';
/** system_event name of the follow-up injected into the butler after a proposal is decided (D70). */
export const BUTLER_PROPOSAL_FOLLOWUP_EVENT = 'butler_proposal_result';

// --- MCP (D65, docs/design/23-mcp-and-subagent.md) -------------------------------

/** Single MCP tool call timeout (callTool). */
export const MCP_CALL_TIMEOUT_MS = 60_000;
/** MCP connect + tools/list budget for one (re)connect attempt. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;
/** Per-server tool cap (防失控工具面；与模型侧 64 字符工具名上限对齐的整数). */
export const MCP_TOOLS_PER_SERVER_MAX = 64;
/** stdio server crash retry cap before the server is marked failed. */
export const MCP_RECONNECT_MAX = 3;
/** Tools list cache TTL for HTTP servers that announce tool-list-change poorly. */
export const MCP_TOOL_LIST_CACHE_MS = 5 * 60_000;

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
/**
 * Beyond CONTINUATION_WINDOW_MS, candidates within this age may still be
 * selected by the light-model arbiter; older runs fall back to the plain
 * conversation context + list_my_runs.
 */
export const CONTINUATION_ARBITER_MAX_AGE_MS = 24 * 60 * 60_000;
/** Max candidate runs offered to the arbiter (newest first). */
export const CONTINUATION_ARBITER_MAX_RUNS = 5;
/** Arbiter call timeout; timeout/error/parse failure all mean "no continuation". */
export const CONTINUATION_ARBITER_TIMEOUT_MS = 10_000;
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
/** After session/cancel, how long to wait for the cancelled prompt response. */
export const AGENT_CANCEL_GRACE_MS = 10_000;
/** Scheduler concurrency for `agent:{id}` when providerConcurrency has no override (P5). */
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
