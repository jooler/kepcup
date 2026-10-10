import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startFakeOAuthMcpServer,
  type FakeMcpTool,
  type FakeOAuthMcpOptions,
  type FakeOAuthMcpServer,
  type SimulatedBrowserResult,
} from '../../testkit/src/fake-oauth-mcp-server.js';
import {
  publishCimdDocument,
  startFileServer,
  type TestFileServer,
} from '../../testkit/src/file-server.js';
import type { Check, ValidationReport } from '../src/types.js';

/** Test harness: a fake connected app (MCP + OAuth), a static file server and a manifest builder. */

export const PRIVACY_TEXT = `<html><body><h1>Privacy policy</h1><p>${'We respect your data and describe exactly what we collect. '.repeat(10)}</p></body></html>`;

export const GOOD_TOOLS: FakeMcpTool[] = [
  {
    name: 'search_issues',
    title: 'Search issues',
    description: 'Search issues by free text.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for.' } },
    },
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Create a new issue in a team.',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Issue title.' } },
      required: ['title'],
    },
  },
  {
    name: 'delete_issue',
    title: 'Delete issue',
    description: 'Permanently delete an issue.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Issue id.' } },
    },
  },
];

export interface Harness {
  fake: FakeOAuthMcpServer;
  files: TestFileServer;
  /** CIMD document URL standing in for KepCup's client identity. */
  cimdUrl: string;
  privacyUrl: string;
  /** A valid community manifest pointing at the fake server. */
  manifest(
    overrides?: Record<string, unknown>,
    metaOverrides?: Record<string, unknown>,
  ): Record<string, unknown>;
  /** Serve a manifest from the file server and return its URL. */
  serve(manifest: Record<string, unknown>): string;
  /** Write a manifest to a temp file and return its path. */
  writeFile(manifest: Record<string, unknown>): Promise<string>;
  /** `openBrowser` stand-in; results of the simulated browser are collected in `browsers`. */
  openBrowser: (url: string) => void;
  browsers: Promise<SimulatedBrowserResult>[];
  stop(): Promise<void>;
}

export async function startHarness(fakeOptions: FakeOAuthMcpOptions = {}): Promise<Harness> {
  const files = await startFileServer({});
  const { clientId } = publishCimdDocument(files);
  files.setFile('privacy', PRIVACY_TEXT, 'text/html');
  const fake = await startFakeOAuthMcpServer({
    cimdSupported: true,
    tools: GOOD_TOOLS,
    ...fakeOptions,
  });
  const dir = await mkdtemp(join(tmpdir(), 'kepcup-app-validator-'));
  let counter = 0;
  const browsers: Promise<SimulatedBrowserResult>[] = [];
  return {
    fake,
    files,
    cimdUrl: clientId,
    privacyUrl: `${files.url}/privacy`,
    manifest(overrides = {}, metaOverrides = {}) {
      return {
        name: 'com.example/acme',
        title: 'Acme',
        description: 'Acme issue tracker',
        version: '1.0.0',
        websiteUrl: 'https://acme.example',
        remotes: [{ type: 'streamable-http', url: fake.mcpUrl }],
        _meta: {
          'app.kepcup/connector': {
            slug: 'acme',
            icon: 'acme.svg',
            category: 'project',
            tier: 'community',
            auth: {
              kind: 'oauth',
              registration: 'auto',
              clientRef: null,
              scopes: { default: [], write: [] },
            },
            toolPolicy: {},
            skills: [],
            ui: false,
            privacyPolicy: `${files.url}/privacy`,
            ...metaOverrides,
          },
        },
        ...overrides,
      };
    },
    serve(manifest) {
      counter += 1;
      const key = `manifest-${counter}.json`;
      files.setFile(key, JSON.stringify(manifest), 'application/json');
      return `${files.url}/${key}`;
    },
    async writeFile(manifest) {
      counter += 1;
      const path = join(dir, `server-${counter}.json`);
      await writeFile(path, JSON.stringify(manifest));
      return path;
    },
    browsers,
    openBrowser(url) {
      browsers.push(fake.simulateBrowser(url));
    },
    async stop() {
      await fake.stop();
      await files.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** `id` or `id[subject]` of every check with that severity. */
export function labels(
  report: Pick<ValidationReport, 'checks'>,
  severity: Check['severity'],
): string[] {
  return report.checks
    .filter((check) => check.severity === severity)
    .map((check) => (check.subject !== undefined ? `${check.id}[${check.subject}]` : check.id));
}

export function find(
  report: Pick<ValidationReport, 'checks'>,
  id: string,
  subject?: string,
): Check | undefined {
  return report.checks.find(
    (check) => check.id === id && (subject === undefined || check.subject === subject),
  );
}
