import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_META_KEY,
  CONNECTOR_SLUG_PATTERN,
  connectorCatalogEntrySchema,
  connectorMetaOf,
  mcpToolRiskSchema,
  type ConnectorCatalogEntry,
} from '@kepcup/shared';

/**
 * 连接应用目录契约（todo/connected-apps.md §5.2，D73）：目录里的每个条目——
 * 内置的、第三方提交的（P3）、测试注入的——都要满足同一组约束。入口是
 * `test/unit/connector-catalog.test.ts`（vitest 只收 `*.test.ts`）。
 */
export interface ConnectorCatalogContractTarget {
  /** 显示名（describe 标题）。 */
  label: string;
  /** `catalog.json` 的 `connectors` 原始数组（未经 schema）。 */
  entries: readonly unknown[];
  /** 图标目录。 */
  iconsDir: string;
}

export function runConnectorCatalogContract(target: ConnectorCatalogContractTarget): void {
  describe(`connector catalog contract: ${target.label}`, () => {
    it('is non-empty', () => {
      expect(target.entries.length).toBeGreaterThan(0);
    });

    it('every entry is schema-valid', () => {
      for (const raw of target.entries) {
        const result = connectorCatalogEntrySchema.safeParse(raw);
        const name = (raw as { name?: string }).name ?? '<unnamed>';
        expect(
          result.success,
          `${name}: ${result.success ? '' : JSON.stringify(result.error.issues)}`,
        ).toBe(true);
      }
    });

    const parsed = (): ConnectorCatalogEntry[] =>
      target.entries.map((raw) => connectorCatalogEntrySchema.parse(raw));

    it('slugs are unique and match [a-z0-9]{2,16}', () => {
      const slugs = parsed().map((entry) => connectorMetaOf(entry).slug);
      for (const slug of slugs) expect(slug).toMatch(CONNECTOR_SLUG_PATTERN);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('registry names are unique', () => {
      const names = parsed().map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('icon files exist, are bare filenames and (svg) carry no script', () => {
      for (const entry of parsed()) {
        const meta = connectorMetaOf(entry);
        expect(path.basename(meta.icon), `${meta.slug} icon`).toBe(meta.icon);
        const file = path.join(target.iconsDir, meta.icon);
        expect(existsSync(file), `${meta.slug}: missing icon ${meta.icon}`).toBe(true);
        if (meta.icon.endsWith('.svg')) {
          const svg = readFileSync(file, 'utf8');
          expect(svg, `${meta.slug} icon is not svg`).toMatch(/<svg[\s>]/);
          expect(svg, `${meta.slug} icon contains script/handlers`).not.toMatch(
            /<script|\son[a-z]+\s*=|javascript:|<foreignObject/i,
          );
        }
      }
    });

    it('remotes[0].url is https (and P1 entries connect over streamable-http)', () => {
      for (const entry of parsed()) {
        const slug = connectorMetaOf(entry).slug;
        const first = entry.remotes[0];
        // MCPB-only entries (P2) have no remote yet.
        if (first === undefined) continue;
        expect(first.url, `${slug}: remotes[0].url`).toMatch(/^https:\/\//);
        expect(first.type, `${slug}: remotes[0].type`).toBe('streamable-http');
      }
    });

    it('toolPolicy risk values are valid', () => {
      for (const entry of parsed()) {
        const meta = connectorMetaOf(entry);
        for (const [tool, policy] of Object.entries(meta.toolPolicy)) {
          expect(mcpToolRiskSchema.safeParse(policy.risk).success, `${meta.slug}.${tool}`).toBe(
            true,
          );
        }
      }
    });

    it('carries a releaseGate (fail-closed), never the test-only "testkit" gate', () => {
      for (const raw of target.entries) {
        const gate = (raw as { _meta?: Record<string, { releaseGate?: unknown }> })._meta?.[
          CONNECTOR_META_KEY
        ]?.releaseGate;
        expect(
          typeof gate === 'string' && gate.length > 0,
          `${(raw as { name?: string }).name}`,
        ).toBe(true);
        expect(gate).not.toBe('testkit');
      }
    });

    it('preregistered auth names its client, auto auth does not need one', () => {
      for (const entry of parsed()) {
        const { auth, slug } = connectorMetaOf(entry);
        if (auth.registration === 'preregistered') expect(auth.clientRef, slug).not.toBeNull();
      }
    });
  });
}
