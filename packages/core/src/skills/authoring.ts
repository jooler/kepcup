import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AppError, RUN_MAX_TURNS } from '@kepcup/shared';
import { botSkillDir, botSkillDraftDir, botSkillsRoot, type AppPaths } from '../infra/paths.js';
import type { AgentEngine, EngineEvent, RunHandle, EngineUsage } from '../agent/types.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { JobsService, JobRow } from '../domain/jobs.js';
import type { RunsService } from '../domain/runs.js';
import type { SecretsService } from '../domain/secrets.js';
import type { SettingsService } from '../domain/settings.js';
import type { UsageService } from '../domain/usage.js';
import type { CoreLogger } from '../infra/logger.js';
import type { SandboxBackend } from '../sandbox/types.js';
import { buildSandboxPolicy } from '../sandbox/policy.js';
import { executionStepsSummary } from '../memory/reflection.js';
import { buildAuthoringTools } from './authoring-tools.js';
import { parseSkillDir, sanitizeSkillName } from './parse.js';
import { shQuote } from '../infra/shell.js';
import { redactStepPayload } from '../infra/redact.js';
import type { SkillsService } from './registry.js';

export interface AuthoringJobDeps {
  engine: AgentEngine;
  sandbox: SandboxBackend;
  paths: AppPaths;
  settings: SettingsService;
  bots: BotsService;
  conversations: ConversationsService;
  /** Core event bus. */
  publish: (event: string, payload: unknown) => void;
  jobs: JobsService;
  runs: RunsService;
  /** Secret redaction for persisted run steps (BR-P09-001). */
  secrets: SecretsService;
  usage: UsageService;
  skills: SkillsService;
  logger: CoreLogger;
  job: JobRow;
}

/**
 * Skill generation loop (docs/dev/phases/P08-skills.md 任务 6). Consumes both
 * task sources — `skill_suggestion` jobs (reflection already checked the
 * SKILL_AUTHOR_REPEAT_THRESHOLD condition against the execution summaries)
 * and `create_skill` registrations — runs a main-model loop over the draft
 * directory, validates the result (frontmatter + syntax + sandbox tests),
 * and promotes on success; keeps the draft with the recorded reason on
 * failure. 自创技能是 Bot 自己积累的经验：成败都不向对话播报（消息原则，
 * design/01-conversation.md），技能面板由 skills.changed 驱动。
 */
export async function runSkillAuthoringJob(deps: AuthoringJobDeps): Promise<void> {
  const { job } = deps;
  if (job.bot_id === null) {
    throw new AppError('INVALID_INPUT', 'skill authoring requires a bot');
  }
  const bot = deps.bots.get(job.bot_id);
  if (bot === null || bot.status !== 'active') return; // deleted mid-queue
  // D72 P4：没有内置模型（只用外部 Agent）时跳过，不产生失败 run。
  if ((bot.profile.runtime.model || deps.settings.get().defaultMainModel).length === 0) {
    deps.logger.info({ botId: job.bot_id }, 'skill authoring skipped: no built-in model');
    return;
  }

  const payload = JSON.parse(job.payload_json) as {
    name?: string;
    description?: string;
    reason?: string;
    responseRunId?: string;
  };
  const name = sanitizeSkillName(payload.name ?? '');
  if (name === null) {
    deps.logger.warn({ botId: job.bot_id, raw: payload.name }, 'skill suggestion has no usable name');
    return;
  }
  // 导入的技能不可修改（design/05 修改规则）：同名导入技能存在时丢弃建议。
  if (deps.skills.isImported(job.bot_id, name)) {
    deps.logger.info(
      { botId: job.bot_id, skill: name },
      'skill suggestion shadows an imported skill; dropped',
    );
    return;
  }
  const description = (payload.description ?? '').slice(0, 1024);
  const reason = payload.reason ?? '';
  const responseRunId = payload.responseRunId ?? null;

  // The conversation may have been deleted between enqueue and now.
  const triggerConversationId =
    job.conversation_id !== null && deps.conversations.get(job.conversation_id) !== null
      ? job.conversation_id
      : null;

  const draftsDir = botSkillDraftDir(deps.paths, job.bot_id, name);
  rmSync(draftsDir, { recursive: true, force: true });
  mkdirSync(draftsDir, { recursive: true });

  const modelRef = mainModelRef(deps, job.bot_id);
  const run = deps.runs.create({
    botId: job.bot_id,
    conversationId: triggerConversationId,
    loopType: 'skill_authoring',
    triggerReason: 'background',
    triggerMessageIds: [],
  });
  deps.runs.update(run.id, { status: 'running', provider: providerOf(modelRef), model: modelRef });

  const existingSkillPath = botSkillDir(deps.paths, job.bot_id, name);
  const existingMarkdown =
    existsSync(path.join(existingSkillPath, 'SKILL.md'))
      ? readFileSync(path.join(existingSkillPath, 'SKILL.md'), 'utf8')
      : '';

  const tools = buildAuthoringTools({
    paths: deps.paths,
    sandbox: deps.sandbox,
    draftsDir,
  });
  const handle: RunHandle = deps.engine.startRun({
    identity: {
      runId: run.id,
      botId: job.bot_id,
      conversationId: triggerConversationId,
      loopType: 'skill_authoring',
    },
    model: modelRef,
    buildSystemPrompt: async () => AUTHORING_PROMPT,
    messages: [
      {
        role: 'user',
        timestamp: Date.now(),
        content: [
          `<task>把下面这件事整理成一个可复用的技能，写入草稿目录 ${draftsDir}。</task>`,
          `<suggestion><name>${name}</name><description>${escapeXml(description || reason)}</description><reason>${escapeXml(reason)}</reason></suggestion>`,
          existingMarkdown.length > 0
            ? `<existing_skill><untrusted>\n${existingMarkdown}\n</untrusted></existing_skill>\n这是该技能的当前版本；产出改进后的完整新版本（不要只给增量）。`
            : '',
          responseRunId !== null
            ? `<execution_steps><untrusted>\n${executionStepsSummary(deps.runs, responseRunId) || '（执行记录已清理）'}\n</untrusted></execution_steps>`
            : '',
          [
            '要求：',
            `- 技能目录名必须是 ${name}，SKILL.md 放在 ${draftsDir}/SKILL.md。`,
            '- frontmatter 只需 name 与 description（description 一句话说清何时使用，≤1024 字符）。',
            '- 正文是给模型看的使用说明；可以有 scripts/ 脚本（bash/python/node）与可选的 tests/ 目录。',
            `- 有 tests/ 目录时，在 frontmatter 写 test 字段（一条可在草稿目录运行的命令，例如 test: bash tests/run.sh），测试必须能通过。`,
            '- 脚本保持简单自包含，不访问网络；不要引用宿主专有工具（mcp__、Task 等）。',
            '写完所有文件后直接结束（不要额外解释）。',
          ].join('\n'),
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    tools,
    limits: { maxTurns: RUN_MAX_TURNS },
  });
  persistSteps(run.id, handle, deps.runs, deps.secrets);

  let outcome;
  try {
    outcome = await handle.done;
  } catch (error) {
    deps.runs.update(run.id, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  recordUsage(deps, run.id, job.bot_id, triggerConversationId, modelRef, outcome.usage);

  // Validation: frontmatter via pi, then syntax checks + sandbox tests.
  const verdict = await validateDraft({
    draftsDir,
    name,
    sandbox: deps.sandbox,
    paths: deps.paths,
    botId: job.bot_id,
  });
  if (verdict.ok) {
    // BR-P08-007: the bot may have been deleted while the model was
    // generating (deleteBot cancels queued jobs, but this job was already
    // running). Double-check before any write (P07 BR-P07-006 precedent):
    // discard the draft and remove the run row instead of resurrecting
    // bots/{id} data for a deleted bot.
    const owner = deps.bots.get(job.bot_id);
    if (owner === null || owner.status !== 'active') {
      if (owner === null) {
        // The generation tools may have re-created ancestors of the draft
        // directory after lifecycle removed bots/{id} — remove the whole
        // (already deleted) bot directory again.
        rmSync(botSkillsRoot(deps.paths, job.bot_id), { recursive: true, force: true });
      } else {
        rmSync(draftsDir, { recursive: true, force: true });
      }
      deps.runs.remove(run.id);
      deps.logger.info(
        { botId: job.bot_id, skill: name },
        'bot deleted during skill authoring; draft discarded, run row removed',
      );
      return;
    }
    await deps.skills.promoteAuthored({ botId: job.bot_id, name, draftDir: draftsDir });
    deps.skills.activateAuthored(job.bot_id, name);
    deps.runs.update(run.id, { status: 'completed' });
    // 技能是 Bot 自己积累的经验（消息原则，design/01-conversation.md）：自创
    // 完成不向对话播报——技能面板由 skills.changed 驱动，下次执行自然可用。
    deps.logger.info({ botId: job.bot_id, skill: name }, 'skill authored and activated');
    return;
  }

  // Failure: keep the draft + record the reason; the user is not disturbed.
  deps.skills.ensureDraftRow(job.bot_id, name, verdict.reason);
  deps.runs.update(run.id, { status: 'completed' });
  try {
    writeFileSync(path.join(draftsDir, 'validation-reason.txt'), verdict.reason, 'utf8');
  } catch {
    // draft dir best-effort annotation
  }
  deps.logger.info(
    { botId: job.bot_id, skill: name, reason: verdict.reason },
    'skill authoring validation failed; draft kept',
  );
}

export interface DraftVerdict {
  ok: boolean;
  reason: string;
}

/** frontmatter + syntax + sandbox test validation (任务 6 验证). */
export async function validateDraft(input: {
  draftsDir: string;
  name: string;
  sandbox: SandboxBackend;
  paths: AppPaths;
  botId: string;
}): Promise<DraftVerdict> {
  const parsed = parseSkillDir(input.draftsDir);
  if (parsed === null) {
    return { ok: false, reason: '草稿缺少可识别的 SKILL.md（frontmatter 需要 name 与 description）' };
  }
  if (parsed.name !== input.name) {
    return {
      ok: false,
      reason: `SKILL.md 的 name（${parsed.name}）与任务名（${input.name}）不一致`,
    };
  }
  if (parsed.description.trim().length === 0) {
    return { ok: false, reason: 'SKILL.md 缺少 description' };
  }

  const availability = await input.sandbox.probe();
  if (!availability.available) {
    return { ok: false, reason: `沙箱不可用（${availability.reason ?? '未知原因'}），无法安全验证草稿` };
  }

  const checks: Array<{ command: string; label: string }> = [];
  for (const file of listFilesRecursive(input.draftsDir)) {
    const rel = path.relative(input.draftsDir, file);
    if (rel.endsWith('.py')) {
      checks.push({ command: `python3 -m py_compile ${shQuote(rel)}`, label: `Python 语法检查：${rel}` });
    } else if (/\.(mjs|cjs|js)$/.test(rel)) {
      checks.push({ command: `node --check ${shQuote(rel)}`, label: `Node 语法检查：${rel}` });
    } else if (/\.(sh|bash)$/.test(rel)) {
      checks.push({ command: `bash -n ${shQuote(rel)}`, label: `shell 语法检查：${rel}` });
    }
  }
  for (const check of checks) {
    const result = await runInSandbox(input.sandbox, input.paths, input.draftsDir, check.command);
    if (!result.ok) {
      return {
        ok: false,
        reason: `${check.label} 未通过：${result.detail || '命令失败'}`,
      };
    }
  }

  const testsDir = path.join(input.draftsDir, 'tests');
  if (existsSync(testsDir)) {
    const testCommand = parsed.extras.test.trim();
    if (testCommand.length === 0) {
      return { ok: false, reason: '存在 tests/ 目录但 SKILL.md frontmatter 缺少 test 命令' };
    }
    const result = await runInSandbox(input.sandbox, input.paths, input.draftsDir, testCommand);
    if (!result.ok) {
      return { ok: false, reason: `技能测试未通过：${result.detail || '测试命令失败'}` };
    }
  }
  return { ok: true, reason: '' };
}

/**
 * POSIX single-quote shell quoting (BR-P08-008); canonical implementation in
 * infra/shell.ts (shared with the P09 wiki URL fetch). Re-exported for the
 * existing validate tests.
 */
export { shQuote };

async function runInSandbox(
  sandbox: SandboxBackend,
  paths: AppPaths,
  cwd: string,
  command: string,
): Promise<{ ok: boolean; detail: string }> {
  const result = await sandbox.exec({
    command,
    cwd,
    policy: buildSandboxPolicy({
      platform: process.platform,
      paths,
      workspacePath: cwd,
      network: { mode: 'none', allowDomains: [], allowLocalhost: false },
    }),
    timeoutMs: 120_000,
  });
  const detail = [result.stdout, result.stderr].filter((s) => s.length > 0).join('\n').trim();
  return { ok: result.exitCode === 0, detail: detail.slice(0, 500) };
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  return files;
}

function mainModelRef(deps: AuthoringJobDeps, botId: string): string {
  const bot = deps.bots.get(botId);
  const ref = bot?.profile.runtime.model || deps.settings.get().defaultMainModel;
  if (ref.length === 0) throw new AppError('PROVIDER_UNAVAILABLE', '未配置主模型');
  return ref;
}

function providerOf(modelRef: string): string {
  const index = modelRef.indexOf('/');
  return index > 0 ? modelRef.slice(0, index) : 'unknown';
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Persists engine events as redacted run steps (orchestrator pattern). */
function persistSteps(runId: string, handle: RunHandle, runs: RunsService, secrets: SecretsService): void {
  handle.onEvent((event) => {
    try {
      persistStep(runId, runs, secrets, event);
    } catch {
      // Step persistence must never break the engine loop (e.g. a run row
      // removed by a concurrent deletion cascade).
    }
  });
}

function persistStep(
  runId: string,
  runs: RunsService,
  secrets: SecretsService,
  event: EngineEvent,
): void {
  switch (event.type) {
    case 'assistant':
      runs.appendStep({ runId, type: 'assistant', payload: event.payload });
      return;
    case 'tool_call':
      // Same redaction order as the response loop (BR-P09-001): the
      // generation loop reads SKILL.md fixtures that may contain
      // credential-shaped strings — nothing reaches runs.db unredacted.
      runs.appendStep({
        runId,
        type: 'tool_call',
        payload: redactStepPayload((text) => secrets.redact(text), event.payload),
      });
      return;
    case 'tool_result':
      runs.appendStep({
        runId,
        type: 'tool_result',
        payload: {
          ...event.payload,
          content: secrets.redact(String(event.payload.content)),
        },
      });
      return;
    default:
      return;
  }
}

function recordUsage(
  deps: AuthoringJobDeps,
  runId: string,
  botId: string,
  conversationId: string | null,
  modelRef: string,
  usage: EngineUsage[],
): void {
  for (const entry of usage) {
    deps.usage.record({
      runId,
      botId,
      conversationId,
      loopType: 'skill_authoring',
      provider: providerOf(modelRef),
      model: modelRef.slice(providerOf(modelRef).length + 1),
      inputTokens: entry.input,
      outputTokens: entry.output,
      cacheReadTokens: entry.cacheRead,
      cacheWriteTokens: entry.cacheWrite,
      costUsd: entry.costUsd,
    });
  }
}

const AUTHORING_PROMPT = [
  'You are generating a reusable Agent Skill for a bot.',
  'Work inside the given draft directory only: write SKILL.md (frontmatter: name, description),',
  'optional scripts under scripts/, and optional tests under tests/ with a `test:` frontmatter command.',
  'Keep scripts self-contained, offline, and host-agnostic (no MCP tools, no subagents, no IDE commands).',
  'Finish silently when all files are written; validation runs automatically afterwards.',
].join(' ');
