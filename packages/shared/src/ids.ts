import { monotonicFactory } from 'ulid';

// Monotonic: ids minted within one millisecond still sort in creation order, so
// `order by … id desc` tie-breaks (latest run, newest row) are deterministic.
const ulid = monotonicFactory();

/** ID prefixes per docs/dev/01-conventions.md ("ID conventions"). */
export const ID_PREFIXES = {
  bot: 'bot_',
  conv: 'conv_',
  msg: 'msg_',
  att: 'att_',
  drf: 'drf_',
  run: 'run_',
  stp: 'stp_',
  mem: 'mem_',
  prf: 'prf_',
  wkd: 'wkd_',
  grt: 'grt_',
  apr: 'apr_',
  sch: 'sch_',
  skl: 'skl_',
  sec: 'sec_',
  /** 协作回合（D92 T1a，main.db episodes）。 */
  epi: 'epi_',
  env: 'env_',
  job: 'job_',
  use: 'use_',
  aud: 'aud_',
  alw: 'alw_',
  prp: 'prp_',
  /** 跨 Bot 委派（D71）。 */
  dlg: 'dlg_',
  /** 外部智能体会话（D72 P5，agent_sessions）。 */
  ags: 'ags_',
  /** 外部副作用台账（W2，runs.db tool_effects）。 */
  eff: 'eff_',
  /** 应用连接（D73，main.db app_connections；自定义 server 的连接 id 为 custom:{serverId}）。 */
  conn: 'conn_',
  /** 应用工具的持续授权（D73，main.db app_tool_grants）。 */
  atg: 'atg_',
  /** git 远程操作的持续授权（main.db git_remote_grants）。 */
  grg: 'grg_',
  /** 共享浏览器资料（W8，settings.browserProfiles）。 */
  bpf: 'bpf_',
  /** 确定性监看（W7，main.db watches）。 */
  wat: 'wat_',
  /** 辅助阅读便签（main.db stickies）。 */
  stc: 'stc_',
  /** Bot 自制交互组件（D81，main.db widgets）。 */
  wgt: 'wgt_',
  /** 组件制作（D87，草稿目录名 / craftId）。 */
  wcf: 'wcf_',
  /** 邮件账号（D84，main.db mail_accounts）。 */
  mal: 'mal_',
  /** Bot 资产移交（D88，main.db bot_handovers）。 */
  hnd: 'hnd_',
  /** 工作台事项（D90，main.db todos）。 */
  todo: 'todo_',
  /** 工作台事项的一次派发（D90，main.db todo_runs）。 */
  tdr: 'tdr_',
  /** 工作台备忘（D90，main.db memos）；与记忆条目 `mem_` 无关。 */
  memo: 'memo_',
  /** 看板分栏（D103，main.db board_columns）。卡片 id 复用事项 id，没有单独前缀。 */
  bcol: 'bcol_',
  /** 插件实例（D105，main.db plugin_instances）。 */
  pli: 'pli_',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}${ulid()}`;
}

/**
 * 裸 ULID（无前缀）：远程遥控的会话 id（D96）——中转按它路由 / 隔离，
 * 不可猜性由 ULID 的 80bit 随机段保证（另 48bit 是时间戳；`RELAY_SESSION_ID_PATTERN`）。
 */
export function newUlid(): string {
  return ulid();
}

export function isId(kind: IdKind, id: string): boolean {
  return id.startsWith(ID_PREFIXES[kind]);
}
