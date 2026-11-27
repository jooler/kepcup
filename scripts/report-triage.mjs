#!/usr/bin/env node
// 举报日常处置 CLI（todo/ai-content-reporting.md §7.6 / §7.7）。零依赖，Node ≥20
// 内置 fetch；token 只读环境变量、永不打印。生产/预发经环境变量切换：
//
//   export KEPCUP_REPORT_ADMIN_TOKEN=…        # 必需，与 Worker secret REPORT_ADMIN_TOKEN 同值
//   export KEPCUP_REPORT_ENDPOINT=…           # 可选，默认 https://reports.kepcup.com（不带 /v1）
//
// 用法（也可 `node --env-file=.env scripts/report-triage.mjs <子命令> …`）：
//   report-triage.mjs list [--status new|triaged|actioned|dismissed] [--limit N] [--client ID] [--before CURSOR]
//   report-triage.mjs show <id>                      # 完整 payload（pretty JSON）
//   report-triage.mjs set <id> <status> [--note …]   # status: triaged|actioned|dismissed
//   report-triage.mjs delete-client <clientId> [--yes]  # 删该 client 全部举报（隐私删除）
//
// 处置流程（§7.7）：list --status new → show 逐条看 → set triaged 评估 → 需要改产品的
// 处理完 set actioned --note …；无需处理的 set dismissed。保留 365 天；用户要求删除时
// delete-client。错误响应原样展示状态码与 body，退出码非 0。

import { createInterface } from 'node:readline/promises';

const TOKEN = process.env.KEPCUP_REPORT_ADMIN_TOKEN;
const BASE = (process.env.KEPCUP_REPORT_ENDPOINT ?? 'https://reports.kepcup.com')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, ''); // 容忍手滑带上 /v1；脚本自己拼完整路径

if (!TOKEN) {
  console.error(
    '缺少 KEPCUP_REPORT_ADMIN_TOKEN —— 用 node --env-file=.env 运行，或先 export。\n' +
      '（token 与 Worker secret REPORT_ADMIN_TOKEN 同值，只放 .env，本脚本不打印它。）',
  );
  process.exit(2);
}

const FILTER_STATUSES = ['new', 'triaged', 'actioned', 'dismissed'];
const PATCH_STATUSES = ['triaged', 'actioned', 'dismissed'];

const USAGE = `用法:
  report-triage.mjs list [--status new|triaged|actioned|dismissed] [--limit N] [--client ID] [--before CURSOR]
  report-triage.mjs show <id>
  report-triage.mjs set <id> <triaged|actioned|dismissed> [--note "..."]
  report-triage.mjs delete-client <clientId> [--yes]`;

// ---------------------------------------------------------------- API helper

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    console.error(`请求失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const text = await response.text();
  if (!response.ok) {
    // 错误响应原样展示状态码与 body（body 里不含 token，可安全打印）
    console.error(`HTTP ${response.status} ${method} ${path}`);
    console.error(text || '(空响应体)');
    process.exit(1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------- subcommands

async function list(args) {
  const params = new URLSearchParams();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (value === undefined) fail(`缺少 ${flag} 的值\n${USAGE}`);
    if (flag === '--status') {
      if (!FILTER_STATUSES.includes(value)) fail(`--status 只能是 ${FILTER_STATUSES.join('|')}\n${USAGE}`);
      params.set('status', value);
    } else if (flag === '--limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1) fail('--limit 需要正整数\n' + USAGE);
      params.set('limit', value);
    } else if (flag === '--client') {
      params.set('client', value);
    } else if (flag === '--before') {
      params.set('before', value);
    } else {
      fail(`list 不认识的参数 ${flag}\n${USAGE}`);
    }
  }
  const query = params.toString();
  const data = await api('GET', `/v1/admin/reports${query ? `?${query}` : ''}`);
  if (!Array.isArray(data.reports) || data.reports.length === 0) {
    console.log('(无记录)');
    return;
  }
  for (const row of data.reports) {
    const preview = String(row.messagePreview ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    console.log(
      [
        row.id,
        row.status,
        new Date(row.receivedAt).toISOString(),
        row.botName || '-',
        [row.modelProvider, row.modelId].filter(Boolean).join('/') || '-',
        `${row.messageKind} · ${row.sourceKind}`,
        preview + (String(row.messagePreview ?? '').length > 100 ? ' …' : ''),
      ].join('  '),
    );
  }
  if (typeof data.nextBefore === 'string') {
    console.log(`\n下一页：--before ${data.nextBefore}`);
  }
}

async function show(args) {
  const [id] = positional(args, 'show');
  const data = await api('GET', `/v1/admin/reports/${encodeURIComponent(id)}`);
  const report = data.report;
  if (!report) fail(`响应缺少 report 字段：${JSON.stringify(data)}`);
  const { payload, ...meta } = report;
  console.log('== 元数据 ==');
  console.log(JSON.stringify(meta, null, 2));
  console.log('== payload（完整原文）==');
  console.log(JSON.stringify(payload, null, 2));
}

async function set(args) {
  const rest = [];
  let note;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--note') {
      note = args[++i];
      if (note === undefined) fail('--note 需要一个值\n' + USAGE);
    } else {
      rest.push(args[i]);
    }
  }
  const [id, status] = positional(rest, 'set');
  if (!PATCH_STATUSES.includes(status)) {
    fail(`status 只能是 ${PATCH_STATUSES.join('|')}（'new' 是系统初始态，不可手工设置）\n${USAGE}`);
  }
  const body = { status };
  if (note !== undefined) body.note = note;
  const data = await api('PATCH', `/v1/admin/reports/${encodeURIComponent(id)}`, body);
  console.log(`已更新 ${data.id} → ${data.status}（updatedAt ${new Date(data.updatedAt).toISOString()}）`);
}

async function deleteClient(args) {
  let yes = false;
  const rest = [];
  for (const arg of args) {
    if (arg === '--yes') yes = true;
    else rest.push(arg);
  }
  const [clientId] = positional(rest, 'delete-client');
  if (!yes) {
    if (!process.stdin.isTTY) {
      fail('非交互环境删除需要显式 --yes（防误删）');
    }
    console.log(`将删除 client「${clientId}」的全部举报与限流行，操作不可恢复。`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('确认删除？输入 y 继续：')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('已取消。');
      return;
    }
  }
  const data = await api('DELETE', `/v1/admin/clients/${encodeURIComponent(clientId)}`);
  console.log(
    `已删除 client ${data.clientId}：reports=${data.reports ?? 0}，rate 行=${data.rateRows ?? 0}`,
  );
}

// ---------------------------------------------------------------- helpers

/** 取位置参数；不足则报用法退出。 */
function positional(args, command) {
  if (args.length < 1 || args.some((a) => a === '')) {
    fail(`${command} 缺少参数\n${USAGE}`);
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------- main

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'list':
    await list(args);
    break;
  case 'show':
    await show(args);
    break;
  case 'set':
    await set(args);
    break;
  case 'delete-client':
    await deleteClient(args);
    break;
  default:
    console.error(USAGE);
    process.exit(command === undefined || command === '' ? 2 : 2);
}
