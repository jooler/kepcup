// 各探测 step。签名 (ctx) => Promise<{ status?, data, keepTrace? }>；抛错 = status 'error'。
// keepTrace=false 的 step（多轮统计）只存摘要，不存原始 JSON-RPC。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { summarizeUpdates } from './context.mjs';
import { startMcpServer, DEFAULT_TOOLS, NATIVE_FIRST_TOOLS } from './mcp-server.mjs';
import { registerSecret, redact } from './redact.mjs';
import { stripAnsi, resolveCommand } from './client.mjs';
import { errInfo, killTree, now, percentile, sleep, withTimeout } from './util.mjs';

const PROMPT_DEFAULT = 'List the files in the current working directory using one of your tools, then summarize what you found in one sentence.';
const PROMPT_LONG = 'Use your shell tool to run: for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo $i; sleep 2; done  -- then reply with the single word FINISHED. If you have no shell tool, count slowly from 1 to 40, one number per line, then write FINISHED.';
const STEER_TEXT = 'Change of plan: stop what you are doing and reply with only the word STEERED.';

const isAuthError = (e) => e && (e.code === -32000 || /auth|log ?in|sign ?in|api[ _-]?key|credential|unauthori[sz]ed/i.test(String(e.message)));

function rle(updates) {
  const out = [];
  for (const { update } of updates) {
    const k = update.sessionUpdate;
    const last = out[out.length - 1];
    if (last && last.type === k) last.n += 1; else out.push({ type: k, n: 1 });
  }
  return out.map((x) => (x.n > 1 ? `${x.type}x${x.n}` : x.type));
}

function promptData(r, text) {
  const summary = summarizeUpdates(r.updates);
  return {
    prompt: text,
    response: r.response ? redact(r.response) : undefined,
    error: r.error,
    timedOut: r.timedOut,
    ms: r.ms,
    firstUpdateMs: r.firstUpdateMs,
    firstChunkMs: r.firstChunkMs,
    sequence: rle(r.updates),
    summary: redact(summary),
    permissionRequests: r.permissions.length,
  };
}

function sessionDigest(result) {
  return {
    sessionId: result.sessionId,
    modes: result.modes ?? null,
    configOptions: result.configOptions ?? null,
    models: result.models ?? null,
    extraTopLevelKeys: Object.keys(result).filter((k) => !['sessionId', 'modes', 'configOptions', 'models', '_meta'].includes(k)),
    _meta: result._meta ?? null,
  };
}

function modeIds(result) {
  return (result?.modes?.availableModes ?? []).map((m) => m.id);
}

function pickReadOnlyMode(ctx, result) {
  const ids = modeIds(result);
  return (ctx.agent.readOnlyModeIds ?? []).find((m) => ids.includes(m));
}

async function ensurePrimary(ctx) {
  if (ctx.primary && ctx.alive) return ctx.primary;
  ctx.primary = await ctx.newSession();
  return ctx.primary;
}

function permPolicy(ctx, fallback) { return ctx.opts.permission ?? fallback; }

// ---------------------------------------------------------------------------

export async function initialize(ctx) {
  if (ctx.proc) await ctx.shutdown();
  ctx.primary = null;
  const cold = await ctx.connect();
  const r = cold.response;
  const data = {
    npxCacheWasCold: ctx.launchInfo.npxCacheWasCold,
    coldStartMs: cold.coldStartMs,
    rssKbAfterInit: cold.rssKbAfterInit,
    clientRequest: redact(cold.request),
    // 原文（脱敏）
    response: redact(r),
    highlights: {
      protocolVersion: r.protocolVersion,
      agentInfo: r.agentInfo,
      agentCapabilities: r.agentCapabilities,
      authMethods: r.authMethods,
      _meta: r._meta,
      promptCapabilities: r.agentCapabilities?.promptCapabilities,
      mcpCapabilities: r.agentCapabilities?.mcpCapabilities,
      sessionCapabilities: r.agentCapabilities?.sessionCapabilities,
      loadSession: r.agentCapabilities?.loadSession,
      steeringAdvertised: r._meta?.steering ?? null,
    },
    agentStderrTail: ctx.stderrTail(15),
  };
  if (ctx.opts.warm) {
    await ctx.shutdown();
    const warm = await ctx.connect();
    data.warmStartMs = warm.coldStartMs;
    data.rssKbAfterInitWarm = warm.rssKbAfterInit;
  }
  return { data };
}

export async function auth(ctx) {
  await ctx.ensureConnected();
  const methods = ctx.initResult?.authMethods ?? [];
  const launch = ctx.launchInfo;
  const forbidden = ctx.agent.forbiddenAuthMethodIds ?? [];
  const base = (p) => path.basename(p).replace(/\.(exe|cmd)$/i, '');
  // 返回该 method 的实际终端调用：type:'terminal' -> agent 调用 + args；仅 _meta['terminal-auth'] -> meta.command/args/env
  const terminalOf = (m) => {
    const meta = m._meta?.['terminal-auth'];
    if ((m.type ?? 'agent') === 'terminal') {
      return { via: 'type=terminal', command: launch.command, args: [...launch.args, ...(m.args ?? [])], env: m.env ?? {} };
    }
    if (meta && typeof meta === 'object') {
      // meta.command 常是裸名（如 'opencode'）：与我们启动的可执行文件同名时用我们的路径
      const command = base(meta.command ?? '') === base(launch.command) ? launch.command : meta.command;
      return { via: '_meta.terminal-auth', command, args: meta.args ?? [], env: meta.env ?? {}, metaCommandAsAdvertised: meta.command, label: meta.label };
    }
    return null;
  };
  const analysis = methods.map((m) => {
    const type = m.type ?? 'agent';
    const entry = { id: m.id, name: m.name, type, description: m.description, forbiddenByKepCup: forbidden.includes(m.id) };
    const t = terminalOf(m);
    if (t) {
      entry.kind = 'terminal';
      entry.terminalInvocation = { via: t.via, command: t.command, args: t.args, extraEnvKeys: Object.keys(t.env), metaCommandAsAdvertised: t.metaCommandAsAdvertised };
      if (m._meta?.['terminal-auth']) entry.metaTerminalAuth = redact(m._meta['terminal-auth']);
    } else {
      entry.kind = 'agent';
    }
    return entry;
  });
  const data = {
    authMethods: redact(methods),
    analysis,
    terminalMethodIds: analysis.filter((a) => a.kind === 'terminal').map((a) => a.id),
    agentMethodIds: analysis.filter((a) => a.kind === 'agent').map((a) => a.id),
    executed: null,
    hint: 'authenticate / 终端登录只在指定 --auth-method <id> 时执行；登录后用同一 --home 重跑 session 及之后的步骤',
  };
  const id = ctx.opts.authMethod;
  if (!id) return { data };

  const method = methods.find((m) => m.id === id);
  if (!method) throw new Error(`--auth-method ${id}: not in authMethods [${methods.map((m) => m.id).join(', ')}]`);
  if (forbidden.includes(id)) throw new Error(`auth method ${id} is forbidden for ${ctx.agentId} by KepCup policy (see design 28 §9.3)`);
  const term = terminalOf(method);
  const t0 = now();
  if (!term) {
    try {
      const res = await withTimeout(ctx.conn.authenticate({ methodId: id }), ctx.timeoutMs('auth'), 'authenticate');
      data.executed = { kind: 'authenticate', ok: true, ms: now() - t0, response: redact(res) };
    } catch (e) {
      data.executed = { kind: 'authenticate', ok: false, ms: now() - t0, error: errInfo(e) };
    }
    return { data };
  }
  const args = term.args;
  const env = { ...launch.env, ...term.env };
  const mode = ctx.opts.authStdio ?? (process.stdin.isTTY ? 'inherit' : 'pipe');
  const cmd = resolveCommand(term.command);
  const child = spawn(cmd, args, {
    cwd: ctx.cwd, env,
    stdio: mode === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
  });
  let out = '';
  if (mode !== 'inherit') {
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
  }
  const exit = await Promise.race([
    new Promise((resolve) => { child.on('exit', (code, signal) => resolve({ code, signal })); child.on('error', (e) => resolve({ error: e.message })); }),
    sleep(ctx.timeoutMs('auth')).then(() => ({ timeout: true })),
  ]);
  if (exit.timeout) killTree(child);
  data.executed = {
    kind: 'terminal',
    via: term.via,
    stdio: mode,
    command: cmd, args,
    exit,
    ms: now() - t0,
    outputTail: mode === 'inherit' ? '(inherited tty)' : redact(stripAnsi(out).slice(-3000)),
    ttyAvailable: Boolean(process.stdin.isTTY),
  };
  return { data };
}


export async function session(ctx) {
  await ctx.ensureConnected();
  const t0 = now();
  try {
    const s = await ctx.newSession();
    ctx.primary = s;
    return {
      data: {
        outcome: 'ok', ms: s.ms, request: redact(s.request),
        result: redact(s.result), digest: redact(sessionDigest(s.result)),
        agentStderrTail: ctx.stderrTail(10),
      },
    };
  } catch (e) {
    const info = errInfo(e);
    return {
      status: 'error',
      data: {
        outcome: 'error', ms: now() - t0,
        error: redact(info),
        classification: isAuthError(info) ? 'auth_required' : 'other',
        agentStderrTail: ctx.stderrTail(15),
      },
    };
  }
}

export async function prompt(ctx) {
  const s = await ensurePrimary(ctx);
  const text = ctx.opts.prompt ?? PROMPT_DEFAULT;
  const r = await ctx.prompt(s.sessionId, text, { policy: permPolicy(ctx, 'allow_once'), step: 'prompt' });
  return {
    status: r.error ? 'error' : 'ok',
    data: { ...promptData(r, text), permissionEvents: r.permissions },
  };
}

export async function steer(ctx) {
  const s = await ctx.newSession();
  const caps = ctx.initResult?._meta?.steering ?? null;
  const run = ctx.startPrompt(s.sessionId, PROMPT_LONG, { policy: permPolicy(ctx, 'allow_once') });
  const first = await run.waitFirst(() => true, 45000);
  const data = { steeringAdvertised: caps, firstUpdateBeforeSteerMs: first?.atMs ?? null };
  const t0 = now();
  let steerOutcome;
  try {
    const res = await withTimeout(ctx.conn.extMethod('_session/steering', {
      sessionId: s.sessionId,
      prompt: [{ type: 'text', text: STEER_TEXT }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }), 30000, '_session/steering');
    steerOutcome = { ok: true, ms: now() - t0, response: redact(res) };
  } catch (e) {
    steerOutcome = { ok: false, ms: now() - t0, error: errInfo(e) };
  }
  data.steer = steerOutcome;

  // 不支持 steering：探测「会话忙时再发 prompt」
  if (!steerOutcome.ok) {
    const tb = now();
    const second = ctx.startPrompt(s.sessionId, 'Reply with only the word SECOND.', {});
    const early = await Promise.race([second.promise.then((x) => ({ settled: true, x })), sleep(8000).then(() => ({ settled: false }))]);
    data.busyPrompt = early.settled
      ? { settledWithinMs: now() - tb, ...redact(early.x) }
      : { settledWithinMs: null, note: '8s 内第二个 prompt 未返回（排队或被忽略）' };
  }

  const r = await run.finish(ctx.timeoutMs('steer'));
  const p = promptData(r, PROMPT_LONG);
  data.firstPrompt = p;
  data.textAfterSteer = r.updates
    .filter((u) => u.t >= t0 && u.update.sessionUpdate === 'agent_message_chunk' && u.update.content?.type === 'text')
    .map((u) => u.update.content.text).join('');
  data.steerTookEffect = /STEERED/i.test(data.textAfterSteer);

  // 空闲 steering：预期 {outcome:'promptRequired'}
  const ti = now();
  try {
    const res = await withTimeout(ctx.conn.extMethod('_session/steering', {
      sessionId: s.sessionId,
      prompt: [{ type: 'text', text: 'ignored' }],
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }), 30000, '_session/steering(idle)');
    data.idleSteer = { ok: true, ms: now() - ti, response: redact(res) };
  } catch (e) {
    data.idleSteer = { ok: false, ms: now() - ti, error: errInfo(e) };
  }
  return { status: 'ok', data };
}

export async function cancel(ctx) {
  const s = await ctx.newSession();
  const run = ctx.startPrompt(s.sessionId, PROMPT_LONG, { policy: permPolicy(ctx, 'allow_once') });
  const first = await run.waitFirst((u) => ['tool_call', 'agent_message_chunk'].includes(u.update.sessionUpdate), 60000);
  const data = { firstUpdateBeforeCancelMs: first?.atMs ?? null };
  const tc = now();
  await ctx.conn.cancel({ sessionId: s.sessionId });
  const settled = await Promise.race([run.promise, sleep(60000).then(() => ({ timeout: true }))]);
  const settledAt = now();
  data.cancelToSettleMs = settled.timeout ? null : settledAt - tc;
  data.settled = settled.timeout ? 'timeout(60s)' : redact(settled);
  data.stopReason = settled.response?.stopReason ?? null;
  await sleep(1500);
  const after = run.updatesNow().filter((u) => u.t > settledAt);
  data.updatesAfterSettle = after.length;
  // 取消后同一会话还能继续用吗
  try {
    const r = await ctx.prompt(s.sessionId, 'Reply with only the word ALIVE.', { timeoutMs: 90000, policy: 'reject_once' });
    data.followUp = { ok: !r.error, ms: r.ms, text: summarizeUpdates(r.updates).text.slice(0, 200), error: r.error };
  } catch (e) {
    data.followUp = { ok: false, error: errInfo(e) };
  }
  return { status: settled.timeout ? 'error' : 'ok', data };
}

export async function permission(ctx) {
  const policy = permPolicy(ctx, 'reject_once');
  const secret = path.join(ctx.outsideDir, 'secret.txt');
  fs.writeFileSync(secret, 'outside-secret-line\n');
  const cases = [
    { id: 'read-outside-cwd', text: `Read the file ${secret} with your file-reading tool and tell me its first line.` },
    { id: 'write-outside-cwd', text: `Create the file ${path.join(ctx.outsideDir, 'written.txt')} containing the text "spike" using your file-writing tool.` },
    { id: 'write-inside-cwd', text: 'Create a file named spike-inside.txt in the current directory containing the text "spike" using your file-writing tool.' },
    { id: 'exec-command', text: 'Run the shell command `echo spike-ok` with your shell tool and show me the output.' },
  ];
  const probe = await ctx.newSession();
  const hasPlan = modeIds(probe.result).includes('plan');
  if (hasPlan) cases.push({ id: 'plan-exit', mode: 'plan', text: 'Write a two-step plan to create a file named plan.txt, then present the plan for my approval.' });
  const out = [];
  const optionIds = {};
  for (const c of cases) {
    const s = c === cases[0] ? probe : await ctx.newSession();
    try {
      if (c.mode) await ctx.conn.setSessionMode({ sessionId: s.sessionId, modeId: c.mode });
      const r = await ctx.prompt(s.sessionId, c.text, { policy, step: 'permission' });
      for (const p of r.permissions) {
        for (const o of p.options) {
          const e = (optionIds[o.optionId] ??= { kind: o.kind, names: [] });
          if (!e.names.includes(o.name)) e.names.push(o.name);
        }
      }
      out.push({ case: c.id, mode: c.mode ?? null, policy, ...promptData(r, c.text), permissionEvents: r.permissions });
    } catch (e) {
      out.push({ case: c.id, error: errInfo(e) });
    }
  }
  return { status: 'ok', data: { policy, cases: out, optionIdWhitelist: optionIds } };
}

export async function mcp(ctx) {
  const server = await startMcpServer({ tools: DEFAULT_TOOLS });
  registerSecret(server.token);
  try {
    const caps = ctx.agentCaps().mcpCapabilities ?? null;
    const s = await ctx.newSession({ mcpServers: [server.acpServer] });
    const text = `An MCP server named "${server.name}" is attached to this session. Call its tool "echo" with {"text":"ping-123"} and then reply with: (1) the exact tool name as it is shown to you, (2) the tool result.`;
    const r = await ctx.prompt(s.sessionId, text, { policy: permPolicy(ctx, 'allow_once'), step: 'mcp' });
    const summary = summarizeUpdates(r.updates);
    const mcpish = (t) => /echo|kepcup-spike/i.test(`${t.title ?? ''} ${JSON.stringify(t.rawInput ?? '')}`);
    const permForMcp = r.permissions.filter((p) => /echo|kepcup-spike/i.test(JSON.stringify(p.toolCall)));
    return {
      status: r.error ? 'error' : 'ok',
      data: {
        advertisedMcpCapabilities: caps,
        server: { url: server.url, auth: 'Authorization: Bearer <random>', ...server.summary() },
        agentSeenToolCalls: summary.toolCalls.filter(mcpish),
        permissionRequestedForMcpTool: permForMcp.length > 0,
        permissionEventsForMcpTool: permForMcp,
        allPermissionRequests: r.permissions.length,
        ...promptData(r, text),
      },
    };
  } finally {
    await server.close();
  }
}

export async function modes(ctx) {
  const s = await ctx.newSession();
  const result = s.result;
  const data = { digest: redact(sessionDigest(result)), setMode: [], configOptions: [] };
  const current = result.modes?.currentModeId;
  for (const id of modeIds(result)) {
    try {
      const res = await withTimeout(ctx.conn.setSessionMode({ sessionId: s.sessionId, modeId: id }), 30000, `set_mode ${id}`);
      data.setMode.push({ id, ok: true, response: redact(res) });
    } catch (e) {
      data.setMode.push({ id, ok: false, error: errInfo(e) });
    }
  }
  if (current && modeIds(result).includes(current)) {
    try { await ctx.conn.setSessionMode({ sessionId: s.sessionId, modeId: current }); } catch { /* ignore */ }
  }
  // config options / 模型：逐个 select 列出取值（只读取，不改）
  for (const o of result.configOptions ?? []) {
    data.configOptions.push(redact({ id: o.id, name: o.name, category: o.category, type: o.type, currentValue: o.currentValue, options: o.options }));
  }
  data.modelsNote = result.models ? 'agent 返回了 models（unstable 字段）' : null;
  return { data };
}

function tryParseJson(text) {
  const t = text.trim();
  try { return { value: JSON.parse(t), strict: true }; } catch { /* 宽松 */ }
  const i = t.indexOf('{'); const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return { value: JSON.parse(t.slice(i, j + 1)), strict: false }; } catch { /* fail */ } }
  return null;
}

export async function complete(ctx) {
  const runs = ctx.opts.runs ?? 5;
  const INSTR = 'You are a JSON-only function. Respond with exactly one JSON object and nothing else: no markdown fences, no prose. Do not use any tools.';
  const TASK = 'Compute 17*3 and name two fruits. Output: {"answer": <number>, "words": ["<fruit1>", "<fruit2>"]}';
  const metaAppend = ctx.agent.instructionMode === 'meta-append';
  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const rec = { run: i + 1 };
    try {
      const probeMeta = metaAppend ? { systemPrompt: { append: INSTR } } : undefined;
      const s = await ctx.newSession({ meta: probeMeta, cwd: ctx.outsideDir });
      const mode = pickReadOnlyMode(ctx, s.result);
      if (mode) { await ctx.conn.setSessionMode({ sessionId: s.sessionId, modeId: mode }); rec.mode = mode; }
      const text = metaAppend ? TASK : `${INSTR}\n\n${TASK}`;
      const r = await ctx.prompt(s.sessionId, text, { policy: 'reject_once', step: 'complete' });
      const sum = summarizeUpdates(r.updates);
      const parsed = tryParseJson(sum.text);
      rec.ms = r.ms;
      rec.firstChunkMs = r.firstChunkMs;
      rec.stopReason = r.response?.stopReason ?? null;
      rec.error = r.error;
      rec.toolCalls = sum.toolCalls.length;
      rec.permissionRequests = r.permissions.length;
      rec.parsed = Boolean(parsed);
      rec.strictJsonOnly = Boolean(parsed?.strict);
      rec.correct = parsed?.value?.answer === 51;
      rec.textHead = sum.text.slice(0, 200);
    } catch (e) {
      rec.error = errInfo(e);
    }
    results.push(rec);
    ctx.log(`complete run ${i + 1}/${runs}: ${rec.correct ? 'ok' : 'fail'} ${rec.ms ?? '-'}ms`);
  }
  const ms = results.map((r) => r.ms).filter((x) => x !== undefined).sort((a, b) => a - b);
  return {
    keepTrace: ctx.opts.traceAll === true,
    data: {
      runs,
      instructionMode: ctx.agent.instructionMode,
      successRate: results.filter((r) => r.correct).length / runs,
      parsedRate: results.filter((r) => r.parsed).length / runs,
      strictJsonOnlyRate: results.filter((r) => r.strictJsonOnly).length / runs,
      latencyMs: { p50: percentile(ms, 50), p95: percentile(ms, 95), min: ms[0] ?? null, max: ms[ms.length - 1] ?? null },
      runsWithToolCalls: results.filter((r) => r.toolCalls > 0).length,
      results,
    },
  };
}

export async function native(ctx) {
  const runs = ctx.opts.runs ?? 5;
  const server = await startMcpServer({ tools: NATIVE_FIRST_TOOLS });
  registerSecret(server.token);
  const POLICY = '<tool_policy>\n优先使用你自带的原生工具（例如自带的联网搜索 / 网页抓取）完成任务。名称或描述带「[补充能力]」前缀的注入工具，仅在你没有对应的原生工具时才使用。\n</tool_policy>';
  const TASK = '请联网搜索并告诉我 Node.js 目前的 LTS 版本号，引用来源。';
  const results = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      server.reset();
      const rec = { run: i + 1 };
      try {
        const s = await ctx.newSession({ mcpServers: [server.acpServer] });
        const r = await ctx.prompt(s.sessionId, `${POLICY}\n\n${TASK}`, { policy: 'allow_once', step: 'native' });
        const sum = summarizeUpdates(r.updates);
        const mcpCalls = server.toolCalls.filter((c) => c.name === 'web_search').length;
        const isMcpTool = (t) => /web_search/.test(`${t.title ?? ''} ${JSON.stringify(t.rawInput ?? '')}`) && mcpCalls > 0;
        const nativeTools = sum.toolCalls.filter((t) => !isMcpTool(t) && (t.kind === 'search' || t.kind === 'fetch' || /web|fetch|search|browse/i.test(t.title ?? '')));
        rec.ms = r.ms;
        rec.error = r.error;
        rec.mcpWebSearchCalls = mcpCalls;
        rec.nativeToolCalls = nativeTools.map((t) => ({ title: t.title, kind: t.kind }));
        rec.allTools = sum.toolCalls.map((t) => ({ title: t.title, kind: t.kind }));
        rec.choice = nativeTools.length && !mcpCalls ? 'native' : mcpCalls && !nativeTools.length ? 'injected' : mcpCalls && nativeTools.length ? 'both' : 'none';
        rec.mcpListed = server.summary().toolsListed;
        rec.textHead = sum.text.slice(0, 160);
      } catch (e) {
        rec.error = errInfo(e);
        rec.choice = 'error';
      }
      results.push(rec);
      ctx.log(`native run ${i + 1}/${runs}: ${rec.choice}`);
    }
  } finally {
    await server.close();
  }
  const count = (c) => results.filter((r) => r.choice === c).length;
  return {
    keepTrace: ctx.opts.traceAll === true,
    data: {
      runs,
      nativeFirstCount: count('native'),
      injectedOnlyCount: count('injected'),
      bothCount: count('both'),
      noneCount: count('none'),
      errorCount: count('error'),
      nativeFirstRatio: count('native') / runs,
      target: '>= 0.9',
      classificationNote: '启发式：按 tool_call 的 kind(search/fetch)/title 判断原生；MCP 以服务端收到 web_search 调用为准。请人工复核 results[].allTools。',
      results,
    },
  };
}

// —— P6 原生优先遵守度回归（todo §9.1）：用产品的真实措辞 ————————————————
// fixtures/native-first-wording.json 由 core 单测按产品代码生成（措辞一改单测
// 就失败）：补位工具的「[补充能力]」描述前缀 + <tool_policy>（按 Provider 的
// 工具名写法、点名该 Agent 自带的原生工具）。本 step 照产品方式下发（meta-append
// → session/new._meta.systemPrompt.append；prompt-prefix → prompt 前置段），
// 注入同名 MCP 工具，统计 Agent 选原生工具的比例（目标 ≥ 0.9）。

const ADHERENCE_FIXTURE = new URL('../fixtures/native-first-wording.json', import.meta.url);
// 1×1 PNG（纯色），vision 用例的图片块。
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const ADHERENCE_TASKS = {
  web: '请联网搜索并告诉我 Node.js 目前的 LTS 版本号，引用来源。',
  vision: '这张图片是什么颜色？一句话回答。',
};

export function loadAdherenceWording(agentId) {
  const fixture = JSON.parse(fs.readFileSync(ADHERENCE_FIXTURE, 'utf8'));
  const wording = fixture.agents[agentId];
  if (!wording) throw new Error(`fixtures/native-first-wording.json 没有「${agentId}」的措辞`);
  return { serverName: fixture.serverName, wording };
}

/** 一次运行的选择：native / injected / both / none（MCP 以服务端实际收到的调用为准）。 */
export function classifyAdherence(caseId, toolCalls, mcpCalls) {
  const injectedNames = new Set(['web_search', 'web_fetch', 'understand_image']);
  const isInjected = (t) => injectedNames.has(String(t.name ?? '')) ||
    [...injectedNames].some((name) => `${t.title ?? ''} ${JSON.stringify(t.rawInput ?? '')}`.includes(name));
  const nativeTools = toolCalls.filter((t) => !isInjected(t) && (caseId === 'web'
    ? t.kind === 'search' || t.kind === 'fetch' || /web|fetch|search|browse/i.test(t.title ?? '')
    : t.kind === 'read' || /image|read|view/i.test(t.title ?? '')));
  // vision：模型直接看图回答（不调任何工具）也算原生。
  const nativeAnswer = caseId === 'vision' && toolCalls.length === 0;
  const native = nativeTools.length > 0 || nativeAnswer;
  return {
    choice: native && !mcpCalls ? 'native' : mcpCalls && !native ? 'injected' : mcpCalls && native ? 'both' : 'none',
    nativeTools: nativeTools.map((t) => ({ title: t.title, kind: t.kind })),
  };
}

export async function adherence(ctx) {
  const runs = ctx.opts.runs ?? 5;
  const { serverName, wording } = loadAdherenceWording(ctx.agent.id);
  const metaAppend = wording.instructionMode === 'meta-append';
  const acceptsImages = ctx.agentCaps().promptCapabilities?.image === true;
  const cases = {};
  for (const [caseId, testCase] of Object.entries(wording.cases)) {
    if (caseId === 'vision' && !acceptsImages) {
      cases[caseId] = { skipped: 'Agent 未声明 promptCapabilities.image' };
      continue;
    }
    const server = await startMcpServer({
      name: serverName,
      tools: testCase.tools.map((tool) => ({
        ...tool,
        handler: () => `ADHERENCE-STUB ${tool.name}: 注入工具的占位结果（真机遵守度测试）。`,
      })),
    });
    registerSecret(server.token);
    const policy = `<tool_policy>\n${testCase.policy}\n</tool_policy>`;
    const results = [];
    try {
      for (let i = 0; i < runs; i += 1) {
        server.reset();
        const rec = { run: i + 1 };
        try {
          const s = await ctx.newSession({
            mcpServers: [server.acpServer],
            ...(metaAppend ? { meta: { systemPrompt: { append: policy } } } : {}),
          });
          const task = ADHERENCE_TASKS[caseId];
          const text = metaAppend ? task : `${policy}\n\n${task}`;
          const blocks = caseId === 'vision'
            ? [{ type: 'text', text }, { type: 'image', data: TINY_PNG, mimeType: 'image/png' }]
            : undefined;
          const r = await ctx.prompt(s.sessionId, text, { policy: 'allow_once', step: 'adherence', blocks });
          const sum = summarizeUpdates(r.updates);
          const mcpCalls = server.toolCalls.length;
          const verdict = classifyAdherence(caseId, sum.toolCalls, mcpCalls);
          rec.ms = r.ms;
          rec.error = r.error;
          rec.mcpCalls = server.toolCalls.map((c) => c.name);
          rec.nativeToolCalls = verdict.nativeTools;
          rec.allTools = sum.toolCalls.map((t) => ({ title: t.title, kind: t.kind }));
          rec.choice = r.error ? 'error' : verdict.choice;
          rec.mcpListed = server.summary().toolsListed;
          rec.textHead = sum.text.slice(0, 160);
        } catch (e) {
          rec.error = errInfo(e);
          rec.choice = 'error';
        }
        results.push(rec);
        ctx.log(`adherence ${caseId} ${i + 1}/${runs}: ${rec.choice}`);
      }
    } finally {
      await server.close();
    }
    const count = (c) => results.filter((r) => r.choice === c).length;
    cases[caseId] = {
      runs,
      native: count('native'),
      injected: count('injected'),
      both: count('both'),
      none: count('none'),
      error: count('error'),
      nativeFirstRatio: count('native') / runs,
      pass: count('native') / runs >= 0.9,
      results,
    };
  }
  return {
    keepTrace: ctx.opts.traceAll === true,
    data: {
      fixture: 'fixtures/native-first-wording.json',
      catalogId: wording.catalogId,
      instructionMode: wording.instructionMode,
      nativeCapabilities: wording.nativeCapabilities,
      target: '>= 0.9',
      classificationNote: '启发式：web 按 tool_call 的 kind(search/fetch)/title 判断原生；vision 不调工具直接作答也算原生；注入以 MCP 服务端收到的调用为准。请人工复核 results[].allTools。',
      cases,
    },
  };
}

export async function resume(ctx) {
  const caps = ctx.agentCaps();
  const s = await ctx.newSession();
  const r1 = await ctx.prompt(s.sessionId, 'Remember the secret word PINEAPPLE. Reply with only OK.', { policy: 'reject_once', step: 'resume' });
  const data = { loadSessionAdvertised: caps.loadSession ?? false, resumeAdvertised: caps.sessionCapabilities?.resume ?? null, firstPrompt: { ok: !r1.error, error: r1.error } };
  await ctx.shutdown();
  await ctx.connect();
  const probe = async (name, fn) => {
    const mark = ctx.client.updates.length;
    const t0 = now();
    try {
      const res = await withTimeout(fn(), 60000, name);
      await sleep(1500);
      const replay = ctx.client.updates.slice(mark).filter((u) => u.sessionId === s.sessionId);
      const follow = await ctx.prompt(s.sessionId, 'What secret word did I ask you to remember? Reply with only the word.', { policy: 'reject_once', step: 'resume' });
      return {
        ok: true, ms: now() - t0, response: redact(res),
        replay: { updates: replay.length, sequence: rle(replay).slice(0, 40), types: summarizeUpdates(replay).counts },
        followUp: { error: follow.error, text: summarizeUpdates(follow.updates).text.slice(0, 120), remembered: /PINEAPPLE/i.test(summarizeUpdates(follow.updates).text) },
      };
    } catch (e) {
      return { ok: false, ms: now() - t0, error: errInfo(e) };
    }
  };
  data.resume = await probe('session/resume', () => ctx.conn.resumeSession({ sessionId: s.sessionId, cwd: ctx.cwd, mcpServers: [] }));
  if (!data.resume.ok) {
    await ctx.shutdown(); await ctx.connect();
  }
  data.load = await probe('session/load', () => ctx.conn.loadSession({ sessionId: s.sessionId, cwd: ctx.cwd, mcpServers: [] }));
  return { data };
}

export const STEPS = { initialize, auth, session, prompt, steer, cancel, permission, mcp, modes, complete, native, resume, adherence };
