import {
  APP_TOOL_NAME_MAX,
  appToolName,
  classifyRiskDetailed,
  nameLooksMutating,
  nameLooksReadOnly,
  normalizeToolName,
  toolDefinitionHash,
  type McpToolRisk,
  type ToolAnnotationsLike,
} from '@kepcup/shared';
import { scanText, schemaTexts, type ScanKind } from '../scan.js';
import { makeCheck, type Check } from '../types.js';

/**
 * (d) per-tool checks (design 29 §8.1 / §11.5 step 2). Pure: operates on a `tools/list` result.
 */

/** Structural subset of an MCP tool (pi-mcp's `Tool` is assignable). */
export interface ToolLike {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  annotations?: ToolAnnotationsLike | undefined;
  _meta?: Record<string, unknown> | undefined;
}

export interface ToolChecksOptions {
  /** Connector slug (from the manifest), for the `app_{slug}_` length check. */
  slug: string;
}

/** Longest name Claude / ChatGPT style tool schemas accept. */
export const TOOL_NAME_MAX = 64;
export const TOOL_DESCRIPTION_MAX = 2000;

const COMPOUND_SPLIT = /_(?:and|or|then)_/;
/** Third-person write verbs with a determiner after them (verb, not noun: "updates the page"). */
const DESCRIBED_WRITE =
  /\b(?:creates?|deletes?|removes?|updates?|sends?|overwrites?|modifies|modify|posts)\s+(?:a|an|the|new|existing|all|any|one|your|their|its|this|that|each|every)\b/i;

/** A name that names both a read and a write step (`search_and_delete`, `get_or_create`). */
export function nameLooksMixed(name: string): boolean {
  const parts = normalizeToolName(name).split(COMPOUND_SPLIT);
  if (parts.length < 2) return false;
  const reads = parts.some((part) => nameLooksReadOnly(part) && !nameLooksMutating(part));
  const writes = parts.some((part) => nameLooksMutating(part));
  return reads && writes;
}

function toolPrefixedName(slug: string, name: string): { raw: string; exposed: string } {
  return { raw: `app_${slug}_${name}`, exposed: appToolName(slug, name) };
}

export function checkTool(tool: ToolLike, options: ToolChecksOptions): Check[] {
  const checks: Check[] = [];
  const subject = tool.name;
  const annotations = tool.annotations;
  const mutatingName = nameLooksMutating(tool.name);

  // Names ------------------------------------------------------------------
  if (tool.name.length === 0) {
    checks.push(makeCheck('tool.name-length', 'error', 'Tool name is empty.', { subject }));
    return checks;
  }
  if (tool.name.length > TOOL_NAME_MAX) {
    checks.push(
      makeCheck(
        'tool.name-length',
        'error',
        `Tool name is ${tool.name.length} characters (max ${TOOL_NAME_MAX}).`,
        { subject, hint: `Shorten the name to ${TOOL_NAME_MAX} characters or fewer.` },
      ),
    );
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(tool.name)) {
    checks.push(
      makeCheck('tool.name-chars', 'error', 'Tool name has characters outside [A-Za-z0-9_.-].', {
        subject,
        hint: 'Model providers reject other characters; use letters, digits, "_" and "-".',
      }),
    );
  } else if (tool.name.includes('.')) {
    checks.push(
      makeCheck('tool.name-chars', 'warn', 'Tool name contains "."; KepCup replaces it with "_".', {
        subject,
        hint: 'Prefer [A-Za-z0-9_-] so the model sees exactly the name you chose.',
      }),
    );
  }
  const { raw, exposed } = toolPrefixedName(options.slug, tool.name);
  if (raw.length > APP_TOOL_NAME_MAX) {
    checks.push(
      makeCheck(
        'tool.name-prefixed',
        'warn',
        `app_${options.slug}_${tool.name} is ${raw.length} characters (limit ${APP_TOOL_NAME_MAX}); KepCup exposes it truncated with a hash suffix (${exposed}).`,
        {
          subject,
          hint: `Keep tool names at ${APP_TOOL_NAME_MAX - `app_${options.slug}_`.length} characters or fewer.`,
          details: { exposedName: exposed },
        },
      ),
    );
  }

  // Title / description / schema -------------------------------------------
  const title = tool.title ?? annotations?.title;
  if (title === undefined || title.trim().length === 0) {
    checks.push(
      makeCheck('tool.title', 'warn', 'Tool has no title.', {
        subject,
        hint: 'Set a human-readable title (the tool-level `title`, or `annotations.title`).',
      }),
    );
  }
  const description = tool.description ?? '';
  if (description.trim().length === 0) {
    checks.push(
      makeCheck('tool.description', 'warn', 'Tool has no description.', {
        subject,
        hint: 'Describe what the tool does and when to use it; models pick tools from this text.',
      }),
    );
  } else if (description.length > TOOL_DESCRIPTION_MAX) {
    checks.push(
      makeCheck(
        'tool.description',
        'warn',
        `Tool description is ${description.length} characters (over ${TOOL_DESCRIPTION_MAX}).`,
        {
          subject,
          hint: 'Long descriptions cost context on every turn; move detail into the input schema.',
        },
      ),
    );
  }
  const schema = tool.inputSchema;
  if (
    typeof schema !== 'object' ||
    schema === null ||
    Array.isArray(schema) ||
    (schema as { type?: unknown }).type !== 'object'
  ) {
    checks.push(
      makeCheck(
        'tool.input-schema',
        'error',
        'inputSchema is missing or is not a JSON Schema of type "object".',
        {
          subject,
          hint: 'Declare inputSchema: { "type": "object", "properties": { … } } (use an empty properties object for no arguments).',
        },
      ),
    );
  }

  // Risk annotations -------------------------------------------------------
  const readOnlyHint = annotations?.readOnlyHint;
  const destructiveHint = annotations?.destructiveHint;
  if (readOnlyHint === true && mutatingName) {
    checks.push(
      makeCheck(
        'tool.readonly-claim',
        'error',
        `readOnlyHint is true but the name "${tool.name}" says it writes; KepCup ignores the claim and treats the tool as destructive.`,
        {
          subject,
          hint: 'Set readOnlyHint:false (and destructiveHint) or rename the tool if it really is read-only.',
        },
      ),
    );
  } else if (mutatingName && readOnlyHint === undefined && destructiveHint === undefined) {
    checks.push(
      makeCheck(
        'tool.write-unannotated',
        'error',
        `"${tool.name}" looks like a write tool but declares no readOnlyHint / destructiveHint, so it defaults to destructive.`,
        {
          subject,
          hint: 'Declare readOnlyHint:false and destructiveHint:true|false explicitly (false = reversible write).',
        },
      ),
    );
  } else if (readOnlyHint === undefined && destructiveHint === undefined) {
    checks.push(
      makeCheck(
        'tool.annotations-missing',
        'warn',
        'Tool declares neither readOnlyHint nor destructiveHint.',
        {
          subject,
          hint: 'Add annotations: readOnlyHint:true for reads; readOnlyHint:false + destructiveHint for writes.',
        },
      ),
    );
  } else if (mutatingName && readOnlyHint === undefined) {
    checks.push(
      makeCheck(
        'tool.annotations-partial',
        'warn',
        'Write-looking tool sets destructiveHint but not readOnlyHint:false.',
        { subject, hint: 'Also set readOnlyHint:false so clients cannot mistake it for a read.' },
      ),
    );
  }
  if (annotations?.readOnlyHint === true && annotations.destructiveHint === true) {
    checks.push(
      makeCheck(
        'tool.hints-contradict',
        'warn',
        'readOnlyHint and destructiveHint are both true.',
        {
          subject,
          hint: 'A read-only tool cannot be destructive; drop destructiveHint.',
        },
      ),
    );
  }

  // Read / write split -----------------------------------------------------
  if (nameLooksMixed(tool.name)) {
    checks.push(
      makeCheck(
        'tool.mixed-read-write',
        'warn',
        `"${tool.name}" combines a read and a write step; it is treated as a write and cannot run unattended in read-only contexts.`,
        { subject, hint: 'Split it into separate read and write tools.' },
      ),
    );
  } else if (annotations?.readOnlyHint === true && DESCRIBED_WRITE.test(description)) {
    checks.push(
      makeCheck(
        'tool.mixed-read-write',
        'warn',
        'Description mentions writing although readOnlyHint is true.',
        { subject, hint: 'Either correct the description or the annotation; split mixed tools.' },
      ),
    );
  }

  // Injection scan ---------------------------------------------------------
  const texts: string[] = [tool.name, title ?? '', description, ...schemaTexts(schema)];
  const found = new Map<ScanKind, string>();
  for (const text of texts) {
    for (const finding of scanText(text)) {
      if (!found.has(finding.kind)) found.set(finding.kind, finding.excerpt);
    }
  }
  if (found.size > 0) {
    const kinds = [...found.keys()];
    checks.push(
      makeCheck(
        'tool.injection-pattern',
        'warn',
        `Tool text contains patterns reviewers flag: ${kinds.join(', ')}.`,
        {
          subject,
          hint: 'Describe the tool plainly: no instructions to the model, hidden characters, tag-like markup, outbound URLs or secrets handling.',
          details: { findings: kinds.map((kind) => ({ kind, excerpt: found.get(kind) })) },
        },
      ),
    );
  }
  return checks;
}

interface RiskRow {
  name: string;
  risk: McpToolRisk;
  source: string;
  hash: string;
}

export function checkTools(tools: readonly ToolLike[], options: ToolChecksOptions): Check[] {
  const checks: Check[] = [];
  if (tools.length === 0) {
    checks.push(
      makeCheck('tools.list', 'warn', 'The server lists no tools.', {
        hint: 'A connected app needs at least one tool.',
      }),
    );
    return checks;
  }
  checks.push(makeCheck('tools.list', 'info', `The server lists ${tools.length} tool(s).`));

  const seen = new Map<string, number>();
  const exposedSeen = new Map<string, string>();
  for (const tool of tools) {
    seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      checks.push(
        makeCheck(
          'tools.duplicate-name',
          'error',
          `Tool name "${name}" is listed ${count} times.`,
          {
            subject: name,
            hint: 'Tool names must be unique within a server.',
          },
        ),
      );
    }
  }

  const rows: RiskRow[] = [];
  for (const tool of tools) {
    checks.push(...checkTool(tool, options));
    const detail = classifyRiskDetailed({ name: tool.name, annotations: tool.annotations });
    rows.push({
      name: tool.name,
      risk: detail.risk,
      source: detail.source,
      hash: toolDefinitionHash({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      }).slice(0, 16),
    });
    const exposed = appToolName(options.slug, tool.name);
    const previous = exposedSeen.get(exposed);
    if (previous !== undefined && previous !== tool.name) {
      checks.push(
        makeCheck(
          'tool.name-collision',
          'warn',
          `"${tool.name}" and "${previous}" map to the same exposed name ${exposed}; KepCup disambiguates with a hash suffix.`,
          {
            subject: tool.name,
            hint: 'Use distinct names that differ in [A-Za-z0-9_-] characters.',
          },
        ),
      );
    } else {
      exposedSeen.set(exposed, tool.name);
    }
  }

  const count = (risk: McpToolRisk): number => rows.filter((row) => row.risk === risk).length;
  checks.push(
    makeCheck(
      'tools.risk-summary',
      'info',
      `KepCup classifies ${count('read')} read, ${count('write')} write and ${count('destructive')} destructive tool(s).`,
      { details: { tools: rows } },
    ),
  );
  const reads = count('read');
  if (tools.length >= 2 && reads === tools.length) {
    checks.push(
      makeCheck(
        'tools.split',
        'info',
        'All tools are read-only: the app can be used in read-only contexts.',
      ),
    );
  } else if (tools.length >= 2 && reads === 0) {
    checks.push(
      makeCheck(
        'tools.split',
        'info',
        'No tool is classified as read-only; every call needs approval.',
        {
          hint: 'If you have read tools, annotate them readOnlyHint:true so users can allow them without prompts.',
        },
      ),
    );
  } else {
    checks.push(makeCheck('tools.split', 'info', 'The server separates read and write tools.'));
  }
  return checks;
}
