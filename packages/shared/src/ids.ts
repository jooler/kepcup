import { ulid } from 'ulid';

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
  prj: 'prj_',
  grt: 'grt_',
  apr: 'apr_',
  sch: 'sch_',
  skl: 'skl_',
  sec: 'sec_',
  chn: 'chn_',
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
  /** 共享浏览器资料（W8，settings.browserProfiles）。 */
  bpf: 'bpf_',
  /** 确定性监看（W7，main.db watches）。 */
  wat: 'wat_',
  /** 辅助阅读便签（main.db stickies）。 */
  stc: 'stc_',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}${ulid()}`;
}

export function isId(kind: IdKind, id: string): boolean {
  return id.startsWith(ID_PREFIXES[kind]);
}
