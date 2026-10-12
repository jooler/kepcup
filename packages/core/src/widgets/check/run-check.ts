import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WIDGET_CRAFT_AUX_FILE_MAX_BYTES,
  widgetAcceptanceSchema,
  widgetFixturesSchema,
  widgetQueryDefSchema,
  type WidgetAcceptance,
  type WidgetAcceptanceResult,
  type WidgetCheckIssue,
  type WidgetCheckReport,
  type WidgetDraftFile,
  type WidgetFixtures,
  type WidgetQueryDef,
} from '@kepcup/shared';
import { queriesSha256Of } from '../service.js';
import { jsCheck } from './js-check.js';
import { buildCheckReport } from './report.js';
import { ruleIssue } from './rules.js';
import { staticCheck } from './static-check.js';

/** S2 预览的结构化结果（P3b 的桌面预览宿主产出）。 */
export interface WidgetPreviewOutcome {
  issues: WidgetCheckIssue[];
  acceptance: WidgetAcceptanceResult[];
  outline: string;
}

/** P3b fills this in (desktop preview host); P3a passes null. */
export interface WidgetPreviewRunner {
  run(input: {
    html: string;
    queries: WidgetQueryDef[];
    acceptance: WidgetAcceptance | null;
    fixtures: WidgetFixtures;
    signal?: AbortSignal;
  }): Promise<WidgetPreviewOutcome | { skipped: string }>;
}

/** 预览宿主未绑定（测试装配、无界面）时 S2 的跳过原因；交付判定据此记 `unverified`。 */
export const WIDGET_PREVIEW_UNAVAILABLE_REASON = '预览宿主不可用（未经运行验证）';
/** 检查器自身异常时 skipped 原因的前缀（调用方据此区分「检查器坏了」与「草稿缺文件」）。 */
export const WIDGET_CHECKER_INTERNAL_ERROR_PREFIX = '检查器内部错误：';

type ReadResult =
  { kind: 'absent' } | { kind: 'text'; text: string } | { kind: 'error'; message: string };

async function readDraftFile(draftDir: string, file: WidgetDraftFile): Promise<ReadResult> {
  try {
    const text = await readFile(path.join(draftDir, file), 'utf8');
    return { kind: 'text', text };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', message: `${file} 读取失败：${code ?? String(error)}` };
  }
}

/** 读一个可选的 JSON 附属文件：缺省 → absent；读不了 / 过大 / 不是 JSON → 报错文本。 */
async function readJsonFile(
  draftDir: string,
  file: WidgetDraftFile,
): Promise<
  { kind: 'absent' } | { kind: 'json'; value: unknown } | { kind: 'error'; message: string }
> {
  const read = await readDraftFile(draftDir, file);
  if (read.kind !== 'text') return read;
  if (Buffer.byteLength(read.text) > WIDGET_CRAFT_AUX_FILE_MAX_BYTES) {
    return {
      kind: 'error',
      message: `${file} 过大（上限 ${WIDGET_CRAFT_AUX_FILE_MAX_BYTES} 字节）`,
    };
  }
  try {
    return { kind: 'json', value: JSON.parse(read.text) as unknown };
  } catch (error) {
    return { kind: 'error', message: `${file} 不是合法的 JSON：${(error as Error).message}` };
  }
}

/** zod 报错摘要（前 3 条，带路径），给模型改 JSON 用。 */
function zodSummary(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  const parts = error.issues.slice(0, 3).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '（根）';
    return `${where}：${issue.message}`;
  });
  const more = error.issues.length > 3 ? `（另有 ${error.issues.length - 3} 处）` : '';
  return parts.join('；') + more;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 对一个草稿目录跑一次完整检查（GATE 与模型自查 `widget_check` 共用，设计 32 §11.8）：
 * 读 index.html / queries.json / acceptance.json / fixtures.json → S0 → S1 → S2（有预览宿主时）
 * → 报告。坏草稿从不抛错，一切都变成问题条目；检查器自身的异常把该阶段记为 skipped 并写明原因
 * （不吞成「通过」：调用方看到 S0 / S1 skipped 不应判为合格）。
 *
 * - `htmlSha256` 是 index.html 原文的 sha256（与 `WidgetService` 落库时同算法）；缺文件为空串。
 * - `queriesSha256` 用 `queriesSha256Of` 对**通过校验**的模板算（规范化成 `{name, sql}`，与交付侧
 *   一致）；没有模板或模板不合格为空串。
 * - queries.json 缺省 = 没有声明任何查询（此时代码里的 `kepcup.query('x')` 报 query.unknown-name）；
 *   queries.json 不合格只报 query.invalid，不再逐个报名字。
 */
export async function runWidgetCheck(input: {
  draftDir: string;
  validateQueries: (defs: WidgetQueryDef[]) => string | null;
  preview?: WidgetPreviewRunner | null;
  now: number;
  signal?: AbortSignal;
}): Promise<WidgetCheckReport> {
  const { draftDir } = input;
  const issues: WidgetCheckIssue[] = [];
  const stages: WidgetCheckReport['stages'] = {
    S0: { status: 'ran', reason: '' },
    S1: { status: 'ran', reason: '' },
    S2: { status: 'skipped', reason: WIDGET_PREVIEW_UNAVAILABLE_REASON },
  };

  // --- index.html
  const htmlRead = await readDraftFile(draftDir, 'index.html');
  const html = htmlRead.kind === 'text' ? htmlRead.text : '';
  const htmlPresent = html.trim() !== '';
  if (!htmlPresent) {
    issues.push(
      ruleIssue('html.missing', {
        message:
          htmlRead.kind === 'error'
            ? htmlRead.message
            : htmlRead.kind === 'absent'
              ? '草稿目录里没有 index.html'
              : 'index.html 是空的',
      }),
    );
  }

  // --- queries.json
  let queries: WidgetQueryDef[] = [];
  let queryNames: string[] | null = [];
  const queriesJson = await readJsonFile(draftDir, 'queries.json');
  if (queriesJson.kind === 'error') {
    issues.push(ruleIssue('query.invalid', { file: 'queries.json', message: queriesJson.message }));
    queryNames = null;
  } else if (queriesJson.kind === 'json') {
    const denied = input.validateQueries(queriesJson.value as WidgetQueryDef[]);
    // 校验已通过：按 schema 规范化成 {name, sql}（去掉多余字段，摘要与交付侧一致）。交付侧校验
    // 本就保证这一步成立；这里再兜一次底，注入的校验函数宽松时也不抛错。
    const parsed = widgetQueryDefSchema.array().safeParse(queriesJson.value);
    if (denied !== null || !parsed.success) {
      issues.push(
        ruleIssue('query.invalid', {
          file: 'queries.json',
          message: denied ?? `queries.json 不合格：${zodSummary(parsed.error ?? { issues: [] })}`,
        }),
      );
      queryNames = null;
    } else {
      queries = parsed.data;
      queryNames = queries.map((def) => def.name);
    }
  }

  // --- acceptance.json（缺省 = 只跑乱点冒烟）
  let acceptance: WidgetAcceptance | null = null;
  const acceptanceJson = await readJsonFile(draftDir, 'acceptance.json');
  if (acceptanceJson.kind === 'error') {
    issues.push(
      ruleIssue('acceptance.invalid', { file: 'acceptance.json', message: acceptanceJson.message }),
    );
  } else if (acceptanceJson.kind === 'json') {
    const parsed = widgetAcceptanceSchema.safeParse(acceptanceJson.value);
    if (parsed.success) acceptance = parsed.data;
    else {
      issues.push(
        ruleIssue('acceptance.invalid', {
          file: 'acceptance.json',
          message: `验收点格式不合格：${zodSummary(parsed.error)}`,
        }),
      );
    }
  }

  // --- fixtures.json（缺省 = 空数据）
  let fixtures: WidgetFixtures = { storage: {}, queries: {} };
  const fixturesJson = await readJsonFile(draftDir, 'fixtures.json');
  if (fixturesJson.kind === 'error') {
    issues.push(
      ruleIssue('fixtures.invalid', { file: 'fixtures.json', message: fixturesJson.message }),
    );
  } else if (fixturesJson.kind === 'json') {
    const parsed = widgetFixturesSchema.safeParse(fixturesJson.value);
    if (parsed.success) fixtures = parsed.data;
    else {
      issues.push(
        ruleIssue('fixtures.invalid', {
          file: 'fixtures.json',
          message: `模拟数据格式不合格：${zodSummary(parsed.error)}`,
        }),
      );
    }
  }

  // --- S0 / S1
  if (htmlPresent) {
    try {
      issues.push(...staticCheck({ html, queryNames }));
    } catch (error) {
      stages.S0 = {
        status: 'skipped',
        reason: `${WIDGET_CHECKER_INTERNAL_ERROR_PREFIX}${(error as Error).message}`,
      };
    }
    try {
      issues.push(...jsCheck({ html }));
    } catch (error) {
      stages.S1 = {
        status: 'skipped',
        reason: `${WIDGET_CHECKER_INTERNAL_ERROR_PREFIX}${(error as Error).message}`,
      };
    }
  } else {
    stages.S1 = { status: 'skipped', reason: '缺少 index.html' };
  }

  // --- S2（P3b 接入预览宿主；S0 / S1 已有阻断项时是否还跑由宿主决定，这里有就调用）
  let previewAcceptance: WidgetAcceptanceResult[] = [];
  let outline = '';
  if (input.preview && htmlPresent) {
    try {
      const outcome = await input.preview.run({
        html,
        queries,
        acceptance,
        fixtures,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if ('skipped' in outcome) {
        stages.S2 = { status: 'skipped', reason: outcome.skipped };
      } else {
        stages.S2 = { status: 'ran', reason: '' };
        issues.push(...outcome.issues);
        previewAcceptance = outcome.acceptance;
        outline = outcome.outline;
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      stages.S2 = { status: 'skipped', reason: `预览失败：${(error as Error).message}` };
    }
  } else if (input.preview && !htmlPresent) {
    stages.S2 = { status: 'skipped', reason: '缺少 index.html' };
  }

  return buildCheckReport({
    issues,
    acceptance: previewAcceptance,
    outline,
    stages,
    htmlSha256: htmlRead.kind === 'text' ? sha256(htmlRead.text) : '',
    queriesSha256: queriesSha256Of(queries),
    now: input.now,
  });
}
