import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  reportPayloadSchema,
  REPORT_CONTENT_DEDUPE_MS,
  REPORT_PAYLOAD_DEDUPE_MS,
} from '@kepcup/shared';
import { canonicalJson, sha256Hex } from '../../src/domain/reports.js';

/**
 * 跨实现契约锚点（todo/ai-content-reporting.md §5.4 / §10.1）：core 与
 * reports Worker 各有一份 canonicalJson + sha256 实现，两边都必须对
 * packages/shared/test/fixtures/report-v1.json 复算出 fixture hashes 里的
 * 固定向量。禁止只改一边。Worker 侧（infra/cloudflare/reports）会做同样的断言。
 */

const fixturePath = path.resolve(
  import.meta.dirname,
  '../../../shared/test/fixtures/report-v1.json',
);

describe('report-v1 fixture hash contract (core ↔ Worker anchor)', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;

  it('recomputes the content hash exactly (message.text utf8 sha256)', () => {
    const message = fixture.message as { kind: string; text: string; content: unknown };
    const contentSource =
      message.kind === 'text' ? message.text : canonicalJson(message.content ?? { text: message.text });
    expect(sha256Hex(contentSource)).toBe(
      (fixture.hashes as { content: string }).content,
    );
    expect(sha256Hex(contentSource)).toBe(
      '69a79ef10ef88c2403a2379e49c17cea33d273aac4c6d325076e9c19fa21c911',
    );
  });

  it('recomputes the payload hash exactly (dedupePayload canonicalJson sha256)', () => {
    const dedupe: Record<string, unknown> = { ...fixture };
    delete dedupe.reportId;
    delete dedupe.createdAt;
    delete dedupe.hashes;
    expect(sha256Hex(canonicalJson(dedupe))).toBe(
      (fixture.hashes as { payload: string }).payload,
    );
    expect(sha256Hex(canonicalJson(dedupe))).toBe(
      '66f397f8a4cdc8489775eb3c706cccc7dfe0e9c2fea3ea43a1aed5170353215b',
    );
  });

  it('canonicalJson is order-insensitive on object keys but keeps array order', () => {
    const dedupe: Record<string, unknown> = { ...fixture };
    delete dedupe.reportId;
    delete dedupe.createdAt;
    delete dedupe.hashes;
    // 打乱顶层键顺序不影响结果（递归字典序）。
    const shuffled: Record<string, unknown> = {};
    for (const key of Object.keys(dedupe).reverse()) shuffled[key] = dedupe[key];
    expect(canonicalJson(shuffled)).toBe(canonicalJson(dedupe));
    // 数组保序：元素顺序不同则 JSON 不同（context / usage 顺序动不得）。
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('canonicalJson edge semantics match the Worker implementation byte for byte', () => {
    // 与 infra/cloudflare/reports/test/dedupe.test.ts 的同名断言逐字对应：
    // undefined 值的对象键剔除、undefined 数组元素 → null（两侧禁止分叉）。
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson({ k: '引号"与\n换行' })).toBe('{"k":"引号\\"与\\n换行"}');
    // 非 ASCII / 星形平面字符不转义，round-trip 无损（代理对不劈开）。
    const value = { emoji: '👍', cjk: '小助手', surrogate: '𠮷' };
    expect(JSON.parse(canonicalJson(value))).toEqual(value);
    expect(canonicalJson(NaN)).toBe('null');
    expect(canonicalJson(Infinity)).toBe('null');
  });

  it('the fixture body passes the shared reportPayloadSchema (1A contract)', () => {
    expect(reportPayloadSchema.parse(fixture)).toMatchObject({
      schemaVersion: 1,
      reportId: expect.stringMatching(/^rep_/),
      hashes: {
        content: '69a79ef10ef88c2403a2379e49c17cea33d273aac4c6d325076e9c19fa21c911',
        payload: '66f397f8a4cdc8489775eb3c706cccc7dfe0e9c2fea3ea43a1aed5170353215b',
      },
    });
  });

  it('shared dedupe-window constants match the spec defaults (§5.5)', () => {
    expect(REPORT_CONTENT_DEDUPE_MS).toBe(86_400_000);
    expect(REPORT_PAYLOAD_DEDUPE_MS).toBe(7_776_000_000);
  });
});
