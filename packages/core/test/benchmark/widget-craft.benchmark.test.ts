import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WidgetPreviewRunInput, WidgetPreviewRunOutput } from '@kepcup/shared';
import {
  createTestCore,
  createTestHome,
  makeBot,
  openDirect,
  type CoreHarness,
} from '@kepcup/testkit';

/**
 * D87 P3c 效果基准（todo/bot-widgets-authoring.md §5.4）：用一个真实模型把 10 条需求各跑两组——
 * 基线 = 只 SPEC + BUILD 后直接 GATE 计分（0 修复 / 0 审查）；完整流程 = widget_craft。记录最终
 * 状态、是否交付（= 无阻断项）、轮数、token、耗时，写成 JSON。
 *
 * 默认跳过（需要真实模型与费用）。手动触发（Docker 里，S2 需要显示服务）：
 *
 *   KEPCUP_BENCH_MODEL=deepseek/deepseek-chat KEPCUP_BENCH_API_KEY=… \
 *   [KEPCUP_BENCH_PROVIDER=deepseek] [KEPCUP_BENCH_REVIEW_MODEL=provider/model] \
 *   [KEPCUP_BENCH_PREVIEW=1] [KEPCUP_BENCH_ONLY=split-bill,poll] [KEPCUP_BENCH_OUT=.bench/result.json] \
 *   xvfb-run -a node scripts/run-tests.mjs run packages/core/test/benchmark
 *
 * KEPCUP_BENCH_PREVIEW=1 时起一个真实 Electron 预览服务（apps/desktop/scripts/widget-preview-server.mjs）
 * 绑定到 core 的预览句柄，GATE 带 S2；否则 S2 记 skipped（交付状态为 unverified）。
 */

const MODEL = process.env['KEPCUP_BENCH_MODEL'] ?? '';
const PROVIDER = process.env['KEPCUP_BENCH_PROVIDER'] ?? MODEL.split('/')[0] ?? '';
const API_KEY = process.env['KEPCUP_BENCH_API_KEY'] ?? '';
const REVIEW_MODEL = process.env['KEPCUP_BENCH_REVIEW_MODEL'] ?? '';
const WITH_PREVIEW = process.env['KEPCUP_BENCH_PREVIEW'] === '1';
const ONLY = (process.env['KEPCUP_BENCH_ONLY'] ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');
const OUT =
  process.env['KEPCUP_BENCH_OUT'] ??
  path.join(process.cwd(), '.bench', `widget-craft-${Date.now()}.json`);

interface Brief {
  id: string;
  title: string;
  brief: string;
  acceptance: string[];
}

const briefs = (
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../fixtures/widget-briefs/briefs.json', import.meta.url)),
      'utf8',
    ),
  ) as Brief[]
).filter((brief) => ONLY.length === 0 || ONLY.includes(brief.id));

interface Row {
  brief: string;
  mode: 'baseline' | 'full';
  /** 交付了（= 最佳版本没有阻断项，且落库成功）。 */
  delivered: boolean;
  /** 未交付时最佳版本的阻断项数（草稿里最佳快照的检查报告；交付的为 0，读不到为 -1）。 */
  blockers: number;
  status: string;
  gateRounds: number;
  fixRounds: number;
  reviewRounds: number;
  tokens: number;
  ms: number;
  receipt: string;
}

describe.skipIf(MODEL === '' || API_KEY === '')('widget craft benchmark (real model)', () => {
  let core: CoreHarness;
  let server: {
    run(input: WidgetPreviewRunInput): Promise<WidgetPreviewRunOutput>;
    close(): Promise<void>;
  } | null = null;
  const rows: Row[] = [];

  beforeAll(async () => {
    const home = await createTestHome();
    core = await createTestCore({ home: home.home });
    await core.rpc.call('providers.setKey', { provider: PROVIDER, key: API_KEY });
    await core.rpc.call('settings.update', {
      defaultMainModel: MODEL,
      ...(REVIEW_MODEL !== '' ? { widgetReviewModel: REVIEW_MODEL } : {}),
    });
    if (WITH_PREVIEW) {
      const { startWidgetPreviewServer } =
        (await import('../../../../apps/desktop/scripts/widget-preview-server.mjs')) as {
          startWidgetPreviewServer(): Promise<{
            run(input: WidgetPreviewRunInput): Promise<WidgetPreviewRunOutput>;
            close(): Promise<void>;
          }>;
        };
      server = await startWidgetPreviewServer();
      const bound = server;
      core.services.widgetPreviewRpc.bindFacade({ run: (input) => bound.run(input) });
    }
  }, 120_000);

  afterAll(async () => {
    mkdirSync(path.dirname(OUT), { recursive: true });
    const summary = (mode: Row['mode']) => {
      const of = rows.filter((row) => row.mode === mode);
      return {
        runs: of.length,
        delivered: of.filter((row) => row.delivered).length,
        // 交付（机器检查无阻断）与「已通过自检」（还要求审查过且无剩余 P0 / P1、运行验证过）分开统计：
        // 基线不审查，它的 passed 恒为 0，比较时看 delivered。
        passed: of.filter((row) => row.status === 'passed').length,
        blockers: of.reduce((sum, row) => sum + Math.max(0, row.blockers), 0),
        tokens: of.reduce((sum, row) => sum + row.tokens, 0),
        ms: of.reduce((sum, row) => sum + row.ms, 0),
      };
    };
    writeFileSync(
      OUT,
      `${JSON.stringify(
        {
          model: MODEL,
          reviewModel: REVIEW_MODEL || MODEL,
          preview: WITH_PREVIEW,
          at: new Date().toISOString(),
          baseline: summary('baseline'),
          full: summary('full'),
          rows,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`widget craft benchmark written to ${OUT}`);
    await server?.close();
    await core?.close();
  });

  for (const brief of briefs) {
    for (const mode of ['baseline', 'full'] as const) {
      it(`${brief.id} · ${mode}`, async () => {
        const domain = core.services.domain!;
        const bot = await makeBot(core, `基准 ${brief.id} ${mode}`);
        const conv = await openDirect(core, bot.id);
        const runId = `bench_${brief.id}_${mode}_${Date.now()}`;
        const started = Date.now();
        const result = await core.services.widgetCraft!.craft({
          identity: { runId, botId: bot.id, conversationId: conv.id, loopType: 'task' },
          params: { brief: brief.brief, title: brief.title, acceptance: brief.acceptance },
          signal: new AbortController().signal,
          progress: () => undefined,
          ...(mode === 'baseline' ? { limits: { fixRounds: 0, reviewRounds: 0 } } : {}),
        });
        const ms = Date.now() - started;
        const stageRuns = domain.runs
          .listByConversation(conv.id, 200)
          .filter((run) => run.parentRunId === runId);
        const tokens = Number(
          (
            core.services
              .mainDb!.prepare(
                `select coalesce(sum(input_tokens + output_tokens), 0) as n from usage_ledger where run_id in (${
                  stageRuns.map(() => '?').join(',') || "''"
                })`,
              )
              .get(...stageRuns.map((run) => run.id)) as { n: number | bigint }
          ).n,
        );
        const card = core.services
          .mainDb!.prepare(
            `select v.check_status as status, v.check_summary_json as summary
               from widgets w join widget_versions v on v.widget_id = w.id and v.version = w.latest_version
               where w.bot_id = ?`,
          )
          .get(bot.id) as { status: string; summary: string } | undefined;
        const summary =
          card !== undefined
            ? (JSON.parse(card.summary) as { gateRounds: number; reviewRounds: number })
            : null;
        const rounds = /检查 (\d+) 轮、修复 (\d+) 轮、审查 (\d+) 轮/.exec(result.content);
        // 未交付：从保留的草稿里读最佳快照的检查报告数阻断项。
        let blockers = 0;
        const craftId = /craftId: (wcf_[A-Za-z0-9_-]+)/.exec(result.content)?.[1];
        if (!result.ok && craftId !== undefined) {
          try {
            const dir = path.join(
              core.services.paths.home,
              'bots',
              bot.id,
              'widget-drafts',
              craftId,
            );
            const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
              best: { round: number } | null;
            };
            if (manifest.best !== null) {
              const report = JSON.parse(
                readFileSync(
                  path.join(dir, 'reports', `check-${manifest.best.round}.json`),
                  'utf8',
                ),
              ) as { blockers: number };
              blockers = report.blockers;
            }
          } catch {
            blockers = -1;
          }
        }
        rows.push({
          brief: brief.id,
          mode,
          delivered: result.ok,
          blockers,
          status: card?.status ?? 'not-delivered',
          gateRounds: summary?.gateRounds ?? Number(rounds?.[1] ?? 0),
          fixRounds: Number(rounds?.[2] ?? 0),
          reviewRounds: summary?.reviewRounds ?? Number(rounds?.[3] ?? 0),
          tokens,
          ms,
          receipt: result.content.slice(0, 600),
        });
        // 基准只记录，不断言成败（结论看汇总）；只确认跑完了。
        expect(typeof result.content).toBe('string');
      }, 1_200_000);
    }
  }
});
