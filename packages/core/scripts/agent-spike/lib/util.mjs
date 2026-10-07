import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Number(process.hrtime.bigint() / 1000000n);

export function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`timeout after ${ms}ms: ${label}`), { code: 'SPIKE_TIMEOUT' })), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

export function errInfo(e) {
  if (!e) return { message: String(e) };
  const info = { message: e.message ?? String(e) };
  if (e.code !== undefined) info.code = e.code;
  if (e.data !== undefined) info.data = e.data;
  if (e.name && e.name !== 'Error') info.name = e.name;
  return info;
}

/** 杀掉进程树：POSIX 用进程组（spawn 时 detached），Windows 用 taskkill /T。 */
export function killTree(child, signal = 'SIGKILL') {
  if (!child || child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch { /* 已退出 */ }
  }
}

/** 进程树 RSS（KB）。仅 POSIX；失败返回 null。 */
export async function sampleTreeRssKb(rootPid) {
  if (process.platform === 'win32' || !rootPid) return null;
  return new Promise((resolve) => {
    const p = spawn('ps', ['-A', '-o', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 3);
      const kids = new Map();
      for (const [pid, ppid, rss] of rows) kids.set(pid, { ppid, rss });
      const tree = new Set([rootPid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const [pid, { ppid }] of kids) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; }
      }
      let sum = 0;
      for (const pid of tree) sum += kids.get(pid)?.rss ?? 0;
      resolve(sum || null);
    });
  });
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
