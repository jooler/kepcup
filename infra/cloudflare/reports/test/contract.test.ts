/**
 * Contract test: the shared fixture runs the full Worker pipeline end to end.
 * The fixture (packages/shared/test/fixtures/report-v1.json, ownership: shared)
 * carries the fixed hash vectors that pin core's node:crypto implementation and
 * this Worker's WebCrypto implementation together — both sides must reproduce them.
 */

import { describe, expect, it } from 'vitest';
import { bucketOf } from '../src/dedupe';
import {
  NOW,
  cloneFixture,
  finalize,
  loadFixture,
  makeDeps,
  makeVariant,
  postReport,
} from './helpers';

describe('fixture full pipeline', () => {
  it('accepts the fixture (201), then answers duplicates, then stores the full row', async () => {
    const rig = makeDeps();
    const fixture = loadFixture();

    // 1. First POST: hashes in the fixture verify -> 201 accepted.
    const first = await postReport(rig.deps, cloneFixture());
    expect(first.res.status).toBe(201);
    expect(first.body).toEqual({ status: 'accepted', id: fixture.reportId });

    // 2. Same payload again -> idempotent on report_id (§7.4 step 7 precedes dedupe).
    const same = await postReport(rig.deps, cloneFixture());
    expect(same.res.status).toBe(200);
    expect(same.body).toEqual({ status: 'duplicate', reason: 'report_id' });

    // 3. A fresh click on the same message (new reportId/createdAt) -> duplicate.
    const reclick = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { keepText: true })),
    );
    expect(reclick.res.status).toBe(200);
    expect(reclick.body).toEqual({ status: 'duplicate', reason: 'content' });

    // 4. After the content bucket (24h) rolls over but within the payload window
    //    (90d), the payload hash itself is what catches the repeat.
    rig.advance(24 * 3600_000 + 1);
    const payloadDup = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { keepText: true })),
    );
    expect(payloadDup.res.status).toBe(200);
    expect(payloadDup.body).toEqual({ status: 'duplicate', reason: 'payload' });

    // 5. Stored row: server-side columns derived from the fixture payload.
    const row = rig.d1.rows<Record<string, unknown>>('SELECT * FROM reports WHERE id = ?', fixture.reportId)[0]!;
    expect(row.status).toBe('new'); // 初始状态（§7.3）
    expect(row.client_id).toBe(fixture.client.id);
    expect(row.content_hash).toBe(fixture.hashes.content);
    expect(row.payload_hash).toBe(fixture.hashes.payload);
    expect(row.content_bucket).toBe(bucketOf(NOW, 86_400_000));
    expect(row.payload_bucket).toBe(bucketOf(NOW, 7_776_000_000));
    expect(row.received_at).toBe(NOW); // 服务端受理时间，不信客户端时钟
    expect(row.message_kind).toBe(fixture.message.kind);
    expect(row.message_text).toBe(fixture.message.text); // text 消息存正文
    expect(row.bot_id).toBe(fixture.bot.id);
    expect(row.bot_name).toBe(fixture.bot.name);
    expect(row.model_provider).toBe('openai'); // bot.runtime.model = "openai/gpt-5.1"
    expect(row.model_id).toBe('gpt-5.1');
    expect(row.app_version).toBe(fixture.client.appVersion);
    expect(row.platform).toBe(fixture.client.platform);
    expect(row.source_kind).toBe(fixture.source.kind);
    expect(row.ip_hash).toBeNull();
    // payload_json 原样保留完整 payload（可 JSON.parse 回 fixture）。
    expect(JSON.parse(row.payload_json as string)).toEqual(fixture);
    expect(rig.d1.rows('SELECT COUNT(*) AS n FROM reports')).toEqual([{ n: 1 }]);
  });

  it('different client, same text: accepted and stored as its own row', async () => {
    const rig = makeDeps();
    const fixture = loadFixture();
    expect((await postReport(rig.deps, cloneFixture())).res.status).toBe(201);
    const other = await postReport(
      rig.deps,
      await finalize(makeVariant(cloneFixture(), { clientId: 'client-42', keepText: true })),
    );
    expect(other.res.status).toBe(201); // 去重按 client（§5.5），不做全局去重
    expect(rig.d1.rows('SELECT COUNT(*) AS n FROM reports')).toEqual([{ n: 2 }]);
    const row = rig.d1.rows<Record<string, unknown>>(
      'SELECT * FROM reports WHERE client_id = ?',
      'client-42',
    )[0]!;
    expect(row.content_hash).toBe(fixture.hashes.content); // 内容相同
    expect(row.payload_hash).not.toBe(fixture.hashes.payload); // payload 含 client.id
  });
});
