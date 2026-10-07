// 一次 spike 运行的共享上下文：启动参数解析、Agent 进程生命周期、session / prompt 助手。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from '../agents.mjs';
import { installBinary } from './install.mjs';
import { SpikeClient, Trace, acp, connectAgent, spawnAgent } from './client.mjs';
import { redact, registerSecret } from './redact.mjs';
import { errInfo, killTree, now, sampleTreeRssKb, sleep, withTimeout } from './util.mjs';

const PASS_ENV = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
];

export const DEFAULT_TIMEOUT_S = {
  initialize: 300, auth: 120, session: 90, prompt: 240, steer: 240, cancel: 120,
  permission: 240, mcp: 240, modes: 90, complete: 150, native: 240, resume: 240,
};

export function parseEnvPairs(list = []) {
  const out = {};
  for (const kv of list) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new Error(`--env expects KEY=VALUE, got "${kv}"`);
    out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
}

export class Context {
  constructor({ agentId, opts }) {
    this.agentId = agentId;
    this.agent = AGENTS[agentId];
    if (!this.agent) throw new Error(`unknown agent "${agentId}" (known: ${Object.keys(AGENTS).join(', ')})`);
    this.opts = opts;
    this.trace = new Trace();
    this.workRoot = path.resolve(opts.workDir ?? path.join(os.tmpdir(), 'kepcup-spike', agentId));
    this.home = path.resolve(opts.home ?? path.join(this.workRoot, 'home'));
    this.cwd = path.resolve(opts.cwd ?? path.join(this.workRoot, 'cwd'));
    this.outsideDir = path.join(this.workRoot, 'outside');
    this.installDir = path.resolve(opts.installDir ?? path.join(this.workRoot, 'bin'));
    this.explicitEnv = parseEnvPairs(opts.env);
    for (const v of Object.values(this.explicitEnv)) registerSecret(v);
    this.proc = null; // { child, stderrLines, exited, spawnedAt }
    this.conn = null;
    this.client = new SpikeClient();
    this.initResult = null;
    this.launchInfo = null;
    this.steps = {}; // step 结果，供 implicit initialize 写入
    this.restarts = 0;
    this.unhandledAll = [];
  }

  log(...a) { if (!this.opts.quiet) console.error(`[spike:${this.agentId}]`, ...a); }

  timeoutMs(step) {
    return (this.opts.timeout ?? DEFAULT_TIMEOUT_S[step] ?? 120) * 1000;
  }

  buildEnv() {
    const env = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    for (const k of this.opts.passEnv ?? []) {
      if (process.env[k] === undefined) throw new Error(`--pass-env ${k}: not set in host environment`);
      env[k] = process.env[k];
      registerSecret(process.env[k]);
    }
    env.HOME = this.home;
    env.USERPROFILE = this.home;
    env.XDG_CONFIG_HOME = path.join(this.home, '.config');
    env.XDG_DATA_HOME = path.join(this.home, '.local', 'share');
    env.XDG_CACHE_HOME = path.join(this.home, '.cache');
    env.XDG_STATE_HOME = path.join(this.home, '.local', 'state');
    if (process.platform === 'win32') {
      env.APPDATA = path.join(this.home, 'AppData', 'Roaming');
      env.LOCALAPPDATA = path.join(this.home, 'AppData', 'Local');
    }
    env.npm_config_update_notifier = 'false';
    env.npm_config_fund = 'false';
    env.npm_config_audit = 'false';
    env.NO_COLOR = '1';
    return { ...env, ...this.explicitEnv };
  }

  /** 解析启动命令（必要时下载 binary），建工作目录。幂等。 */
  async prepare() {
    if (this.launchInfo) return this.launchInfo;
    for (const d of [this.home, this.cwd, this.outsideDir, this.installDir]) fs.mkdirSync(d, { recursive: true });
    const seed = path.join(this.cwd, 'README.txt');
    if (!fs.existsSync(seed)) fs.writeFileSync(seed, 'KepCup spike workspace. Safe to read.\n');
    const dist = this.agent.distribution;
    let command; let args; let install = null;
    if (this.opts.command) {
      command = this.opts.command;
      args = this.opts.args ?? [];
    } else if (dist.npx) {
      command = 'npx';
      args = ['-y', dist.npx.package, ...this.agent.args];
    } else if (dist.binary) {
      const r = await installBinary({
        registryId: dist.binary.registryId,
        installDir: this.installDir,
        allowLarge: this.opts.allowLarge,
        large: dist.binary.large,
        registryFile: this.opts.registryFile,
        log: (m) => this.log(m),
      });
      command = r.command; args = r.args; install = r.install;
    } else if (dist.fake) {
      command = this.agent.command; args = this.agent.args;
    } else {
      throw new Error(`agent ${this.agentId} has no launchable distribution (use --command)`);
    }
    const env = this.buildEnv();
    const npxCacheDir = path.join(this.home, '.npm', '_npx');
    this.launchInfo = {
      command, args, env, install,
      npxCacheWasCold: dist.npx && !this.opts.command ? !fs.existsSync(npxCacheDir) : undefined,
    };
    return this.launchInfo;
  }

  describeLaunch() {
    const l = this.launchInfo;
    return {
      command: l.command,
      args: l.args,
      envKeys: Object.keys(l.env).sort(),
      home: this.home,
      cwd: this.cwd,
      outsideDir: this.outsideDir,
      install: l.install,
      npxCacheWasCold: l.npxCacheWasCold,
      clientInfo: this.clientInfo,
    };
  }

  get clientInfo() { return { name: 'KepCup-spike', version: '0' }; }

  get alive() { return Boolean(this.proc && this.proc.child.exitCode === null && this.proc.child.signalCode === null); }

  /** 启动进程并 initialize。返回 { response, coldStartMs, ... }。 */
  async connect() {
    const launch = await this.prepare();
    this.client = new SpikeClient();
    this.client.unhandled = this.unhandledAll;
    this.proc = spawnAgent({ command: launch.command, args: launch.args, env: launch.env, cwd: this.cwd });
    this.conn = connectAgent(this.proc.child, this.trace, this.client);
    const t0 = this.proc.spawnedAt;
    const request = {
      protocolVersion: acp.PROTOCOL_VERSION,
      // 不声明 fs / terminal；声明 terminal 认证
      clientCapabilities: { auth: { terminal: true }, _meta: { 'terminal-auth': true } },
      clientInfo: this.clientInfo,
    };
    let response;
    try {
      response = await withTimeout(Promise.race([
        this.conn.initialize(request),
        this.proc.exited.then((x) => { throw Object.assign(new Error(`agent exited before initialize: ${JSON.stringify(x)}`), { code: 'SPIKE_EXIT' }); }),
      ]), this.timeoutMs('initialize'), 'initialize');
    } catch (e) {
      e.spawnToFailureMs = now() - t0;
      throw e;
    }
    const coldStartMs = now() - t0;
    this.initResult = response;
    const rssKb = await sampleTreeRssKb(this.proc.child.pid);
    return { request, response, coldStartMs, rssKbAfterInit: rssKb };
  }

  async ensureConnected() {
    if (this.alive && this.initResult) return;
    if (this.proc) { this.restarts += 1; await this.shutdown(); }
    const r = await this.connect();
    if (!this.steps.initialize) {
      this.steps.initialize = { status: 'ok', implicit: true, data: { coldStartMs: r.coldStartMs, response: redact(r.response) } };
    }
  }

  async shutdown() {
    if (this.proc) {
      try { this.proc.child.stdin.end(); } catch { /* ignore */ }
      killTree(this.proc.child);
      await Promise.race([this.proc.exited, sleep(2000)]);
    }
    this.proc = null; this.conn = null; this.initResult = null;
  }

  stderrTail(n = 40) { return this.proc ? redact(this.proc.stderrLines.slice(-n)) : []; }

  agentCaps() { return this.initResult?.agentCapabilities ?? {}; }

  /** session/new；失败抛出（调用方记录）。 */
  async newSession({ mcpServers = [], meta, cwd, mode } = {}) {
    await this.ensureConnected();
    const metaMerged = { ...(this.opts.isolate ? (this.agent.isolateMeta ?? {}) : {}), ...(this.opts.sessionMeta ?? {}), ...(meta ?? {}) };
    const req = { cwd: cwd ?? this.cwd, mcpServers };
    if (Object.keys(metaMerged).length) req._meta = metaMerged;
    const t0 = now();
    const result = await withTimeout(this.conn.newSession(req), this.timeoutMs('session'), 'session/new');
    const ms = now() - t0;
    if (mode) await this.conn.setSessionMode({ sessionId: result.sessionId, modeId: mode });
    return { sessionId: result.sessionId, result, ms, request: req };
  }

  /**
   * 发 prompt 并等待结束；收集期间的 session/update 与权限事件。
   * @returns {{ response?, error?, ms, updates, permissions, firstUpdateMs?, firstChunkMs? }}
   */
  async prompt(sessionId, text, { timeoutMs, policy, onUpdate, step = 'prompt', blocks } = {}) {
    const run = this.startPrompt(sessionId, text, { policy, blocks });
    return run.finish(timeoutMs ?? this.timeoutMs(step), onUpdate);
  }

  startPrompt(sessionId, text, { policy, blocks } = {}) {
    const client = this.client;
    if (policy) client.permissionPolicy = policy;
    const u0 = client.updates.length;
    const p0 = client.permissionEvents.length;
    const t0 = now();
    const promise = this.conn.prompt({ sessionId, prompt: blocks ?? [{ type: 'text', text }] })
      .then((response) => ({ response }), (error) => ({ error: errInfo(error) }));
    const conn = this.conn;
    return {
      sessionId, t0, promise,
      updatesNow: () => client.updates.slice(u0).filter((u) => u.sessionId === sessionId),
      async waitFirst(predicate, ms) {
        const end = now() + ms;
        while (now() < end) {
          const hit = this.updatesNow().find(predicate);
          if (hit) return { hit, atMs: hit.t - t0 };
          const settled = await Promise.race([promise.then(() => true), sleep(100).then(() => false)]);
          if (settled) return null;
        }
        return null;
      },
      async finish(ms, onUpdate) {
        let timedOut = false;
        let outcome;
        try {
          outcome = await withTimeout(promise, ms, 'session/prompt');
        } catch (e) {
          timedOut = true;
          outcome = { error: errInfo(e) };
          try { await conn.cancel({ sessionId }); } catch { /* ignore */ }
          await Promise.race([promise, sleep(5000)]);
        }
        const updates = this.updatesNow();
        onUpdate?.(updates);
        const ms2 = now() - t0;
        const first = updates[0];
        const firstChunk = updates.find((u) => u.update.sessionUpdate === 'agent_message_chunk');
        return {
          ...outcome, timedOut, ms: ms2, updates,
          permissions: client.permissionEvents.slice(p0).filter((p) => p.sessionId === sessionId),
          firstUpdateMs: first ? first.t - t0 : null,
          firstChunkMs: firstChunk ? firstChunk.t - t0 : null,
        };
      },
    };
  }
}

/** session/update 序列摘要。 */
export function summarizeUpdates(updates) {
  const counts = {};
  const tools = new Map();
  let text = '';
  let thoughtChars = 0;
  let plan = null;
  let usage = null;
  const other = [];
  for (const { update: u } of updates) {
    counts[u.sessionUpdate] = (counts[u.sessionUpdate] ?? 0) + 1;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') text += u.content.text; break;
      case 'agent_thought_chunk':
        thoughtChars += u.content?.text?.length ?? 0; break;
      case 'tool_call':
        tools.set(u.toolCallId, {
          toolCallId: u.toolCallId, title: u.title, kind: u.kind, status: u.status,
          rawInput: u.rawInput, locations: u.locations, statuses: [u.status].filter(Boolean),
        });
        break;
      case 'tool_call_update': {
        const t = tools.get(u.toolCallId) ?? { toolCallId: u.toolCallId, statuses: [] };
        for (const k of ['title', 'kind', 'status', 'rawInput', 'locations']) if (u[k] !== undefined && u[k] !== null) t[k] = u[k];
        if (u.status) t.statuses.push(u.status);
        if (u.rawOutput !== undefined) t.rawOutput = JSON.stringify(u.rawOutput)?.slice(0, 500);
        tools.set(u.toolCallId, t);
        break;
      }
      case 'plan': plan = u.entries; break;
      case 'usage_update': usage = u; break;
      case 'agent_message_chunk_end': break;
      default:
        if (!['user_message_chunk'].includes(u.sessionUpdate)) other.push(u.sessionUpdate);
    }
  }
  return {
    counts,
    text,
    thoughtChars,
    toolCalls: [...tools.values()],
    plan,
    lastUsageUpdate: usage,
    otherUpdateTypes: [...new Set(other)],
  };
}
