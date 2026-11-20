/**
 * 桌面远程模式（design 49 §7「桌面远程模式壳」）：`KEPCUP_REMOTE_URL` 指向一个
 * headless 服务端时，Electron 壳不启动本地 core，主窗口直接加载服务端托管的 web
 * 构建——与浏览器打开同一地址走同一条代码路径（`window.kepcup.isWeb` 由 web 垫片
 * 打标，渲染层因此走 WebSocket 传输）。
 *
 * 这里只做解析与校验：主进程的接线（跳过 core / 窗口不挂 preload）在 index.ts，
 * 窗口加载与导航策略在 window.ts。T5（62.08 §3）：`KEPCUP_REMOTE_PROFILE`（服务器
 * 地址的稳定哈希，team-window.ts 的启动器写入）把多个团队服务器壳的 userData /
 * 单实例锁细分到各自 profile，与本机实例互不冲突。
 */

import { createHash } from 'node:crypto';

export interface RemoteModeTarget {
  /** 主窗口加载的 URL（去掉 query 与 hash，保留路径）。 */
  url: string;
  /** 权限白名单与导航判定使用的 origin。 */
  origin: string;
  /**
   * T5 步骤 5：远程 profile id（index.ts 据此把 userData 分区到
   * `<userData>/remote/<profile>`）。null = 启动器没给 profile（手工启动的远程
   * 壳），沿用既有 `remote` 分区，默认行为不变。
   */
  profile: string | null;
}

/**
 * 服务器地址 → 稳定的 profile id（T5）：sha256 前 8 字节 hex（16 个字符）。纯函数，
 * 同一 URL 恒同一 id——启动器（team-window.ts）用它写 `KEPCUP_REMOTE_PROFILE`，
 * 子进程经 `resolveRemoteMode` 读回供 userData 分区。
 */
export function remoteProfileHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16);
}

/** profile id 的合法形状：恰为 `remoteProfileHash` 的输出（16 位小写 hex）。 */
const REMOTE_PROFILE_PATTERN = /^[0-9a-f]{16}$/;

/**
 * 读取 `KEPCUP_REMOTE_URL`。未设置（或空串）= 本地模式，返回 null；设置但非法直接
 * 抛错——悄悄回落到本地模式会让用户以为连上了远端，实际写的是另一份数据。
 */
export function resolveRemoteMode(env: NodeJS.ProcessEnv): RemoteModeTarget | null {
  const raw = env['KEPCUP_REMOTE_URL']?.trim() ?? '';
  if (raw === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`KEPCUP_REMOTE_URL 不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`KEPCUP_REMOTE_URL 只支持 http / https：${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('KEPCUP_REMOTE_URL 不能内嵌用户名 / 密码');
  }

  // T5：profile 只作 userData 路径段，必须是哈希形状——显式拒绝其它值，防止
  // 手拼的环境变量把分区写到 `<userData>/remote` 之外（路径穿越）。
  const profile = env['KEPCUP_REMOTE_PROFILE']?.trim() ?? '';
  if (profile !== '' && !REMOTE_PROFILE_PATTERN.test(profile)) {
    throw new Error('KEPCUP_REMOTE_PROFILE 必须是 remoteProfileHash 的输出（16 位 hex）');
  }

  const clean = new URL(parsed.origin + parsed.pathname);
  return { url: clean.toString(), origin: clean.origin, profile: profile === '' ? null : profile };
}

/** 该 URL 是否 http(s)（远程模式下外链交给系统浏览器）。 */
export function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
