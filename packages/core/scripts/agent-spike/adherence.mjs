#!/usr/bin/env node
// P6 原生优先遵守度回归（todo/acp-external-agents.md §9.1，设计 28 §4.2 / §9.2）。
//
// 对每个 Agent 跑 spike 的 `adherence` step（产品真实措辞，见
// fixtures/native-first-wording.json），汇总成可直接贴进设计 28 §9.2 的 Markdown
// 表。真机需先按 README「需要用户登录后再跑的步骤」登录（同一 --work-dir /
// 默认 $TMPDIR/kepcup-spike/<agent>，登录态在其 home/ 里）；本脚本不做任何登录。
//
//   node adherence.mjs [--agents claude,codex,opencode,dsh,cursor,antigravity]
//                      [--runs 10] [--out-dir ./adherence-<时间>] [--work-root <dir>]
//                      [-- <透传给 spike.mjs 的参数，如 --pass-env DEEPSEEK_API_KEY>]
//
// 自测（假 Agent，无需登录）：node adherence.mjs --agents fake --runs 2
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AGENTS = ['claude', 'codex', 'opencode', 'dsh', 'cursor', 'antigravity'];
const TARGET = 0.9;

function parse() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agents: { type: 'string' },
      runs: { type: 'string' },
      'out-dir': { type: 'string' },
      'work-root': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]);
    process.exit(0);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    agents: (values.agents ?? DEFAULT_AGENTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    runs: values.runs ?? '10',
    outDir: path.resolve(values['out-dir'] ?? `adherence-${stamp}`),
    workRoot: values['work-root'],
    passthrough: positionals,
  };
}

/** One row per (agent, case) for design 28 §9.2. */
export function summaryRows(agentId, report) {
  const step = report?.steps?.adherence;
  if (!step || step.status !== 'ok') {
    const reason = step?.error?.message ?? report?.prepareError?.message ?? step?.reason ?? '未运行';
    return [`| ${agentId} | — | — | — | 失败：${String(reason).replace(/\|/g, '/').slice(0, 120)} |`];
  }
  return Object.entries(step.data.cases).map(([caseId, c]) => {
    if (c.skipped) return `| ${agentId} | ${caseId} | — | — | 跳过：${c.skipped} |`;
    const counts = `${c.native} / ${c.injected} / ${c.both} / ${c.none} / ${c.error}`;
    const ratio = `${c.native}/${c.runs}（${c.nativeFirstRatio.toFixed(2)}）`;
    return `| ${agentId} | ${caseId} | ${counts} | ${ratio} | ${c.nativeFirstRatio >= TARGET ? '达标' : '**未达标**'} |`;
  });
}

function main() {
  const { agents, runs, outDir, workRoot, passthrough } = parse();
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const agentId of agents) {
    const out = path.join(outDir, `adherence-${agentId}.json`);
    const args = [
      path.join(here, 'spike.mjs'),
      '--agent', agentId,
      '--steps', 'initialize,adherence',
      '--runs', runs,
      '--out', out,
      ...(workRoot ? ['--work-dir', path.join(workRoot, agentId)] : []),
      ...passthrough,
    ];
    console.error(`[adherence] ${agentId} ...`);
    spawnSync(process.execPath, args, { stdio: 'inherit' });
    let report = null;
    try {
      report = JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {
      // spike 没写出报告（启动失败）：表里记失败。
    }
    rows.push(...summaryRows(agentId, report));
  }
  const date = new Date().toISOString().slice(0, 10);
  const table = [
    `原生优先遵守度（${date}，${runs} 次 / 用例；目标 ≥ ${TARGET}；措辞 = fixtures/native-first-wording.json）`,
    '',
    '| Agent | 用例 | 原生 / 注入 / 都用 / 都不用 / 出错 | 原生比例 | 结论 |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '未达标的 Agent：在其 Provider 里加强点名措辞，或把对应补位包的默认值改为不注入（todo §9.1）；分类是启发式，请人工复核各报告的 results[].allTools。',
    '',
  ].join('\n');
  const summary = path.join(outDir, 'adherence-summary.md');
  fs.writeFileSync(summary, table);
  process.stdout.write(table);
  console.error(`[adherence] summary -> ${summary}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
