#!/usr/bin/env node
// KepCup P0 参数化 Agent spike：用 ACP v1 客户端驱动外部编码 Agent，输出 JSON 报告。
// 用法见 README.md。需要 Node >= 22（fetch / parseArgs / Web Streams）。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AGENTS, ALL_STEPS } from './agents.mjs';
import { Context } from './lib/context.mjs';
import { STEPS } from './lib/steps.mjs';
import { detectZCode } from './lib/zcode.mjs';
import { redact } from './lib/redact.mjs';
import { errInfo, now } from './lib/util.mjs';

const HELP = `node spike.mjs --agent <id> [options]

  --agent <id>          ${Object.keys(AGENTS).join(' | ')}
  --steps <a,b,...>     默认全部（${ALL_STEPS.join(',')}）；另有可选 resume、adherence（P6，见 adherence.mjs）
  --out <file>          报告 JSON（默认 ./spike-<agent>-<时间>.json）
  --work-dir <dir>      工作根（默认 $TMPDIR/kepcup-spike/<agent>）：home/ cwd/ outside/ bin/
  --home <dir>          Agent 进程的独立 HOME（默认 <work-dir>/home；登录态保存在这里）
  --cwd <dir>           session 的工作目录（默认 <work-dir>/cwd）
  --command <cmd>       覆盖启动命令（已安装的可执行文件）；参数用 --args=<v>（可重复）或 -- 之后全部
  --env KEY=VAL         给 Agent 进程加环境变量（可重复；值自动脱敏）
  --pass-env KEY        把宿主环境变量透传给 Agent（如 DEEPSEEK_API_KEY；可重复）
  --permission <p>      allow_once | reject_once | cancel（默认：permission 步 reject_once，其余 allow_once）
  --runs <n>            complete / native / adherence 的次数（默认 5，正式验收：complete 20、native / adherence 10）
  --prompt <text>       prompt 步的提示词
  --isolate             session/new._meta 带该 Agent 的「尽量不读用户 / 项目配置」预设
  --session-meta <json> 追加到 session/new._meta 的 JSON
  --auth-method <id>    auth 步实际执行该认证（terminal：以子进程运行；agent：authenticate）
  --auth-stdio <m>      inherit | pipe（默认有 TTY 则 inherit，否则 pipe；pipe 用于验证无 TTY 能否完成）
  --timeout <sec>       统一每步超时（默认按步骤：initialize 300 / 其余 90–240）
  --warm                initialize 步结束后再冷 / 热启动一次，记 warmStartMs
  --allow-large         允许下载 cursor / antigravity 的大归档
  --registry-file <f>   使用本地 registry.json（默认从 CDN 下载）
  --install-dir <dir>   binary 解压目录（默认 <work-dir>/bin）
  --trace-all           complete / native 也保存原始 JSON-RPC
  --quiet               不打印进度
`;

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: 'string' }, steps: { type: 'string' }, out: { type: 'string' },
      'work-dir': { type: 'string' }, home: { type: 'string' }, cwd: { type: 'string' },
      command: { type: 'string' }, args: { type: 'string', multiple: true },
      env: { type: 'string', multiple: true }, 'pass-env': { type: 'string', multiple: true },
      permission: { type: 'string' }, runs: { type: 'string' }, prompt: { type: 'string' },
      isolate: { type: 'boolean' }, 'session-meta': { type: 'string' },
      'auth-method': { type: 'string' }, 'auth-stdio': { type: 'string' },
      timeout: { type: 'string' }, warm: { type: 'boolean' }, 'allow-large': { type: 'boolean' },
      'registry-file': { type: 'string' }, 'install-dir': { type: 'string' },
      'trace-all': { type: 'boolean' }, quiet: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.agent) { process.stdout.write(HELP); process.exit(values.help ? 0 : 2); }
  if (values.permission && !['allow_once', 'reject_once', 'cancel'].includes(values.permission)) {
    throw new Error('--permission must be allow_once | reject_once | cancel');
  }
  const args = values.args || positionals.length ? [...(values.args ?? []), ...positionals] : undefined;
  return {
    agent: values.agent,
    steps: (values.steps ?? ALL_STEPS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    out: values.out,
    opts: {
      workDir: values['work-dir'], home: values.home, cwd: values.cwd,
      command: values.command, args,
      env: values.env, passEnv: values['pass-env'],
      permission: values.permission,
      runs: values.runs ? Number(values.runs) : undefined,
      prompt: values.prompt, isolate: values.isolate,
      sessionMeta: values['session-meta'] ? JSON.parse(values['session-meta']) : undefined,
      authMethod: values['auth-method'], authStdio: values['auth-stdio'],
      timeout: values.timeout ? Number(values.timeout) : undefined,
      warm: values.warm, allowLarge: values['allow-large'],
      registryFile: values['registry-file'], installDir: values['install-dir'],
      traceAll: values['trace-all'], quiet: values.quiet,
    },
  };
}

async function main() {
  const { agent: agentId, steps, out, opts } = parse();
  for (const s of steps) if (!STEPS[s]) throw new Error(`unknown step "${s}" (known: ${Object.keys(STEPS).join(', ')})`);

  const report = {
    spike: 'KepCup agent-spike',
    generatedAt: new Date().toISOString(),
    agent: null, host: { platform: process.platform, arch: process.arch, node: process.version },
    steps: {},
  };
  const outFile = path.resolve(out ?? `spike-${agentId}-${report.generatedAt.replace(/[:.]/g, '-')}.json`);
  const write = () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  };

  const dist = AGENTS[agentId]?.distribution;
  if (dist?.shim) {
    report.agent = { id: agentId, title: AGENTS[agentId].title, distribution: 'shim (no ACP)' };
    report.steps.detect = { status: 'ok', data: detectZCode() };
    report.requestedSteps = steps;
    report.note = 'zcode 无 ACP：只做安装检测，其余 step 不适用';
    write();
    console.error(`[spike:${agentId}] report -> ${outFile}`);
    return;
  }

  const ctx = new Context({ agentId, opts });
  const cleanup = async () => { await ctx.shutdown().catch(() => {}); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup().finally(() => process.exit(130)); });
  process.on('exit', () => { try { if (ctx.proc) ctx.proc.child.kill('SIGKILL'); } catch { /* ignore */ } });

  report.requestedSteps = steps;
  let initFailed = false;
  try {
    await ctx.prepare();
    report.agent = { id: agentId, title: ctx.agent.title, distribution: dist, instructionMode: ctx.agent.instructionMode, loginHint: ctx.agent.loginHint };
    report.launch = ctx.describeLaunch();
  } catch (e) {
    report.agent = { id: agentId, title: ctx.agent.title, distribution: dist };
    report.prepareError = errInfo(e);
    write();
    console.error(`[spike:${agentId}] prepare failed: ${e.message}\nreport -> ${outFile}`);
    process.exitCode = 1;
    return;
  }

  for (const name of steps) {
    if (initFailed) { report.steps[name] = { status: 'skipped', reason: 'initialize failed' }; continue; }
    ctx.log(`step ${name} ...`);
    const mark = ctx.trace.length;
    const t0 = now();
    const entry = {};
    try {
      const r = await STEPS[name](ctx);
      entry.status = r.status ?? 'ok';
      entry.durationMs = now() - t0;
      entry.data = r.data;
      if (r.keepTrace !== false) entry.rpc = ctx.trace.since(mark);
    } catch (e) {
      entry.status = 'error';
      entry.durationMs = now() - t0;
      entry.error = redact(errInfo(e));
      entry.agentStderrTail = ctx.stderrTail(30);
      entry.rpc = ctx.trace.since(mark);
      if (name === 'initialize') initFailed = true;
    }
    report.steps[name] = entry;
    if (ctx.steps.initialize?.implicit && !report.steps.initialize) report.steps.initialize = ctx.steps.initialize;
    report.restarts = ctx.restarts;
    write(); // 每步落盘，进程被杀也有部分报告
    ctx.log(`step ${name}: ${entry.status} (${entry.durationMs}ms)`);
  }
  report.agentStderrTailFinal = ctx.stderrTail(30);
  // Agent 主动发来的请求 / 通知方法统计（发现扩展请求，如 cursor/ask_question）
  const inbound = { requests: {}, notifications: {} };
  for (const e of ctx.trace.entries) {
    if (e.dir !== 'recv' || !e.msg.method) continue;
    const bucket = e.msg.id !== undefined ? inbound.requests : inbound.notifications;
    bucket[e.msg.method] = (bucket[e.msg.method] ?? 0) + 1;
  }
  report.agentInitiated = { ...inbound, repliedMethodNotFound: ctx.unhandledAll.map((u) => u.method) };
  await cleanup();
  write();
  console.error(`[spike:${agentId}] report -> ${outFile}`);
  // 摘要
  const line = Object.entries(report.steps).map(([k, v]) => `${k}:${v.status}`).join(' ');
  console.error(`[spike:${agentId}] ${line}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
