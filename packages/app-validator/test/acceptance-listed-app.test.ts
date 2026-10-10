import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkManifest } from '../src/checks/manifest.js';
import { validate } from '../src/validate.js';
import type { FakeMcpTool } from '../../testkit/src/fake-oauth-mcp-server.js';
import { find, labels, startHarness, type Harness } from './support.js';

/**
 * todo/connected-apps.md 7.8 acceptance: `kepcup-app validate` passes for the server.json of an app
 * that is already listed in the Claude / ChatGPT directories (Linear's entry shape from our catalog,
 * plus the `_meta["app.kepcup/connector"]` block a publisher adds). The fake app stands in for the
 * remote: same tool names and a well-annotated tool surface.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/linear-listed.server.json', import.meta.url));

const obj = { type: 'object', properties: {} } as const;
const LINEAR_LIKE_TOOLS: FakeMcpTool[] = [
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List issues, optionally filtered by team, assignee or state.',
    annotations: { readOnlyHint: true },
    inputSchema: obj,
  },
  {
    name: 'get_issue',
    title: 'Get issue',
    description: 'Retrieve one issue by id or identifier.',
    annotations: { readOnlyHint: true },
    inputSchema: obj,
  },
  {
    name: 'list_projects',
    title: 'List projects',
    description: 'List projects in the workspace.',
    annotations: { readOnlyHint: true },
    inputSchema: obj,
  },
  {
    name: 'list_comments',
    title: 'List comments',
    description: 'List comments on an issue.',
    annotations: { readOnlyHint: true },
    inputSchema: obj,
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create a new issue.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: obj,
  },
  {
    name: 'update_issue',
    title: 'Update issue',
    description: 'Update fields of an existing issue.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: obj,
  },
  {
    name: 'create_comment',
    title: 'Create comment',
    description: 'Add a comment to an issue.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: obj,
  },
];

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe('acceptance: a listed third-party app validates', () => {
  it('the fixture manifest itself is a valid KepCup connector entry', async () => {
    const raw = JSON.parse(await readFile(FIXTURE, 'utf8')) as unknown;
    const result = checkManifest(raw);
    expect(result.entry?.name).toBe('app.linear/linear');
    expect(labels(result, 'error')).toEqual([]);
    expect(result.remote?.url).toBe('https://mcp.linear.app/mcp');
  });

  it('validate --auth passes end to end against a stand-in remote', async () => {
    harness = await startHarness({ tools: LINEAR_LIKE_TOOLS });
    const manifest = JSON.parse(await readFile(FIXTURE, 'utf8')) as Record<string, unknown>;
    manifest.remotes = [{ type: 'streamable-http', url: harness.fake.mcpUrl }];
    const meta = (manifest._meta as Record<string, Record<string, unknown>>)[
      'app.kepcup/connector'
    ] as Record<string, unknown>;
    meta.privacyPolicy = harness.privacyUrl;

    const report = await validate({
      target: await harness.writeFile(manifest),
      auth: true,
      clientIdUrl: harness.cimdUrl,
      openBrowser: harness.openBrowser,
      timeoutMs: 5000,
    });

    expect(labels(report, 'error')).toEqual([]);
    expect(report.exitCode).toBe(0);
    expect(find(report, 'auth.flow')?.severity).toBe('info');
    expect(find(report, 'tools.risk-summary')?.message).toContain(
      '4 read, 3 write and 0 destructive',
    );
    expect(labels(report, 'warn').filter((l) => l.startsWith('tool'))).toEqual([]);
  });
});
