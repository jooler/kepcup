import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPLEMENT_TOOL_DESCRIPTION_PREFIX } from '@kepcup/shared';
import { nativeFirstWordingFixture } from '../support/native-first-wording.js';

/**
 * D72 P6 原生优先遵守度回归：真机脚本（`scripts/agent-spike/adherence.mjs`）用的
 * 措辞 fixture 必须与产品当前措辞一致——措辞一改，这里就失败，提示重新生成
 * fixture 并重跑真机遵守度（结果记入设计 28 §9.2）。
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/agent-spike/fixtures/native-first-wording.json',
);

describe('native-first wording fixture (P6)', () => {
  it('matches the wording the product sends (KEPCUP_UPDATE_WORDING=1 regenerates)', () => {
    const expected = nativeFirstWordingFixture();
    if (process.env['KEPCUP_UPDATE_WORDING'] === '1' || !existsSync(FIXTURE)) {
      writeFileSync(FIXTURE, `${JSON.stringify(expected, null, 2)}\n`);
    }
    // Parsed comparison: the file may be prettier-formatted.
    expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(expected);
  });

  it('names the agent’s own native tools and prefixes every injected supplement tool', () => {
    const { agents, serverName } = nativeFirstWordingFixture();
    // Claude: WebSearch / WebFetch named, the injected ones only as fallback.
    expect(agents['claude']!.cases['web']!.policy).toContain(
      `用你自带的 WebSearch / WebFetch，不要用 mcp__${serverName}__web_search / mcp__${serverName}__web_fetch，除非它们不可用或失败。`,
    );
    // No declared native web tool (DeepSeek Harness): generic native-first line.
    expect(agents['dsh']!.cases['web']!.policy).toContain('若你自带同类能力，优先使用自带的');
    for (const wording of Object.values(agents)) {
      for (const testCase of Object.values(wording.cases)) {
        expect(testCase.policy).toContain('原生优先');
        for (const tool of testCase.tools) {
          expect(tool.description.startsWith(SUPPLEMENT_TOOL_DESCRIPTION_PREFIX)).toBe(true);
        }
      }
    }
  });

  it('the real-agent harness replays the fixture (spike fake agent, no login)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kepcup-adherence-'));
    try {
      const script = path.join(path.dirname(FIXTURE), '..', 'adherence.mjs');
      // Plain Node, not the Electron test runtime: the spike starts its fake
      // agent with process.execPath and a whitelisted env (no
      // ELECTRON_RUN_AS_NODE).
      const run = spawnSync(
        'node',
        [
          script,
          '--agents',
          'fake',
          '--runs',
          '2',
          '--out-dir',
          path.join(dir, 'out'),
          '--work-root',
          path.join(dir, 'work'),
        ],
        { encoding: 'utf8', timeout: 60_000, env: { ...process.env } },
      );
      expect(run.status, run.stderr).toBe(0);
      const report = JSON.parse(
        readFileSync(path.join(dir, 'out', 'adherence-fake.json'), 'utf8'),
      ) as {
        steps: {
          adherence: {
            status: string;
            data: {
              cases: Record<
                string,
                { native: number; runs: number; results: Array<{ mcpListed: boolean }> }
              >;
            };
          };
        };
      };
      const web = report.steps.adherence.data.cases['web']!;
      expect(report.steps.adherence.status).toBe('ok');
      expect(web).toMatchObject({ runs: 2, native: 2 });
      expect(readFileSync(path.join(dir, 'out', 'adherence-summary.md'), 'utf8')).toContain(
        '| fake | web | 2 / 0 / 0 / 0 / 0 | 2/2（1.00） | 达标 |',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
