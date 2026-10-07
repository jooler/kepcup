// 启动 Agent 子进程 + ACP 客户端连接（SDK ClientSideConnection）+ 原始 JSON-RPC 旁路记录。
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { redact } from './redact.mjs';
import { now, killTree } from './util.mjs';

/** 原始 JSON-RPC 往返记录（按时间顺序，所有 step 共用，step 取切片）。 */
export class Trace {
  constructor() { this.entries = []; this.t0 = now(); }
  push(dir, msg) { this.entries.push({ t: now() - this.t0, dir, msg: redact(msg) }); }
  get length() { return this.entries.length; }
  since(mark) { return this.entries.slice(mark); }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => s.replace(ANSI_RE, '');

export class SpikeClient {
  constructor() {
    this.permissionPolicy = 'allow_once'; // allow_once | reject_once | cancel
    this.permissionEvents = [];
    this.updates = []; // { t, update, sessionId }
    this.unhandled = []; // 记录 Agent 发来但我们回 -32601 的请求（由旁路 trace 补全）
  }

  async requestPermission(params) {
    const policy = this.permissionPolicy;
    const options = params.options ?? [];
    let outcome;
    let chosen = null;
    if (policy === 'cancel') {
      outcome = { outcome: 'cancelled' };
    } else {
      const opt = options.find((o) => o.kind === policy);
      if (opt) { chosen = opt.optionId; outcome = { outcome: 'selected', optionId: opt.optionId }; }
      else outcome = { outcome: 'cancelled' };
    }
    this.permissionEvents.push({
      t: now(),
      sessionId: params.sessionId,
      policy,
      chosenOptionId: chosen,
      toolCall: redact(params.toolCall),
      options: redact(options),
      _meta: redact(params._meta),
    });
    return { outcome };
  }

  async sessionUpdate(params) {
    this.updates.push({ t: now(), sessionId: params.sessionId, update: params.update, _meta: params._meta });
  }

  // 未处理的 Agent->客户端请求一律 -32601。注意：SDK 的 ClientSideConnection 对「未实现」的
  // fs / terminal 方法会静默回 result:null（不是 -32601），所以必须显式抛 methodNotFound。
  #notFound(method, params) {
    this.unhandled.push({ t: now(), method, params: redact(params) });
    throw acp.RequestError.methodNotFound(method);
  }
  readTextFile(p) { return this.#notFound('fs/read_text_file', p); }
  writeTextFile(p) { return this.#notFound('fs/write_text_file', p); }
  createTerminal(p) { return this.#notFound('terminal/create', p); }
  terminalOutput(p) { return this.#notFound('terminal/output', p); }
  releaseTerminal(p) { return this.#notFound('terminal/release', p); }
  waitForTerminalExit(p) { return this.#notFound('terminal/wait_for_exit', p); }
  killTerminal(p) { return this.#notFound('terminal/kill', p); }
  extMethod(method, p) { return this.#notFound(method, p); }
}

/** 平台上能直接 spawn 的命令名（npx 在 Windows 是 .cmd） */
export function resolveCommand(command) {
  if (process.platform === 'win32' && command === 'npx') return 'npx.cmd';
  return command;
}

export function spawnAgent({ command, args, env, cwd }) {
  const cmd = resolveCommand(command);
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
    windowsHide: true,
  });
  const stderrLines = [];
  let partial = '';
  child.stderr.on('data', (d) => {
    partial += d.toString('utf8');
    let i;
    while ((i = partial.indexOf('\n')) >= 0) {
      stderrLines.push(stripAnsi(partial.slice(0, i)));
      partial = partial.slice(i + 1);
      if (stderrLines.length > 300) stderrLines.shift();
    }
  });
  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
    child.on('error', (e) => resolve({ error: e.message }));
  });
  return { child, stderrLines, exited, spawnedAt: now() };
}

export function connectAgent(child, trace, client) {
  const raw = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const readable = raw.readable.pipeThrough(new TransformStream({
    transform(msg, ctl) { trace.push('recv', msg); ctl.enqueue(msg); },
  }));
  const writer = raw.writable.getWriter();
  const writable = new WritableStream({
    write(msg) { trace.push('send', msg); return writer.write(msg); },
    close() { return writer.close(); },
    abort(r) { return writer.abort(r); },
  });
  const conn = new acp.ClientSideConnection(() => client, { readable, writable });
  return conn;
}

export { acp, killTree };
