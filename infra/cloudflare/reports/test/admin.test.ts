/**
 * Admin API tests (todo/ai-content-reporting.md §7.6): hidden entry (404) when the
 * token is not configured, 401 on mismatch, constant-time-safe compare, list with
 * keyset pagination + filters, detail with full payload_json, patch, delete-client,
 * and stats.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ReportPayload } from '../src/types';
import {
  NOW,
  bearer,
  cloneFixture,
  finalize,
  get,
  makeDeps,
  post,
  seedRate,
  seedReport,
  send,
  type Res,
  type TestRig,
} from './helpers';

const TOKEN = 'test-admin-token-0123456789abcdef';

let rig: TestRig;

beforeEach(() => {
  rig = makeDeps({ config: { adminToken: TOKEN } });
  // 25 new reports, newest first: rep_new_00 .. rep_new_24 (received_at spaced 1s).
  for (let i = 0; i < 25; i++) {
    seedReport(rig.d1, {
      id: `rep_new_${String(i).padStart(2, '0')}`,
      clientId: i % 2 === 0 ? 'client-even' : 'client-odd',
      receivedAt: NOW - i * 1000,
    });
  }
  seedReport(rig.d1, { id: 'rep_act_1', clientId: 'client-even', receivedAt: NOW - 100_000, status: 'actioned' });
  seedReport(rig.d1, { id: 'rep_act_2', clientId: 'client-odd', receivedAt: NOW - 101_000, status: 'actioned' });
  seedReport(rig.d1, { id: 'rep_act_3', clientId: 'client-even', receivedAt: NOW - 30 * 24 * 3600_000, status: 'actioned' });
  seedReport(rig.d1, { id: 'rep_dis_1', clientId: 'client-odd', receivedAt: NOW - 200_000, status: 'dismissed' });
});

function adminGet(path: string): Promise<Res> {
  return get(rig.deps, path, bearer(TOKEN));
}

describe('auth (§7.6)', () => {
  it('without a configured token the whole subtree is 404 (hidden entry)', async () => {
    const hidden = makeDeps(); // no REPORT_ADMIN_TOKEN
    for (const [path, init] of [
      ['/v1/admin/reports', {}],
      ['/v1/admin/reports', { headers: bearer('whatever') }],
      ['/v1/admin/stats', { headers: bearer(TOKEN) }],
    ] as const) {
      const { res } = await get(hidden.deps, path, (init as { headers?: Record<string, string> }).headers ?? {});
      expect(res.status).toBe(404);
    }
    const { body } = await send(hidden.deps, '/v1/admin/reports/rep_x', { method: 'DELETE' });
    expect(body).toEqual({ error: 'not_found' });
  });

  it('a wrong token is 401, regardless of length', async () => {
    for (const wrong of ['nope', `${TOKEN}x`, '']) {
      const { res } = await get(rig.deps, '/v1/admin/reports', wrong ? bearer(wrong) : {});
      expect(res.status).toBe(401);
    }
  });

  it('a non-bearer authorization header is 401', async () => {
    const { res } = await get(rig.deps, '/v1/admin/reports', { authorization: `Basic ${TOKEN}` });
    expect(res.status).toBe(401);
  });

  it('admin responses carry the no-store trio and no CORS headers', async () => {
    const { res } = await adminGet('/v1/admin/reports');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('GET /v1/admin/reports (list)', () => {
  it('defaults to status=new, limit=20, newest first', async () => {
    const { res, body } = await adminGet('/v1/admin/reports');
    expect(res.status).toBe(200);
    const reports = (body as { reports: Array<{ id: string; receivedAt: number }> }).reports;
    expect(reports).toHaveLength(20);
    expect(reports[0]!.id).toBe('rep_new_00');
    expect(reports[19]!.id).toBe('rep_new_19');
    // 摘要不含 payload_json / 完整正文
    expect(Object.keys(reports[0]!)).not.toContain('payload');
    expect(Object.keys(reports[0]!)).not.toContain('messageText');
    expect(reports[0]).toHaveProperty('messagePreview');
    const received = reports.map((r) => r.receivedAt);
    expect([...received].sort((a, b) => b - a)).toEqual(received);
  });

  it('pagination via nextBefore keyset cursor', async () => {
    const page1 = (await adminGet('/v1/admin/reports')).body as {
      reports: Array<{ id: string }>;
      nextBefore?: string;
    };
    expect(page1.nextBefore).toBeDefined();
    expect(page1.nextBefore).toMatch(/^\d+:/);
    const page2 = (await adminGet(`/v1/admin/reports?before=${encodeURIComponent(page1.nextBefore!)}`))
      .body as { reports: Array<{ id: string }>; nextBefore?: string };
    expect(page2.reports.map((r) => r.id)).toEqual([
      'rep_new_20',
      'rep_new_21',
      'rep_new_22',
      'rep_new_23',
      'rep_new_24',
    ]);
    expect(page2.nextBefore).toBeUndefined(); // exhausted
  });

  it('pagination keeps rows sharing the boundary received_at (id tiebreak, no gaps)', async () => {
    // 同一毫秒落 6 条：页大小 2 时，光标只带时间戳会丢掉同毫秒的其余行；
    // (received_at, id) 元组比较必须把它们全部翻页出来。
    rig = makeDeps({ config: { adminToken: TOKEN } }); // reset the beforeEach seed
    for (const id of ['rep_a', 'rep_b', 'rep_c', 'rep_d', 'rep_e', 'rep_f']) {
      seedReport(rig.d1, { id, clientId: 'client-same-ms', receivedAt: NOW });
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const path = cursor === undefined ? '/v1/admin/reports?limit=2' : `/v1/admin/reports?limit=2&before=${encodeURIComponent(cursor)}`;
      const body = (await adminGet(path)).body as { reports: Array<{ id: string }>; nextBefore?: string };
      seen.push(...body.reports.map((r) => r.id));
      cursor = body.nextBefore;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(['rep_f', 'rep_e', 'rep_d', 'rep_c', 'rep_b', 'rep_a']);
  });

  it('status and client filters work', async () => {
    const actioned = (await adminGet('/v1/admin/reports?status=actioned')).body as {
      reports: Array<{ id: string }>;
    };
    expect(actioned.reports.map((r) => r.id)).toEqual(['rep_act_1', 'rep_act_2', 'rep_act_3']);
    // Default status filter is 'new': client-even owns the 13 even-indexed new reports.
    const even = (await adminGet('/v1/admin/reports?client=client-even&limit=100')).body as {
      reports: Array<{ id: string }>;
    };
    expect(even.reports).toHaveLength(13);
    // Filters combine: actioned + client-even -> rep_act_1 + rep_act_3.
    const evenActioned = (await adminGet('/v1/admin/reports?status=actioned&client=client-even'))
      .body as { reports: Array<{ id: string }> };
    expect(evenActioned.reports.map((r) => r.id)).toEqual(['rep_act_1', 'rep_act_3']);
  });

  it('limit is bounded (1..100), bad params are 400', async () => {
    const limited = (await adminGet('/v1/admin/reports?limit=5')).body as {
      reports: Array<{ id: string }>;
      nextBefore?: string;
    };
    expect(limited.reports).toHaveLength(5);
    expect(limited.nextBefore).toBeDefined();
    for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'status=bogus']) {
      const { res } = await adminGet(`/v1/admin/reports?${bad}`);
      expect(res.status).toBe(400);
    }
  });

  it('other methods are 405', async () => {
    const { res } = await post(rig.deps, '/v1/admin/reports', {}, bearer(TOKEN));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});

describe('GET /v1/admin/reports/:id (detail)', () => {
  it('returns every column plus the parsed payload_json', async () => {
    const payload = await finalizeSeed();
    seedReport(rig.d1, {
      id: 'rep_full',
      clientId: 'client-x',
      receivedAt: NOW - 500,
      messageText: payload.message.text,
      payloadJson: JSON.stringify(payload),
    });
    const { res, body } = await adminGet('/v1/admin/reports/rep_full');
    expect(res.status).toBe(200);
    const report = (body as { report: Record<string, unknown> }).report;
    expect(report.messageText).toBe(payload.message.text);
    expect(report.payload).toEqual(payload); // 完整 payload_json
    expect(report.clientId).toBe('client-x');
    expect(report.botName).toBe('小助手');
    expect(report.updatedAt).toBeNull();
  });

  it('unknown id is 404', async () => {
    const { res } = await adminGet('/v1/admin/reports/rep_nope');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/admin/reports/:id', () => {
  it('sets status + note + updated_at', async () => {
    const { res, body } = await send(rig.deps, '/v1/admin/reports/rep_new_00', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
      body: JSON.stringify({ status: 'actioned', note: '已加入系统提示词拦截' }),
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ id: 'rep_new_00', status: 'actioned', updatedAt: NOW });
    const row = rig.d1.rows<{ status: string; note: string | null; updated_at: number | null }>(
      'SELECT status, note, updated_at FROM reports WHERE id = ?',
      'rep_new_00',
    )[0]!;
    expect(row.status).toBe('actioned');
    expect(row.note).toBe('已加入系统提示词拦截');
    expect(row.updated_at).toBe(NOW);
  });

  it('omitting note keeps the stored note; null clears it', async () => {
    await send(rig.deps, '/v1/admin/reports/rep_new_00', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
      body: JSON.stringify({ status: 'triaged', note: 'keep me' }),
    });
    await send(rig.deps, '/v1/admin/reports/rep_new_00', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
      body: JSON.stringify({ status: 'actioned' }),
    });
    expect(rig.d1.rows<{ note: string | null }>('SELECT note FROM reports WHERE id = ?', 'rep_new_00')[0]!.note).toBe('keep me');
    await send(rig.deps, '/v1/admin/reports/rep_new_00', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
      body: JSON.stringify({ status: 'dismissed', note: null }),
    });
    expect(rig.d1.rows<{ note: string | null }>('SELECT note FROM reports WHERE id = ?', 'rep_new_00')[0]!.note).toBeNull();
  });

  it("rejects 'new' and unknown statuses with 400", async () => {
    for (const status of ['new', 'published', 42]) {
      const { res } = await send(rig.deps, '/v1/admin/reports/rep_new_00', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
        body: JSON.stringify({ status }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('unknown id is 404, bad JSON is 400, note over 2000 chars is 400', async () => {
    const patch = (body: string, id = 'rep_new_00') =>
      send(rig.deps, `/v1/admin/reports/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...bearer(TOKEN) },
        body,
      });
    expect((await patch('{"status":"triaged"}', 'rep_nope')).res.status).toBe(404);
    expect((await patch('{broken')).res.status).toBe(400);
    expect((await patch(JSON.stringify({ status: 'triaged', note: 'x'.repeat(2001) }))).res.status).toBe(400);
  });
});

describe('DELETE /v1/admin/clients/:clientId (privacy deletion)', () => {
  it('removes all reports and the rate row of that client only', async () => {
    seedRate(rig.d1, 'client-even', NOW);
    seedRate(rig.d1, 'client-odd', NOW);
    const { res, body } = await send(rig.deps, '/v1/admin/clients/client-even', {
      method: 'DELETE',
      headers: bearer(TOKEN),
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'deleted', clientId: 'client-even', reports: 15, rateRows: 1 });
    expect(rig.d1.rows('SELECT * FROM reports WHERE client_id = ?', 'client-even')).toHaveLength(0);
    expect(rig.d1.rows('SELECT * FROM report_rate')).toHaveLength(1); // client-odd survives
    const oddLeft = rig.d1.rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM reports WHERE client_id = ?',
      'client-odd',
    )[0]!;
    expect(oddLeft.n).toBeGreaterThan(0);
  });

  it('unknown client deletes nothing (200 with zeros)', async () => {
    const { res, body } = await send(rig.deps, '/v1/admin/clients/client-nobody', {
      method: 'DELETE',
      headers: bearer(TOKEN),
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'deleted', clientId: 'client-nobody', reports: 0, rateRows: 0 });
  });

  it('GET is 405', async () => {
    const { res } = await get(rig.deps, '/v1/admin/clients/client-even', bearer(TOKEN));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('DELETE');
  });
});

describe('GET /v1/admin/stats', () => {
  it('counts by status and within the last 7 days', async () => {
    const { res, body } = await adminGet('/v1/admin/stats');
    expect(res.status).toBe(200);
    expect(body).toEqual({
      byStatus: { new: 25, actioned: 3, dismissed: 1 },
      last7Days: 28, // rep_act_3 is 30 days old, everything else is within a window
      generatedAt: NOW,
    });
  });
});

/** Builds a fixture-anchored payload for the detail test (hashes recomputed). */
async function finalizeSeed(): Promise<ReportPayload> {
  return finalize(cloneFixture());
}
