import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import {
  createEditToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  BOT_WIDGET_HTML_MAX_BYTES,
  isSafeMicroAppPath,
  MICRO_APP_FILE_MAX_BYTES,
  WIDGET_CRAFT_AUX_FILE_MAX_BYTES,
  buildMicroAppApiInspect,
  widgetReviewResultSchema,
  type WidgetReviewResult,
} from '@kepcup/shared';
import { canonicalPath } from '../../infra/paths.js';
import { isInsidePath } from '../../sandbox/sensitive-paths.js';
import type { ToolDefinition, ToolResult } from '../../agent/types.js';
import { WIDGET_TEMPLATES, widgetTemplate, type WidgetTemplate } from '../templates/index.js';
import {
  DRAFT_ACCEPTANCE,
  DRAFT_FIXTURES,
  DRAFT_HTML,
  DRAFT_MANIFEST,
  DRAFT_QUERIES,
  DRAFT_SPEC,
  DRAFT_APP_MANIFEST,
} from './draft.js';
import type { CraftStage } from './prompts.js';

/**
 * 制作 loop 各阶段的工具集（设计 32 §11.4）：全部限定在本次制作的草稿目录，没有 bash、没有
 * 网络、没有任何宿主副作用工具。守卫写法同 `skills/authoring-tools.ts`：
 *
 * - 路径必须解析在草稿目录内（符号链接按真实路径判定）；
 * - 只能写约定的交付文件，且按阶段收窄：SPEC 只写 spec.md / acceptance.json；BUILD / FIX
 *   只写 index.html / queries.json / fixtures.json（规格与验收点在 SPEC 之后只读——编码阶段
 *   不能靠删验收点「通过」）；`manifest.json` 与 reports / snapshots 永远只读；
 * - FIX 阶段的 `write` 只能新建文件，拒绝整份覆盖已存在的文件——逼出补丁式修复，防回归；
 * - 单文件体积上限（index.html 同组件上限，其余文件更小）。
 */

export interface CraftToolDeps {
  draftDir: string;
  stage: CraftStage;
  /** 提供 widget_template（BUILD 且新建组件时；修改已有组件不给——它会整份覆盖现有源码）。 */
  templates: boolean;
  /** 微应用草稿（D112 P3）：BUILD/FIX 可写 micro-app.json 与包内文件（assets/ 等）。 */
  microApp?: boolean;
  /** 自查：跑同一个检查器、返回同一格式的报告（不算交付）。 */
  selfCheck: (signal: AbortSignal) => Promise<ToolResult>;
  /** stage_done 被调用（附一句说明）。 */
  onStageDone: (summary: string) => void;
  /** REVIEW：submit_review 通过校验（无场景的条目已丢弃）。 */
  onSubmitReview?: (result: WidgetReviewResult) => void;
}

const WRITABLE: Readonly<Record<CraftStage, ReadonlySet<string>>> = {
  spec: new Set([DRAFT_SPEC, DRAFT_ACCEPTANCE]),
  build: new Set([DRAFT_HTML, DRAFT_QUERIES, DRAFT_FIXTURES]),
  fix: new Set([DRAFT_HTML, DRAFT_QUERIES, DRAFT_FIXTURES]),
  // 审查者只读，不改文件（设计 32 §11.10）。
  review: new Set(),
};

/** 宿主 / 阶段专属路径：微应用的包可写也不许碰（宿主记录与知识分层只读）。 */
const HOST_ONLY_DIRS = new Set(['reports', 'snapshots', 'references']);

const STAGE_LABEL: Readonly<Record<CraftStage, string>> = {
  spec: 'SPEC',
  build: 'BUILD',
  fix: 'FIX',
  review: 'REVIEW',
};

export const STAGE_DONE_TOOL = 'stage_done';
export const WIDGET_CHECK_TOOL = 'widget_check';
export const WIDGET_TEMPLATE_TOOL = 'widget_template';
export const SUBMIT_REVIEW_TOOL = 'submit_review';
export const MICRO_APP_SDK_INSPECT_TOOL = 'micro_app_sdk_inspect';

export function buildCraftTools(deps: CraftToolDeps): ToolDefinition[] {
  // 草稿目录由制作服务建好；这里不重建（Bot 删除后不能被写回来）。
  if (!existsSync(deps.draftDir)) throw new Error('widget draft directory is gone');
  const drafts = canonicalPath(deps.draftDir);
  const microApp = deps.microApp === true;
  const writable =
    microApp && (deps.stage === 'build' || deps.stage === 'fix')
      ? new Set([...WRITABLE[deps.stage], DRAFT_APP_MANIFEST])
      : WRITABLE[deps.stage];

  /** 微应用的包内文件（BUILD / FIX 专用）：安全的相对路径，宿主记录与知识分层除外。 */
  const bundleWritable = (rel: string): boolean =>
    microApp &&
    (deps.stage === 'build' || deps.stage === 'fix') &&
    rel !== DRAFT_SPEC &&
    rel !== DRAFT_ACCEPTANCE &&
    rel !== DRAFT_MANIFEST &&
    !HOST_ONLY_DIRS.has(rel.split('/')[0] ?? '') &&
    rel !== DRAFT_APP_MANIFEST &&
    isSafeMicroAppPath(rel);

  /** 解析在草稿目录内，否则拒绝。 */
  const inside = (target: string): string => {
    const resolved = canonicalPath(path.resolve(drafts, target));
    if (!isInsidePath(resolved, drafts)) {
      throw new Error(
        `PATH_OUT_OF_SCOPE: 只能访问本次制作的草稿目录 ${drafts}，拒绝访问 ${target}`,
      );
    }
    return resolved;
  };

  /** 写入守卫：约定文件 + 阶段白名单 + FIX 不覆盖 + 体积。 */
  const writableTarget = (
    target: string,
    content: string | null,
    mode: 'write' | 'edit',
  ): string => {
    const resolved = inside(target);
    const rel = path.relative(drafts, resolved);
    if (rel === DRAFT_MANIFEST) {
      throw new Error('WRITE_DENIED: manifest.json 由宿主维护，只读');
    }
    if (!writable.has(rel) && !bundleWritable(rel)) {
      const allowed = [...writable].join(' / ');
      throw new Error(
        `WRITE_DENIED: ${STAGE_LABEL[deps.stage]} 阶段只能写 ${allowed}${microApp ? '（微应用包文件也可以，安全相对路径）' : ''}，拒绝写 ${rel}`,
      );
    }
    if (deps.stage === 'fix' && mode === 'write' && existsSync(resolved)) {
      throw new Error(
        `WRITE_DENIED: FIX 阶段不能整份覆盖已存在的 ${rel}——用 edit 做最小改动（整份重写容易引入回归）`,
      );
    }
    if (content !== null) {
      const max =
        rel === DRAFT_HTML
          ? BOT_WIDGET_HTML_MAX_BYTES
          : bundleWritable(rel) && rel !== DRAFT_APP_MANIFEST
            ? MICRO_APP_FILE_MAX_BYTES
            : WIDGET_CRAFT_AUX_FILE_MAX_BYTES;
      if (Buffer.byteLength(content) > max) {
        throw new Error(`WRITE_DENIED: ${rel} 过大（上限 ${max} 字节）`);
      }
    }
    return resolved;
  };

  const read = createReadToolDefinition(drafts, {
    operations: {
      access: async (p) => {
        statSync(inside(p));
      },
      readFile: async (p) => readFileSync(inside(p)),
      detectImageMimeType: async () => null,
    },
  });

  const ls = createLsToolDefinition(drafts, {
    operations: {
      exists: async (p) => existsSync(inside(p)),
      stat: async (p) => {
        const stats = statSync(inside(p));
        return { isDirectory: () => stats.isDirectory() };
      },
      readdir: async (p) => readdirSync(inside(p)),
    },
  });

  const write = createWriteToolDefinition(drafts, {
    operations: {
      writeFile: async (p, content) => {
        writeFileSync(writableTarget(p, content, 'write'), content, 'utf-8');
      },
      mkdir: async (dir) => {
        const resolved = inside(dir);
        if (resolved === drafts) return; // 根目录本身（pi 写文件前会 mkdir）
        const rel = path.relative(drafts, resolved);
        if (microApp && (deps.stage === 'build' || deps.stage === 'fix') && isSafeMicroAppPath(`${rel}/x`)) {
          return; // 微应用包的子目录（assets/ 等）
        }
        throw new Error('WRITE_DENIED: 草稿目录里不需要这个子目录');
      },
    },
  });

  const edit = createEditToolDefinition(drafts, {
    operations: {
      readFile: async (p) => readFileSync(inside(p)),
      writeFile: async (p, content) => {
        writeFileSync(writableTarget(p, content, 'edit'), content, 'utf-8');
      },
      access: async (p) => {
        statSync(writableTarget(p, null, 'edit'));
      },
    },
  });

  const stageDone: ToolDefinition<{ summary?: string }> = {
    name: STAGE_DONE_TOOL,
    description: `声明 ${STAGE_LABEL[deps.stage]} 阶段已完成（附一句说明）。调用后本阶段结束，宿主接手后续检查。`,
    parameters: Type.Object({
      summary: Type.String({ description: '一句话说明本阶段做了什么' }),
    }),
    execute: async (params) => {
      deps.onStageDone(String(params.summary ?? '').slice(0, 300));
      return { ok: true, content: '已记录，本阶段结束。', terminate: true };
    },
  };

  const tools: ToolDefinition[] = [wrap(read), wrap(ls)];
  if (deps.stage === 'review') {
    tools.push(buildSubmitReviewTool(deps.onSubmitReview ?? (() => undefined)));
    return tools;
  }
  tools.push(wrap(write));
  if (microApp) {
    tools.push({
      name: MICRO_APP_SDK_INSPECT_TOOL,
      description:
        '查微应用 SDK 契约：传方法名（如 ai.chat / media.listen / context.update）拿签名、参数、限额与错误码（≤2KB）；不传或名字未知则列出全部可用方法。写代码前拿不准签名就查它。',
      parameters: Type.Object({
        method: Type.Optional(Type.String({ description: '桥方法名或能力名；省略则列出全部' })),
      }),
      execute: async (params) => ({
        ok: true,
        content: buildMicroAppApiInspect(String(params.method ?? '')),
      }),
    } satisfies ToolDefinition<{ method?: string }>);
  }
  if (deps.stage !== 'spec') {
    tools.push(wrap(edit));
    tools.push({
      name: WIDGET_CHECK_TOOL,
      description:
        '自查：对草稿目录当前的 index.html / queries.json 跑宿主的检查器（与交付前的检查同一套规则），返回按严重度排序的问题清单。只是自查，宿主在阶段结束后无论如何都会再检查一次。',
      parameters: Type.Object({}),
      execute: async (_params, ctx) => deps.selfCheck(ctx.signal),
    } satisfies ToolDefinition<Record<string, never>>);
  }
  if (deps.stage === 'build' && deps.templates) {
    tools.push(buildTemplateTool(drafts));
  }
  tools.push(stageDone as ToolDefinition);
  return tools;
}

/**
 * 审查结论（终止型，参数即 §11.10 的 schema）：zod 校验不过就把错误交回模型重交（不终止）；
 * 没有具体失败场景的条目丢弃（只靠「感觉不好」的意见不进修复）。
 */
function buildSubmitReviewTool(onSubmit: (result: WidgetReviewResult) => void): ToolDefinition {
  const finding = Type.Object({
    severity: Type.Union([Type.Literal('P0'), Type.Literal('P1'), Type.Literal('P2')], {
      description:
        'P0 = 主要功能不可用或数据会丢失 / 写错；P1 = 一条明确的使用路径出错；P2 = 体验问题',
    }),
    line: Type.Optional(
      Type.Integer({ minimum: 1, description: 'index.html 的行号（能定位时给）' }),
    ),
    problem: Type.String({
      minLength: 1,
      maxLength: 500,
      description: '给用户看的一句话现象（不引用代码）',
    }),
    scenario: Type.String({
      maxLength: 500,
      description: '具体失败场景：输入 / 操作 → 错误结果。给不出场景的不要提',
    }),
    fixHint: Type.Optional(Type.String({ maxLength: 500, description: '怎么改（一句话）' })),
  });
  const tool: ToolDefinition<{ verdict?: unknown; findings?: unknown }> = {
    name: SUBMIT_REVIEW_TOOL,
    description:
      '提交审查结论并结束审查：verdict 为 pass（没有 P0 / P1）或 fix（有 P0 / P1 要修），findings 列出问题（每条必须有具体失败场景）。',
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal('pass'), Type.Literal('fix')]),
      findings: Type.Array(finding, {
        maxItems: 20,
        description: '问题清单（至多 20 条）；没有问题给空数组',
      }),
    }),
    execute: async (params) => {
      const parsed = widgetReviewResultSchema.safeParse(params);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where =
          issue !== undefined && issue.path.length > 0 ? `${issue.path.join('.')}：` : '';
        return {
          ok: false,
          content: `审查结论不符合格式（${where}${issue?.message ?? '格式错误'}），请改正后重新调用 submit_review`,
          errorCode: 'INVALID_INPUT',
        };
      }
      const findings = parsed.data.findings.filter((item) => item.scenario.trim() !== '');
      const dropped = parsed.data.findings.length - findings.length;
      onSubmit({ verdict: parsed.data.verdict, findings });
      return {
        ok: true,
        content: `已记录审查结论（${findings.length} 条${dropped > 0 ? `，${dropped} 条没有失败场景已丢弃` : ''}）。`,
        terminate: true,
      };
    },
  };
  return tool as ToolDefinition;
}

/** 模板的包部分（清单 / 包文件 / fixtures；存量单文件模板为空）。 */
function templatePackageOf(
  template: WidgetTemplate,
): Array<{ path: string; content: string }> {
  const parts: Array<{ path: string; content: string }> = [];
  if (template.manifestJson !== undefined) parts.push({ path: 'micro-app.json', content: template.manifestJson });
  for (const file of template.files ?? []) parts.push(file);
  if (template.fixtures !== undefined) {
    parts.push({ path: DRAFT_FIXTURES, content: `${JSON.stringify(template.fixtures, null, 2)}\n` });
  }
  return parts;
}

function buildTemplateTool(drafts: string): ToolDefinition {
  const tool: ToolDefinition<{ name?: string }> = {
    name: WIDGET_TEMPLATE_TOOL,
    description:
      '骨架模板：不传 name 列出全部模板；传 name 把该模板写入 index.html（覆盖现有内容）。模板已满足全部沙箱规则，带错误处理范式，在它的基础上填业务。',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: '模板名；省略则列出全部模板' })),
    }),
    execute: async (params) => {
      const name = params.name?.trim() ?? '';
      if (name === '') {
        return {
          ok: true,
          content: WIDGET_TEMPLATES.map((t) => `- ${t.name}：${t.summary}`).join('\n'),
        };
      }
      const template = widgetTemplate(name);
      if (template === null) {
        return {
          ok: false,
          content: `没有模板「${name}」。可用：${WIDGET_TEMPLATES.map((t) => t.name).join(' / ')}`,
          errorCode: 'NOT_FOUND',
        };
      }
      writeFileSync(path.join(drafts, DRAFT_HTML), template.html, 'utf-8');
      const seeded: string[] = [];
      const queriesPath = path.join(drafts, DRAFT_QUERIES);
      if (template.queries !== undefined && !existsSync(queriesPath)) {
        writeFileSync(queriesPath, `${JSON.stringify(template.queries, null, 2)}\n`, 'utf-8');
        seeded.push('queries.json');
      }
      for (const part of templatePackageOf(template)) {
        const target = path.join(drafts, part.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, part.content, 'utf-8');
        seeded.push(part.path);
      }
      return {
        ok: true,
        content: `已把模板「${template.name}」写入 index.html（${template.html.split('\n').length} 行）${seeded.length > 0 ? `，并写入了 ${seeded.join('、')}（按需求改）` : ''}。先 read 它，再用 edit 填业务。`,
      };
    },
  };
  return tool as ToolDefinition;
}

/** pi 工具定义 → 本仓库 ToolDefinition：失败变成工具结果而不是抛出（同 skills/authoring-tools.ts）。 */
function wrap(def: {
  name: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    execute: async (params, ctx) => {
      try {
        const result = await def.execute('call', params, ctx.signal, undefined, { cwd: '' });
        const text = (result.content ?? [])
          .map((block) =>
            block.type === 'text' && typeof block.text === 'string' ? block.text : '',
          )
          .join('\n')
          .trim();
        return { ok: true, content: text.length > 0 ? text : '（完成）' };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = /^(PATH_OUT_OF_SCOPE|WRITE_DENIED)/.exec(message)?.[1] ?? 'TOOL_FAILED';
        return { ok: false, content: message, errorCode: code };
      }
    },
  };
}
