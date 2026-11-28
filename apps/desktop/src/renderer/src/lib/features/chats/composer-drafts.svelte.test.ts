import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPOSER_DRAFTS_STORAGE_KEY,
  LEGACY_COMPOSER_DRAFTS_STORAGE_KEY,
} from './composer-draft-persist';
import { createMemoryIdbKvFactory } from '$lib/persist/idb-kv';

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
    // D115 附件直注：任务键快照带归属会话（buildPersistedSnapshot 的写入分支产物）。
    'task:run_h': {
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      mentions: [],
      reply: null,
      attachments: [{ attachmentId: 'att_h', fileName: 'h.png', mime: 'image/png', size: 10 }],
      updatedAt: 1,
      conversationId: 'conv_restored',
    },
    // Cross-source same-id draft: the persisted reply belongs to the team source.
    conv_foreign_reply: {
      doc: { type: 'doc', content: [{ type: 'paragraph' }] },
      mentions: [],
      reply: {
        id: 'msg_foreign',
        senderType: 'bot',
        senderBotId: 'bot_team',
        text: 'team-only original',
        source: 'team:h1',
      },
      attachments: [],
      updatedAt: 1,
    },
  }),
);
vi.stubGlobal('localStorage', {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
vi.stubGlobal('window', { addEventListener: () => undefined });

const { composerDrafts, ComposerDraftsState } = await import('./composer-drafts.svelte');
const { messageVisibility } = await import('$lib/stores/message-visibility.svelte');
const { connections } = await import('$lib/rpc/connections.svelte');

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(async () => {
  // 启动载入（旧 localStorage 整表键一次性导入）就位后再操作 store。
  await composerDrafts.ready();
  connections.reset();
  calls.length = 0;
  toasts.length = 0;
  previewRequests.length = 0;
  previewFails = new Set();
  statusFails = false;
  // Hidden overlay is process-global; clear ids this file uses.
  messageVisibility.forget('local', 'conv_hidden_reply');
});

describe('composerDrafts hidden reply sanitization', () => {
  it('drops active and persisted reply snapshots for hidden Bot messages', () => {
    connections.servers = [
      {
        serverHash: 'h1',
        url: 'https://team.example.com',
        name: '',
        accounts: [{ memberId: 'mbr_other', username: 'other', displayName: 'Other', remembered: true }],
        activeMemberId: 'mbr_other',
        status: 'connected',
      },
    ];
    try {
      const conversationId = 'conv_hidden_reply';
      const reply = {
        id: 'msg_hidden_reply',
        senderType: 'bot' as const,
        senderBotId: 'bot_1',
        text: 'hidden original',
        source: 'local' as const,
      };
      composerDrafts.setRpcSource('local');
      composerDrafts.saveComposerDoc(
        conversationId,
        { type: 'doc', content: [{ type: 'paragraph' }] },
        [],
        reply,
      );
      expect(composerDrafts.loadDraft(conversationId).reply).toEqual(reply);
      messageVisibility.setHidden('local', conversationId, reply.id, true);
      expect(composerDrafts.loadDraft(conversationId).reply).toBeNull();
      composerDrafts.saveComposerDoc(
        conversationId,
        { type: 'doc', content: [{ type: 'paragraph' }] },
        [],
        reply,
      );
      expect(composerDrafts.loadDraft(conversationId).reply).toBeNull();
      // Cross-source same-id drafts must not reuse a foreign reply snapshot.
      messageVisibility.setHidden('local', conversationId, reply.id, false);
      composerDrafts.setRpcSource('local');
      composerDrafts.saveComposerDoc(
        conversationId,
        { type: 'doc', content: [{ type: 'paragraph' }] },
        [],
        reply,
      );
      expect(composerDrafts.loadDraft(conversationId).reply).toEqual(reply);
      composerDrafts.setRpcSource('team:h1');
      expect(composerDrafts.loadDraft(conversationId).reply).toBeNull();
      // Rejected replies are purged, not restored when switching back.
      composerDrafts.setRpcSource('local');
      expect(composerDrafts.loadDraft(conversationId).reply).toBeNull();
      messageVisibility.forget('local', conversationId);
    } finally {
      connections.reset();
    }
  });

  it('drops a persisted reply snapshot that belongs to another source', () => {
    composerDrafts.setRpcSource('local');
    composerDrafts.hydrate('conv_foreign_reply');
    expect(composerDrafts.loadDraft('conv_foreign_reply').reply).toBeNull();
  });
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
    const keys = composerDrafts.discardAttachments('conv_discard', {
      missing: [],
      sent: ['att_d'],
    });
    expect(keys).toEqual(new Set(['att_att_d']));
    expect(composerDrafts.uploadsOf('conv_discard')).toEqual([]);
    expect(
      composerDrafts.discardAttachments('conv_discard', { missing: ['att_d'], sent: [] }),
    ).toBeNull();
  });

  it('inspectAttachments 把 status 归类；空列表不发请求', async () => {
    statusHandler = ({ ids }) => ids.map((id) => ({ id, state: id === 'b' ? 'sent' : 'missing' }));
    calls.length = 0;
    expect(await composerDrafts.inspectAttachments('conv_z', [])).toEqual({
      missing: [],
      sent: [],
    });
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

describe('D115 附件直注：任务键的归属会话覆盖', () => {
  it('uploadFiles(owner) → 上传落到任务所在会话；inspectAttachments 沿用归属；会话键不受影响', async () => {
    // 无 DOM 环境：fileToBase64 走 FileReader、图片预览走 createObjectURL，都要桩。
    const objectUrls: string[] = [];
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = 'data:image/png;base64,ew==';
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          this.onload?.();
        }
      },
    );
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => {
        const url = `blob:${objectUrls.length}`;
        objectUrls.push(url);
        return url;
      },
      revokeObjectURL: () => undefined,
    });
    calls.length = 0;
    statusHandler = ({ ids }) => ids.map((id) => ({ id, state: 'pending' }));
    composerDrafts.uploadFiles(
      'task:run_a',
      [new File(['x'], 'a.png', { type: 'image/png' })],
      'conv_owner',
    );
    await flush();
    const upload = calls.find((call) => call.method === 'attachments.upload');
    expect(upload?.payload['conversationId']).toBe('conv_owner');
    // chip 落在任务键下（状态缓存键 ≠ core 归属会话）。
    expect(composerDrafts.uploadsOf('task:run_a').length).toBe(1);
    // 状态校验缺省也走记录的归属会话（重启水合同理）。
    await composerDrafts.inspectAttachments('task:run_a', ['att_x']);
    const status = calls.filter((call) => call.method === 'attachments.status').at(-1);
    expect(status?.payload['conversationId']).toBe('conv_owner');
    // 会话键直传：归属就是键本身（对话行为不变）。
    composerDrafts.uploadFiles('conv_chat', [new File(['y'], 'b.png', { type: 'image/png' })]);
    await flush();
    const chatUpload = calls.filter((call) => call.method === 'attachments.upload').at(-1);
    expect(chatUpload?.payload['conversationId']).toBe('conv_chat');
    expect(composerDrafts.uploadsOf('conv_chat').length).toBe(1);
    composerDrafts.discardAttachments('task:run_a', { missing: [], sent: [] });
    composerDrafts.discardAttachments('conv_chat', { missing: [], sent: [] });
    vi.unstubAllGlobals();
  });

  it('重启水合：快照里记录的归属会话随任务键恢复，status 校验走归属（直达会话键不变）', async () => {
    calls.length = 0;
    statusHandler = ({ ids }) => ids.map((id) => ({ id, state: 'pending' }));
    composerDrafts.hydrate('task:run_h');
    await flush();
    const status = calls.filter((call) => call.method === 'attachments.status').at(-1);
    expect(status?.payload['conversationId']).toBe('conv_restored');
    // 水合后的上传也走恢复出的归属会话。
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = 'data:image/png;base64,ew==';
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          this.onload?.();
        }
      },
    );
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:restored',
      revokeObjectURL: () => undefined,
    });
    composerDrafts.uploadFiles('task:run_h', [new File(['z'], 'z.png', { type: 'image/png' })]);
    await flush();
    const upload = calls.filter((call) => call.method === 'attachments.upload').at(-1);
    expect(upload?.payload['conversationId']).toBe('conv_restored');
    composerDrafts.discardAttachments('task:run_h', { missing: [], sent: [] });
    vi.unstubAllGlobals();
  });
});

describe('localStorage → IndexedDB 迁移（内存 IDB）', () => {
  const restubStorage = (): void => {
    // 前面的用例可能已 vi.unstubAllGlobals()：恢复文件顶层的 localStorage 桩。
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
  };

  const legacyDraft = (text: string) => ({
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
    mentions: [],
    reply: null,
    attachments: [],
    updatedAt: 5,
  });

  it('旧整表键先逐条落 IDB 再删键；二次启动从 IDB 恢复（水合可用，version/dirty 保留）', async () => {
    restubStorage();
    // 文件顶层桩预置了 v3 键：清掉重置，用带 version/dirty 的 v3 草稿模拟升级
    // （v3 是当前版本的旧整表键；v2 升级标记 version=0/dirty=true 由
    // composer-draft-persist.test.ts 覆盖）。
    store.delete(COMPOSER_DRAFTS_STORAGE_KEY);
    store.set(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      conv_legacy: { ...legacyDraft('旧草稿'), version: 3, dirty: true },
    }));
    const kv = createMemoryIdbKvFactory();
    const dbPromise = kv.open('kepcup.composer-drafts', 1);

    const first = new ComposerDraftsState({ kv: dbPromise });
    await first.ready();
    // 落库确认成功才删旧键（P0：不能指望后续防抖落盘——diff 基线已含导入条目）。
    expect(store.has(COMPOSER_DRAFTS_STORAGE_KEY)).toBe(false);
    const entries = await (await dbPromise).store('drafts').getEntries();
    expect(entries.map((entry) => entry.key)).toContain('conv_legacy');

    // 二次启动：IDB 是唯一来源，水合恢复旧草稿（共享草稿断线恢复依赖
    // version/dirty，往返不得丢失）。
    const second = new ComposerDraftsState({ kv: dbPromise });
    await second.ready();
    second.hydrate('conv_legacy');
    expect(JSON.stringify(second.loadDraft('conv_legacy').doc)).toContain('旧草稿');
    expect(second.syncVersion('conv_legacy')).toBe(3);
    expect(second.isDirty('conv_legacy')).toBe(true);
  });

  it('重导入只补 IDB 缺口：IDB 已有有效记录的键不被旧值覆盖', async () => {
    restubStorage();
    // 上次迁移已落库（较新草稿）但删键失败：旧键带着同一会话的旧值残留。
    store.delete(COMPOSER_DRAFTS_STORAGE_KEY);
    const kv = createMemoryIdbKvFactory();
    const dbPromise = kv.open('kepcup.composer-drafts', 1);
    const db = await dbPromise;
    await db.store('drafts').put('conv_legacy', {
      ...legacyDraft('较新的草稿'),
      version: 7,
      dirty: false,
      updatedAt: 100,
    });
    store.set(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      conv_legacy: legacyDraft('旧的草稿'),
    }));

    const state = new ComposerDraftsState({ kv: dbPromise });
    await state.ready();
    state.hydrate('conv_legacy');
    expect(JSON.stringify(state.loadDraft('conv_legacy').doc)).toContain('较新的草稿');
    expect(state.syncVersion('conv_legacy')).toBe(7);
    // 旧键仍被收口删除（IDB 已有该会话的有效记录，迁移完成）。
    expect(store.has(COMPOSER_DRAFTS_STORAGE_KEY)).toBe(false);
  });

  it('IndexedDB 打不开：旧键保留（唯一持久副本），内存态照常水合', async () => {
    restubStorage();
    store.set(LEGACY_COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
      conv_stuck: legacyDraft('卡住的草稿'),
    }));
    const state = new ComposerDraftsState({ kv: Promise.reject(new Error('denied')) });
    await state.ready();
    expect(store.has(LEGACY_COMPOSER_DRAFTS_STORAGE_KEY)).toBe(true);
    state.hydrate('conv_stuck');
    expect(JSON.stringify(state.loadDraft('conv_stuck').doc)).toContain('卡住的草稿');
    // 收尾：清掉本次塞进桩的旧键，避免影响后续（无后续）用例。
    store.delete(LEGACY_COMPOSER_DRAFTS_STORAGE_KEY);
  });
});

describe('按会话记录的删除（回归：旧整表重写天然清掉，按记录必须显式删）', () => {
  it('dropConversation 后 IndexedDB 记录被删，重启不再复活已删会话的草稿', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    });
    const kv = createMemoryIdbKvFactory();
    const dbPromise = kv.open('kepcup.composer-drafts', 1);
    const state = new ComposerDraftsState({ kv: dbPromise });
    await state.ready();
    state.hydrate('conv_drop');
    state.saveComposerDoc(
      'conv_drop',
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '将删除' }] }] },
      [],
      null,
    );
    await new Promise((resolve) => setTimeout(resolve, 350)); // 越过 300ms 防抖落库
    const db = await dbPromise;
    expect((await db.store('drafts').getEntries()).map((e) => e.key)).toContain('conv_drop');
    state.dropConversation('conv_drop');
    await new Promise((resolve) => setTimeout(resolve, 50)); // 显式删除是 fire-and-forget
    expect((await db.store('drafts').getEntries()).map((e) => e.key)).not.toContain('conv_drop');
    // 后续防抖落盘不得把该键重新写回（diff 基线已不含它）。
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await db.store('drafts').getEntries()).map((e) => e.key)).not.toContain('conv_drop');
  });
});
