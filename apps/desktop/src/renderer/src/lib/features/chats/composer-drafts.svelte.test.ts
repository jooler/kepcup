import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_DRAFTS_STORAGE_KEY } from './composer-draft-persist';

/**
 * 草稿恢复的附件存在性校验：core 7 天后回收未绑定附件（AttachmentsService.sweepOrphans），
 * 草稿快照里保留的 chip 必须在进入会话时经 attachments.status 一次往返校验——
 * 不止图片，pdf/docx 等非图片 chip 同样要校验，失效的摘掉并提示。
 */

const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
let statusHandler: (payload: { ids: string[] }) => Array<{ id: string; state: string }> = () => [];
let statusFails = false;
const toasts: Array<{ kind: string; message: string }> = [];
const previewRequests: string[] = [];
let previewFails = new Set<string>();

vi.mock('$lib/rpc/client.svelte', () => ({
  core: {
    onEvent: () => () => undefined,
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      if (method === 'attachments.status') {
        if (statusFails) throw new Error('core unavailable');
        return { statuses: statusHandler(payload as { ids: string[] }) };
      }
      return {};
    },
  },
}));
vi.mock('./attachments.svelte', () => ({
  attachmentUrl: async (attachment: { id: string }) => {
    previewRequests.push(attachment.id);
    if (previewFails.has(attachment.id)) throw new Error('gone');
    return `blob:${attachment.id}`;
  },
}));
vi.mock('svelte-sonner', () => ({
  toast: {
    error: (message: string) => toasts.push({ kind: 'error', message }),
    info: (message: string) => toasts.push({ kind: 'info', message }),
  },
}));

function persistedDraft(
  attachments: Array<{ attachmentId: string; fileName: string; mime: string }>,
) {
  return {
    doc: { type: 'doc', content: [{ type: 'paragraph' }] },
    mentions: [],
    reply: null,
    attachments: attachments.map((a) => ({ ...a, size: 10 })),
    updatedAt: 1,
  };
}

const store = new Map<string, string>();
store.set(
  COMPOSER_DRAFTS_STORAGE_KEY,
  JSON.stringify({
    conv_mixed: persistedDraft([
      { attachmentId: 'att_pdf_old', fileName: 'old.pdf', mime: 'application/pdf' },
      { attachmentId: 'att_pdf_ok', fileName: 'ok.pdf', mime: 'application/pdf' },
      { attachmentId: 'att_img_ok', fileName: 'a.png', mime: 'image/png' },
      { attachmentId: 'att_sent', fileName: 'sent.docx', mime: 'application/msword' },
    ]),
    conv_down: persistedDraft([
      { attachmentId: 'att_x', fileName: 'x.pdf', mime: 'application/pdf' },
    ]),
    conv_discard: persistedDraft([
      { attachmentId: 'att_d', fileName: 'd.pdf', mime: 'application/pdf' },
    ]),
    conv_img_gone: persistedDraft([
      { attachmentId: 'att_img_gone', fileName: 'gone.png', mime: 'image/png' },
    ]),
  }),
);
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
vi.stubGlobal('window', { addEventListener: () => undefined });

const { composerDrafts } = await import('./composer-drafts.svelte');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  previewRequests.length = 0;
  previewFails = new Set();
  statusFails = false;
});

describe('composerDrafts.hydrate 的附件存在性校验', () => {
  it('所有附件（含非图片）一次 attachments.status 往返；过期 / 已占用的 chip 被摘掉，仍在的保留', async () => {
    statusHandler = ({ ids }) =>
      ids.map((id) => ({
        id,
        state: id === 'att_pdf_old' ? 'missing' : id === 'att_sent' ? 'sent' : 'pending',
      }));
    composerDrafts.hydrate('conv_mixed');
    await flush();

    const statusCalls = calls.filter((call) => call.method === 'attachments.status');
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0]?.payload).toEqual({
      conversationId: 'conv_mixed',
      ids: ['att_pdf_old', 'att_pdf_ok', 'att_img_ok', 'att_sent'],
    });
    expect(composerDrafts.uploadsOf('conv_mixed').map((u) => u.attachmentId)).toEqual([
      'att_pdf_ok',
      'att_img_ok',
    ]);
    // 仅过期的提示用户（已占用 = 已发出，静默摘掉）。
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain('old.pdf');
    // 只给仍在的图片建预览。
    expect(previewRequests).toEqual(['att_img_ok']);
  });

  it('幂等：同一会话再次 hydrate 不重复校验', async () => {
    composerDrafts.hydrate('conv_mixed');
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('status 查询失败：不据此丢 chip（发送时按错误码再判因），图片预览仍照常尝试', async () => {
    statusFails = true;
    composerDrafts.hydrate('conv_down');
    await flush();
    expect(composerDrafts.uploadsOf('conv_down').map((u) => u.attachmentId)).toEqual(['att_x']);
    expect(toasts).toHaveLength(0);
  });

  it('图片 status 为 pending 但预览读取失败：仍沿用旧行为摘掉', async () => {
    statusHandler = ({ ids }) => ids.map((id) => ({ id, state: 'pending' }));
    previewFails = new Set(['att_img_gone']);
    composerDrafts.hydrate('conv_img_gone');
    await flush();
    expect(composerDrafts.uploadsOf('conv_img_gone')).toEqual([]);
  });
});

describe('composerDrafts.discardAttachments / inspectAttachments', () => {
  it('按附件 id 摘掉 chip（missing 与 sent 都摘），返回被摘的 key；没有命中返回 null', () => {
    statusFails = true; // 水合时不校验，只关心 discard 本身
    composerDrafts.hydrate('conv_discard');
    const keys = composerDrafts.discardAttachments('conv_discard', { missing: [], sent: ['att_d'] });
    expect(keys).toEqual(new Set(['att_att_d']));
    expect(composerDrafts.uploadsOf('conv_discard')).toEqual([]);
    expect(
      composerDrafts.discardAttachments('conv_discard', { missing: ['att_d'], sent: [] }),
    ).toBeNull();
  });

  it('inspectAttachments 把 status 归类；空列表不发请求', async () => {
    statusHandler = ({ ids }) => ids.map((id) => ({ id, state: id === 'b' ? 'sent' : 'missing' }));
    calls.length = 0;
    expect(await composerDrafts.inspectAttachments('conv_z', [])).toEqual({ missing: [], sent: [] });
    expect(calls).toHaveLength(0);
    expect(await composerDrafts.inspectAttachments('conv_z', ['a', 'b'])).toEqual({
      missing: ['a'],
      sent: ['b'],
    });
    expect(calls[0]).toEqual({
      method: 'attachments.status',
      payload: { conversationId: 'conv_z', ids: ['a', 'b'] },
    });
  });
});
