import type { ConversationCache, MessageCache } from '@kepcup/shared';
import { createIdbTeamCacheStore } from './team-cache-idb';

/**
 * T8（62.10 D136 / T8 §2）：团队本地缓存的渲染层统一接口 `TeamCacheStore`。
 *
 * 桌面实现走 `window.kepcup.platform.teamCache`（主进程整库加密分区，见
 * apps/desktop/src/main/team-cache/）；web 实现走 IndexedDB 适配器
 * （team-cache-idb.ts，库名含 serverHash + memberId，不加密——浏览器端加密受
 * 平台限制，以同源边界 + 登出清除选项为界，文档明示）。两个实现共用本文件里
 * 的同一 TS 接口，读路径（cache-sync.svelte.ts）不感知平台差异。
 *
 * 休眠：`getTeamCacheStore()` 在 platform 方法缺失（旧构建 / web 垫片）时返回
 * null——同步引擎与读路径全部跳过，行为与 T7 现状一致。
 */

export interface TeamCachePartition {
  serverHash: string;
  memberId: string;
}

export interface TeamCacheStore {
  open(partition: TeamCachePartition): Promise<void>;
  close(partition: TeamCachePartition): Promise<void>;
  putConversations(
    partition: TeamCachePartition,
    conversations: ConversationCache[],
    replace?: boolean,
  ): Promise<void>;
  putMessages(
    partition: TeamCachePartition,
    conversationId: string,
    messages: MessageCache[],
    replace?: boolean,
  ): Promise<void>;
  getConversations(partition: TeamCachePartition): Promise<ConversationCache[]>;
  getMessages(
    partition: TeamCachePartition,
    conversationId: string,
    options?: { limit?: number; beforeSeq?: number },
  ): Promise<MessageCache[]>;
  putAttachment(partition: TeamCachePartition, key: string, bytesBase64: string): Promise<void>;
  getAttachment(
    partition: TeamCachePartition,
    key: string,
  ): Promise<{ bytesBase64: string } | { missing: true }>;
  clearPartition(partition: TeamCachePartition): Promise<void>;
  clearServer(serverHash: string): Promise<void>;
}

/** 桌面 preload 面的结构视图（shim.d.ts 的窄读——按「方法可能缺失」处理）。 */
type PlatformTeamCacheApi = Record<string, unknown>;

/** 平台方法是否可用（桌面 preload 提供；web 垫片 / 旧构建没有）。 */
function desktopTeamCacheApi(): PlatformTeamCacheApi | null {
  if (typeof window === 'undefined') return null;
  const platform = (
    window as unknown as { kepcup?: { platform?: { teamCache?: unknown } } }
  ).kepcup?.platform;
  const api = platform?.teamCache;
  if (api === null || api === undefined || typeof api !== 'object') return null;
  const candidate = api as Record<string, unknown>;
  const required = [
    'open',
    'close',
    'putConversations',
    'putMessages',
    'getConversations',
    'getMessages',
    'putAttachment',
    'getAttachment',
    'clearPartition',
    'clearServer',
  ];
  return required.every((name) => typeof candidate[name] === 'function')
    ? candidate
    : null;
}

function isWebEndpoint(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { kepcup?: { isWeb?: boolean } }).kepcup?.isWeb === true;
}

/** 桌面实现：全部方法转发主进程（payload 直接透传，主进程按 shared schema 校验）。 */
export function createPlatformTeamCacheStore(api: PlatformTeamCacheApi): TeamCacheStore {
  const invoke = <T>(method: string, input?: unknown): Promise<T> =>
    (api[method] as (input?: unknown) => Promise<T>)(input);
  const partitionIn = (partition: TeamCachePartition): { serverHash: string; memberId: string } => ({
    serverHash: partition.serverHash,
    memberId: partition.memberId,
  });
  return {
    open: (partition) => invoke('open', partitionIn(partition)),
    close: (partition) => invoke('close', partitionIn(partition)),
    putConversations: (partition, conversations, replace) =>
      invoke('putConversations', {
        ...partitionIn(partition),
        conversations,
        ...(replace === true ? { replace: true } : {}),
      }),
    putMessages: (partition, conversationId, messages, replace) =>
      invoke('putMessages', {
        ...partitionIn(partition),
        conversationId,
        messages,
        ...(replace === true ? { replace: true } : {}),
      }),
    getConversations: async (partition) => {
      const result = await invoke<{ conversations: unknown[] }>(
        'getConversations',
        partitionIn(partition),
      );
      return result.conversations as ConversationCache[];
    },
    getMessages: async (partition, conversationId, options) => {
      const result = await invoke<{ messages: unknown[] }>('getMessages', {
        ...partitionIn(partition),
        conversationId,
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
      });
      return result.messages as MessageCache[];
    },
    putAttachment: (partition, key, bytesBase64) =>
      invoke('putAttachment', { ...partitionIn(partition), key, bytes: bytesBase64 }),
    getAttachment: async (partition, key) => {
      const result = await invoke<{ bytes: string } | { missing: true }>(
        'getAttachment',
        { ...partitionIn(partition), key },
      );
      return 'bytes' in result ? { bytesBase64: result.bytes } : { missing: true };
    },
    clearPartition: (partition) => invoke('clearPartition', partitionIn(partition)),
    clearServer: (serverHash) => invoke('clearServer', { serverHash }),
  };
}

/**
 * 平台自适应：web 端点 → IndexedDB 适配器；桌面端点 → platform（缺失 = 缓存
 * 整体禁用，读路径直连服务端——safeStorage 不可用等情况由 store 方法级错误兜底）。
 * idb 模块加载本身无副作用（休眠铁律不受影响：IndexedDB 只在引擎 open 时创建）。
 */
export function getTeamCacheStore(): TeamCacheStore | null {
  if (isWebEndpoint()) return createIdbTeamCacheStore();
  const api = desktopTeamCacheApi();
  return api === null ? null : createPlatformTeamCacheStore(api);
}

/**
 * 设置卡的占用读数与附件上限（仅桌面；web 无该 UI——IDB 配额交浏览器管理）。
 * 不在 TeamCacheStore 接口里：这是 platform 专属的管理面，不是缓存数据面。
 */
export interface TeamCacheExtras {
  usage(partition: TeamCachePartition): Promise<{
    cacheBytes: number | null;
    attachmentLimitBytes: number;
  }>;
  setAttachmentLimit(limitBytes: number): Promise<{ ok: true }>;
}

export function getDesktopTeamCacheExtras(): TeamCacheExtras | null {
  const api = desktopTeamCacheApi();
  if (
    api === null ||
    typeof api['usage'] !== 'function' ||
    typeof api['setAttachmentLimit'] !== 'function'
  ) {
    return null;
  }
  return {
    usage: (partition) =>
      (api['usage'] as (input: unknown) => Promise<{
        cacheBytes: number | null;
        attachmentLimitBytes: number;
      }>)({ serverHash: partition.serverHash, memberId: partition.memberId }),
    setAttachmentLimit: (limitBytes) =>
      (api['setAttachmentLimit'] as (input: unknown) => Promise<{ ok: true }>)({
        limitBytes,
      }),
  };
}
