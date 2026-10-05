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
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}${ulid()}`;
}

export function isId(kind: IdKind, id: string): boolean {
  return id.startsWith(ID_PREFIXES[kind]);
}
