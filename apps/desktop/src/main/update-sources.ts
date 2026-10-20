import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 更新源拓扑（docs/dev/06-release.md「更新镜像与选源」）：GitHub Releases 是唯一
 * 写入根，R2（国际第二源）与阿里云 OSS（国内首选）是发布后同步的只读副本。客户端
 * 不按地理位置硬切，按「实际可达性」选源——每次检查先用几 KB 的探测请求按优先级
 * （github → r2 → oss）找第一个可用源；赢家持久化到 userData，后续检查直达，
 * 失败一次才重新探测。国内用户自然落到 OSS，能直连 GitHub 的用户零开销。
 *
 * Electron-free：探测、选源、持久化全部走注入的依赖（globalThis.fetch / node:fs
 * 仅在默认实现里），主进程接线在 updater.ts，单测就地覆盖（vitest desktop 项目）。
 */

export type UpdateSourceId = 'github' | 'r2' | 'oss';

export interface UpdateSource {
  readonly id: UpdateSourceId;
  /**
   * 真实检查跑在哪：null → 烘焙进 app-update.yml 的 GitHub provider（electron-builder
   * `publish` 配置）；字符串 → generic feed 的基 URL（镜像，latest.yml 就在根下）。
   */
  readonly feedUrl: string | null;
  /** 选源探测用的轻量请求：github 打 API 免费端点，镜像直接拉 latest.yml。 */
  readonly probeUrl: string;
}

/** 与 electron-builder.yml 的 `publish` 块保持一致；两处都改。 */
export const GITHUB_OWNER = 'jooler';
export const GITHUB_REPO = 'kepcup';

/**
 * 烘焙的镜像基 URL。R2 绑 updates.kepcup.com（国际第二源，流出免费）；OSS 用
 * bucket 默认域名（国内首选，无需备案）。留空 = 不参与选源（探测直接跳过），
 * 探测失败只是落回下一个源，不会报给用户。
 */
const BAKED_MIRROR_FEED_URLS: Readonly<Record<'r2' | 'oss', string>> = {
  r2: 'https://updates.kepcup.com/',
  oss: 'https://kepcup-updates.oss-cn-shanghai.aliyuncs.com/',
};

/** 单个探测的超时。选源只在首跑/换源时发生，多等一秒只影响那一次。 */
const PROBE_TIMEOUT_MS = 4_000;

/**
 * api.github.com 的 rate_limit 端点：匿名不消耗核心额度（60/h 那个）、恒 200，
 * 探测的正是真实检查要用的那个 API 域——github.com 本身可达不等于 API 可用。
 */
const GITHUB_PROBE_URL = 'https://api.github.com/rate_limit';

function normalizeBase(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * 候选源列表，顺序即优先级。`KEPCUP_UPDATE_MIRRORS`（逗号分隔的 generic feed 基
 * URL）整体替换烘焙镜像——OSS/R2 的 bucket 落地前本地验证选源逻辑用，无需重打包；
 * 首个对应 r2、第二个对应 oss。`KEPCUP_UPDATE_URL`（整源覆盖）由 updater.ts 单独
 * 处理，设置时选源器根本不会被创建。
 */
export function updateSourcesFromEnv(env: NodeJS.ProcessEnv): UpdateSource[] {
  const override = env.KEPCUP_UPDATE_MIRRORS?.trim();
  const mirrorUrls =
    override !== undefined && override.length > 0
      ? override
          .split(',')
          .map((url) => url.trim())
          .filter((url) => url.length > 0)
          .map(normalizeBase)
      : Object.values(BAKED_MIRROR_FEED_URLS)
          .filter((url) => url.length > 0)
          .map(normalizeBase);
  return [
    { id: 'github', feedUrl: null, probeUrl: GITHUB_PROBE_URL },
    ...mirrorUrls.map((feedUrl, index): UpdateSource => {
      const id: UpdateSourceId = index === 0 ? 'r2' : 'oss';
      return { id, feedUrl, probeUrl: `${feedUrl}latest.yml` };
    }),
  ];
}

/** 探测：2xx 即可用；网络层任何失败都算不可用，绝不抛出。 */
async function probeOnce(source: UpdateSource, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(source.probeUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

/** 选源结果的持久化（userData 下的一个小 JSON；实现见 createFileUpdateSourceStore）。 */
export interface UpdateSourceStore {
  load(): UpdateSourceId | null;
  save(id: UpdateSourceId): void;
  clear(): void;
}

export interface UpdateSourceSelector {
  /**
   * 本次检查用哪个源：持久化的赢家直接返回（零探测开销），没有就按优先级探测
   * 并记住第一个可用者；全部不可达（离线）返回 null。
   */
  pick(): Promise<UpdateSource | null>;
  /**
   * 对 `failedId` 的真实检查抛错后调：忘掉它、探测其余源。全部不可达返回 null
   * （调用方走既有的静默 error 路径）。
   */
  pickAfterFailure(failedId: UpdateSourceId): Promise<UpdateSource | null>;
}

export function createUpdateSourceSelector(options: {
  sources(): UpdateSource[];
  store: UpdateSourceStore;
  probeTimeoutMs?: number;
  /** 测试缝：默认真实 fetch 探测。 */
  probe?: (source: UpdateSource, timeoutMs: number) => Promise<boolean>;
}): UpdateSourceSelector {
  const { sources, store } = options;
  const timeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const probe = options.probe ?? probeOnce;

  function find(id: UpdateSourceId): UpdateSource | undefined {
    return sources().find((source) => source.id === id);
  }

  async function probeAndPersist(exclude?: UpdateSourceId): Promise<UpdateSource | null> {
    for (const source of sources()) {
      if (source.id === exclude) continue;
      if (await probe(source, timeoutMs)) {
        store.save(source.id);
        return source;
      }
    }
    store.clear();
    return null;
  }

  return {
    async pick(): Promise<UpdateSource | null> {
      const persisted = store.load();
      if (persisted !== null) {
        const source = find(persisted);
        if (source !== undefined) return source;
        // 持久化的 id 已不在候选表里（镜像配置变了）：清掉，走探测。
        store.clear();
      }
      return probeAndPersist();
    },
    async pickAfterFailure(failedId: UpdateSourceId): Promise<UpdateSource | null> {
      if (store.load() === failedId) store.clear();
      return probeAndPersist(failedId);
    },
  };
}

/** store 的默认实现：`<userData>/update-source.json`。任何 IO 失败都吞掉——
 * 持久化丢了最多回到「下次多探测一轮」，绝不能影响更新流程。 */
export function createFileUpdateSourceStore(getDir: () => string): UpdateSourceStore {
  const file = (): string => path.join(getDir(), 'update-source.json');
  return {
    load(): UpdateSourceId | null {
      try {
        const raw: unknown = JSON.parse(readFileSync(file(), 'utf8'));
        if (
          typeof raw === 'object' &&
          raw !== null &&
          'source' in raw &&
          typeof (raw as { source: unknown }).source === 'string'
        ) {
          return (raw as { source: UpdateSourceId }).source;
        }
      } catch {
        // 不存在 / 坏 JSON：当作无记录。
      }
      return null;
    },
    save(id: UpdateSourceId): void {
      try {
        mkdirSync(getDir(), { recursive: true });
        writeFileSync(file(), `${JSON.stringify({ source: id }, null, 2)}\n`, 'utf8');
      } catch {
        // 只读 userData 等场景：跳过持久化，选源照常工作。
      }
    },
    clear(): void {
      try {
        rmSync(file(), { force: true });
      } catch {
        // 同上。
      }
    },
  };
}
