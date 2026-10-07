import {
  AppError,
  CONSOLIDATION_LOCAL_HOUR,
  PROFILE_CARD_TOKEN_BUDGET,
  PROFILE_CURATION_DELAY_MS,
  type Conversation,
  type EmbeddingStatus,
  type MemoryEvidence,
  type MemoryItem,
  type MemoryKind,
  type Message,
  type ProfileCategory,
  type ProfileItem,
  type Run,
} from '@kepcup/shared';
import type { SqliteDatabase } from '../infra/db.js';
import type { Clock } from '../infra/clock.js';
import type { CoreLogger } from '../infra/logger.js';
import type { AppPaths } from '../infra/paths.js';
import { truncateToBudget } from '../agent/tokens.js';
import type { MediaService } from '../media/service.js';
import type { BotsService } from '../domain/bots.js';
import type { ConversationsService } from '../domain/conversations.js';
import type { MessagesService } from '../domain/messages.js';
import type { JobsService } from '../domain/jobs.js';
import type { RunsService } from '../domain/runs.js';
import type { SettingsService } from '../domain/settings.js';
import type { SecretsService } from '../domain/secrets.js';
import type { EnvManager } from '../env/manager.js';
import type { RunIdentity } from '../agent/types.js';
import type { BotProfile } from '@kepcup/shared';
import { profileChangeApprovalPayloadSchema } from '@kepcup/shared';
import { MemoryDbManager } from './manager.js';
import type { MemoryStore } from './store.js';
import { ProfileStore } from './profile-store.js';
import { EMBEDDING_MODEL_ID, GatewayEmbedder, LocalEmbedder, type Embedder } from './embedder.js';
import { EMBEDDING_MODEL_VERSION } from '../env/catalog.js';
import { executionProvidersFor } from '../env/gpu.js';
import { retrieveRelevant, type RetrievedMemories } from './retrieve.js';
import { buildMyState, formatMyState } from './my-state.js';
import { checkMemoryCandidate, checkProfileCandidate, type WriteCheckContext } from './validate.js';
import { containsCredential } from './credential-patterns.js';
import { mentionsSensitiveTopic } from './sensitive-topics.js';
import { localDateKey, localHourOf } from './local-date.js';
import type { NewMemoryItem } from './store.js';

export interface MemoryServiceDeps {
  paths: AppPaths;
  masterKey: Buffer;
  mainDb: SqliteDatabase;
  runsDb: SqliteDatabase;
  clock: Clock;
  logger: CoreLogger;
  settings: SettingsService;
  secrets: SecretsService;
  bots: BotsService;
  conversations: ConversationsService;
  messages: MessagesService;
  jobs: JobsService;
  runs: RunsService;
  timeZone: string;
  /** Late-wired system-initiated environment requests (embedding model). */
  environment?: EnvManager | undefined;
  /** 国内厂商媒体网关：向量/重排经其按能力配置与适配器路由。 */
  media?: MediaService | undefined;
  /** Test hook: replaces the configured embedder (deterministic vectors). */
  embedderOverride?: Embedder | undefined;
  /**
   * Blocking approvals for propose_profile_change (P07). The run parks in
   * waiting_approval until the user decides — the bot needs the outcome to
   * know whether its own Profile changed.
   */
  approvals?: ApprovalsFacade | undefined;
  /**
   * Test hook: PROFILE_CURATION_DELAY_MS override (default from constants;
   * mirrors KEPCUP_TRIAGE_TIMEOUT_MS precedent).
   */
  curationDelayMs?: number | undefined;
  /**
   * P10 commitment linkage: internal event bus emissions (commitment created
   * / invalidated) consumed by the schedule service. Not an RPC event.
   */
  publish?: ((event: string, payload: unknown) => void) | undefined;
}

/** The slice of ApprovalsService the profile-change flow needs. */
export interface ApprovalsFacade {
  request(
    identity: RunIdentity,
    kind: 'profile_change',
    payload: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ decision: 'approved' | 'denied' | 'cancelled' }>;
}

export interface RememberInput {
  content: string;
  kind: MemoryKind;
  privateToBot?: boolean | undefined;
  dueAt?: string | undefined;
  validUntil?: string | undefined;
  /** Evidence = the messages that triggered this run. */
  triggerMessages: Message[];
}

export interface RememberResult {
  ok: boolean;
  item: MemoryItem | null;
  /** True when an equivalent active entry existed and was refreshed only. */
  deduped: boolean;
  /** False when validation dropped the candidate (credential, evidence…). */
  reason: string;
}

/**
 * Memory & user profile domain service (P07). Owns the per-bot memory
 * databases (encrypted, pooled), the shared profile store, the embedder and
 * the lifecycle hooks. Profile writes funnel exclusively through ProfileStore
 * (curation job + user edits); bot memory writes all funnel through the
 * validating helpers below.
 */
export class MemoryService {
  readonly #deps: MemoryServiceDeps;
  readonly #manager: MemoryDbManager;
  readonly #profileStore: ProfileStore;

  constructor(deps: MemoryServiceDeps) {
    this.#deps = deps;
    this.#manager = new MemoryDbManager({
      paths: deps.paths,
      masterKey: deps.masterKey,
      clock: () => deps.clock.now(),
      logger: deps.logger,
    });
    this.#profileStore = new ProfileStore({ db: deps.mainDb, clock: () => deps.clock.now() });
  }

  get profileStore(): ProfileStore {
    return this.#profileStore;
  }

  storeFor(botId: string): MemoryStore {
    return this.#manager.for(botId);
  }

  /** True when the bot has a memory database on disk (never creates one). */
  hasMemoryDb(botId: string): boolean {
    return this.#manager.exists(botId);
  }

  /** P13 任务 6 诊断: per-bot stores currently held open (lazy-open pool). */
  get openMemoryStores(): number {
    return this.#manager.openCount;
  }

  /** Closes a bot's pooled connection before its directory is removed. */
  prepareBotDeletion(botId: string): void {
    this.#manager.closeBot(botId);
  }

  /** Deletion-dialog count; 0 without creating a missing database. */
  memoryItemCount(botId: string): number {
    if (!this.#manager.exists(botId)) return 0;
    return this.storeFor(botId).list().length;
  }

  closeAll(): void {
    this.#manager.closeAll();
  }

  // --- embedder --------------------------------------------------------------

  /** The configured embedder or the test override; null = not configured. */
  currentEmbedder(): Embedder | null {
    if (this.#deps.embedderOverride !== undefined) return this.#deps.embedderOverride;
    const config = this.#deps.settings.get().embedding;
    if (config.source === 'provider') {
      // 厂商来源使用「向量模型」section 的配置（capabilityModels.embedding），
      // 经媒体网关按厂商适配器路由——百炼多模态/早期向量模型的原生端点不挂
      // 在 OpenAI 兼容根上。
      const media = this.#deps.media;
      const target = this.#deps.settings.get().capabilityModels.embedding;
      if (media === undefined || target === null) return null;
      return new GatewayEmbedder({
        provider: target.vendor,
        model: target.model,
        getPersistedDim: () => this.#deps.settings.get().embedding.dim,
        ready: () => media.embeddingReady(),
        embed: (texts) => media.embedTexts(target.vendor, target.model, texts),
      });
    }
    if (config.source === 'local') {
      // 本地来源（DEV-007 落地）：ONNX 运行库 + jina-embeddings-v2-base-zh 经
      // 环境管理器安装到 toolchains；未安装时 ready()=false，检索退化为 FTS。
      const environment = this.#deps.environment;
      const model = environment?.installedFor('embedding-model') ?? null;
      const runtime = environment?.installedFor('onnxruntime') ?? null;
      return new LocalEmbedder({
        modelDir: model?.dir ?? null,
        runtimeDir: runtime?.dir ?? null,
        modelVersion: model?.version ?? EMBEDDING_MODEL_VERSION,
        accelerators: executionProvidersFor(process.platform, process.arch),
        logger: this.#deps.logger,
      });
    }
    return null;
  }

  /**
   * Records the observed embedding dimension in settings (BR-P07-001). A fresh
   * vendor embedder instance reports it from construction on, so retrieval,
   * rebuild and the settings page work before this process embeds anything.
   */
  #rememberDim(embedder: Embedder, vectors: readonly Float32Array[]): void {
    if (this.#deps.embedderOverride !== undefined) return;
    const dim = vectors[0]?.length;
    if (dim === undefined || dim <= 0) return;
    const config = this.#deps.settings.get().embedding;
    if (config.dim === dim) return;
    this.#deps.settings.update({ embedding: { ...config, dim } });
  }

  /**
   * 检索精排回调（RRF 融合后重排，见 docs/design/16-capability-models.md）：
   * 已配置重排模型时返回「query + 文档 → 按相关性排序的下标数组」，失败或
   * 未配置返回 null——重排永远不阻断检索。
   */
  #retrievalReranker(): ((query: string, documents: string[]) => Promise<number[] | null>) | null {
    const media = this.#deps.media;
    if (media === undefined) return null;
    if (this.#deps.settings.get().capabilityModels.rerank === null) return null;
    return async (query, documents) => {
      try {
        const result = await media.rerank({ query, documents, topN: documents.length });
        return result.results.map((row) => row.index);
      } catch (error) {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'memory rerank failed; falling back to RRF order',
        );
        return null;
      }
    };
  }

  embeddingStatus(): EmbeddingStatus {
    const config = this.#deps.settings.get().embedding;
    const embedder = this.currentEmbedder();
    const target = this.#deps.settings.get().capabilityModels.embedding;
    const base =
      config.source === 'local'
        ? { source: config.source, provider: 'local', model: EMBEDDING_MODEL_ID }
        : {
            source: config.source,
            provider: target?.vendor ?? '',
            model: target?.model ?? '',
          };
    if (embedder === null) {
      return {
        ...base,
        ready: false,
        dim: null,
        reason:
          config.source === 'provider'
            ? '「向量模型」未配置：请在设置-模型的向量模型 section 选择厂商与模型'
            : '未配置向量来源：未配置时使用全文检索，可在设置页选择本地模型或厂商接口',
      };
    }
    if (embedder.ready()) {
      return { ...base, ready: true, dim: embedder.dim };
    }
    return {
      ...base,
      ready: false,
      dim: embedder.dim,
      reason:
        config.source === 'local'
          ? '本地向量模型或 ONNX 运行库未安装：批准环境安装（含运行库，约 276MB）后自动就绪，未安装时使用全文检索'
          : '该厂商缺少 API key，无法调用向量接口',
    };
  }

  /**
   * First-vector-needed flow (docs 任务 2): an unconfigured source defaults to
   * the local model and the SYSTEM (botId null) raises one environment
   * approval in the triggering conversation. Fire-and-forget: writes never
   * wait on it and retrieval degrades to FTS until ready.
   */
  ensureEmbeddingConfigured(conversationId: string | null): void {
    const config = this.#deps.settings.get().embedding;
    if (config.source !== '') return;
    this.#deps.settings.update({ embedding: { ...config, source: 'local' } });
    this.#deps.logger.info('embedding source defaulted to local (first vector need)');
    const environment = this.#deps.environment;
    if (environment === undefined || conversationId === null) return;
    void environment
      .requestAsSystem({
        conversationId,
        item: 'embedding-model',
        reason: '记忆检索需要本地向量模型；安装后可提升跨说法的召回质量，未安装时使用全文检索',
      })
      .catch((error: unknown) => {
        this.#deps.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'system embedding-model request failed',
        );
      });
  }

  /** embedding.configure RPC: persists the source and schedules a rebuild. */
  configureEmbedding(input: { source: 'local' | 'provider' }): EmbeddingStatus {
    const before = this.currentEmbedder()?.id ?? '';
    const current = this.#deps.settings.get().embedding;
    this.#deps.settings.update({ embedding: { ...current, source: input.source } });
    const embedder = this.currentEmbedder();
    const after = embedder?.id ?? '';
    // A dim recorded for the previous source/model is meaningless now; the
    // rebuild job re-records it after the first successful embed.
    if (before !== after) {
      const stored = this.#deps.settings.get().embedding;
      if (stored.dim !== null) {
        this.#deps.settings.update({ embedding: { ...stored, dim: null } });
      }
    }
    // Different effective model ⇒ all memory_vec tables must be rebuilt.
    this.#deps.jobs.enqueue({
      type: 'memory_vec_rebuild',
      payload: { modelId: after },
      priority: 2,
      dedupeKey: 'memory_vec_rebuild',
    });
    if (input.source === 'local') {
      this.ensureEmbeddingConfigured(null);
    }
    return this.embeddingStatus();
  }

  /**
   * 环境管理器回调（EnvManager deps.onEmbeddingModelInstalled）：本地向量
   * 模型安装完成时触发。若来源是本地模型，已入库的旧条目在安装前没有向量
   * （FTS-only），入队一次 memory_vec_rebuild（带 dedupeKey，重复触发会
   * 合并）；embedder 未就绪时任务自行 defer（jobs-runner 分支）。
   */
  handleEmbeddingModelInstalled(): void {
    if (this.#deps.settings.get().embedding.source !== 'local') return;
    this.#deps.jobs.enqueue({
      type: 'memory_vec_rebuild',
      payload: { modelId: this.currentEmbedder()?.id ?? '' },
      priority: 2,
      dedupeKey: 'memory_vec_rebuild',
    });
  }

  // --- bot memory writes -------------------------------------------------------

  /**
   * remember tool + reflection writes. Validation runs first; a vector-ready
   * embedder enables cosine dedupe; fact/preference entries also submit a
   * profile proposal (the curation loop filters them).
   */
  async writeMemory(
    botId: string,
    conversationId: string | null,
    input: RememberInput,
  ): Promise<RememberResult> {
    const conversation =
      conversationId !== null ? (this.#deps.conversations.get(conversationId) ?? null) : null;
    const candidate = {
      kind: input.kind,
      content: input.content,
      // remember is by definition an explicit user request.
      source: 'explicit' as const,
      evidenceMessageIds: input.triggerMessages.map((m) => m.id),
      confidence: 1,
      sensitivity: 'normal' as const,
      privateToBot: input.privateToBot === true,
    };
    const verdict = checkMemoryCandidate(candidate, botId, this.#checkContext());
    if (verdict.verdict === 'drop') {
      return { ok: false, item: null, deduped: false, reason: verdict.reason };
    }
    const { item, fresh } = await this.#persistValidated(botId, conversation, {
      kind: input.kind,
      content: input.content,
      subject: null,
      source: 'explicit',
      evidence: this.#evidenceFrom(input.triggerMessages, null),
      origin: conversation?.type === 'group' ? 'group' : 'private',
      originConversationId: conversationId,
      confidence: 1,
      sensitivity: 'normal',
      privateToBot: input.privateToBot === true,
      dueAt: input.dueAt !== undefined ? parseIsoOrThrow(input.dueAt) : null,
      validUntil: input.validUntil !== undefined ? parseIsoOrThrow(input.validUntil) : null,
    });
    if (fresh && item !== null) this.#emitCommitmentCreated(botId, conversationId, item);
    // 关于用户本人的事实同时生成画像提案（任务书工具表）。敏感类别即使用户
    // 明确要求记住，提案也会被降级为该 Bot 私有记忆（design/04：默认不进共
    // 享层；BR-P07-011 的词面初筛 + checkProfileCandidate 的既有强制）。
    if (input.kind === 'fact' || input.kind === 'preference') {
      this.submitProfileProposal(botId, {
        category: input.kind === 'preference' ? 'communication' : 'basic',
        content: input.content,
        source: 'explicit',
        evidence: input.triggerMessages.map((m) => m.id),
        confidence: 1,
        sensitivity: mentionsSensitiveTopic(input.content) ? 'sensitive' : 'normal',
        privateToBot: input.privateToBot === true,
        immediate: false,
      });
    }
    return { ok: true, item, deduped: false, reason: '' };
  }

  /**
   * Reflection writes (source/confidence/sensitivity from the model, still
   * code-validated). Private-only profile candidates land here as bot memory.
   */
  async writeReflectionMemory(
    botId: string,
    conversationId: string | null,
    candidate: {
      kind: MemoryKind;
      content: string;
      subject?: string | null;
      source: 'explicit' | 'inferred';
      evidenceMessageIds: string[];
      confidence: number;
      sensitivity: 'normal' | 'sensitive';
      privateToBot: boolean;
      dueAtMs?: number | null;
      validUntilMs?: number | null;
      evidenceRunId: string | null;
    },
  ): Promise<{ ok: boolean; item: MemoryItem | null; reason: string }> {
    const verdict = checkMemoryCandidate(
      {
        kind: candidate.kind,
        content: candidate.content,
        source: candidate.source,
        evidenceMessageIds: candidate.evidenceMessageIds,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        privateToBot: candidate.privateToBot,
      },
      botId,
      this.#checkContext(),
    );
    if (verdict.verdict === 'drop') {
      return { ok: false, item: null, reason: verdict.reason };
    }
    const conversation =
      conversationId !== null ? (this.#deps.conversations.get(conversationId) ?? null) : null;
    const messages = candidate.evidenceMessageIds
      .map((id) => this.#deps.messages.getById(id))
      .filter((m): m is Message => m !== null);
    const { item, fresh } = await this.#persistValidated(botId, conversation, {
      kind: candidate.kind,
      content: candidate.content,
      subject: candidate.subject ?? null,
      source: candidate.source,
      evidence: this.#evidenceFrom(messages, candidate.evidenceRunId),
      origin: conversation?.type === 'group' ? 'group' : 'private',
      originConversationId: conversationId,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      privateToBot: candidate.privateToBot,
      dueAt: candidate.dueAtMs ?? null,
      validUntil: candidate.validUntilMs ?? null,
    });
    if (fresh && item !== null) this.#emitCommitmentCreated(botId, conversationId, item);
    return { ok: true, item, reason: '' };
  }

  /**
   * Vector store side of every validated write: cosine dedupe refreshes the
   * existing entry instead of inserting (写入校验 rule 6); fresh inserts are
   * embedded and persisted when the embedder is ready.
   */
  async #persistValidated(
    botId: string,
    conversation: Conversation | null,
    item: NewMemoryItem,
  ): Promise<{ item: MemoryItem | null; fresh: boolean }> {
    this.ensureEmbeddingConfigured(conversation?.id ?? null);
    const embedder = this.currentEmbedder();
    let embedding: Float32Array | null = null;
    if (embedder !== null && embedder.ready()) {
      try {
        const [vector] = await embedder.embed([item.content]);
        embedding = vector ?? null;
        if (embedding !== null) this.#rememberDim(embedder, [embedding]);
      } catch (error) {
        this.#deps.logger.warn(
          { botId, error: error instanceof Error ? error.message : String(error) },
          'embedding failed, falling back to exact dedupe',
        );
      }
    }
    // Re-acquire AFTER the await: the db pool may have evicted (closed) the
    // connection while the embed request was in flight (BR-P07-005).
    const store = this.storeFor(botId);
    const similar = store.findSimilar(item.content, embedding);
    if (similar !== null) {
      store.touch(similar.id);
      return { item: store.getItem(similar.id), fresh: false };
    }
    const created = store.insert(item);
    if (embedding !== null && embedder !== null) {
      await store.ensureVecTable(embedder.id, embedding.length);
      const rowid = store.rowidOf(created.id);
      if (rowid !== null) store.upsertVec(rowid, embedding);
    }
    return { item: created, fresh: true };
  }

  /**
   * Embeds a freshly inserted item and upserts its vector (BR-P07-002): used
   * by the consolidation loop so merged/summarized entries stay searchable via
   * KNN. Best-effort — a failed embed leaves the entry FTS-only.
   */
  async embedItem(botId: string, item: MemoryItem): Promise<void> {
    const embedder = this.currentEmbedder();
    if (embedder === null || !embedder.ready()) return;
    try {
      const [vector] = await embedder.embed([item.content]);
      if (vector === undefined) return;
      this.#rememberDim(embedder, [vector]);
      const store = this.storeFor(botId); // after the await (BR-P07-005)
      await store.ensureVecTable(embedder.id, vector.length);
      const rowid = store.rowidOf(item.id);
      if (rowid !== null) store.upsertVec(rowid, vector);
    } catch (error) {
      this.#deps.logger.warn(
        { botId, itemId: item.id, error: error instanceof Error ? error.message : String(error) },
        'consolidation vector sync failed',
      );
    }
  }

  // --- profile proposals -------------------------------------------------------

  /**
   * Submits a profile proposal (validated) and schedules the curation job.
   * The ONLY door into the shared profile besides the user's direct edits.
   */
  submitProfileProposal(
    botId: string | null,
    candidate: {
      category: ProfileCategory;
      content: string;
      source: 'explicit' | 'inferred';
      evidence: string[];
      confidence: number;
      sensitivity: 'normal' | 'sensitive';
      privateToBot: boolean;
      validUntilMs?: number | null;
      immediate?: boolean | undefined;
    },
  ): { ok: boolean; reason: string } {
    if (botId === null) return { ok: false, reason: 'global loops cannot propose' };
    const verdict = checkProfileCandidate(
      {
        content: candidate.content,
        source: candidate.source,
        evidenceMessageIds: candidate.evidence,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        privateToBot: candidate.privateToBot,
      },
      botId,
      this.#checkContext(),
    );
    if (verdict.verdict === 'drop') return { ok: false, reason: verdict.reason };
    if (verdict.verdict === 'private-only') {
      // 敏感 / “只告诉你”：留在该 Bot 的私有记忆，不进入共享层。
      void this.writeReflectionMemory(botId, null, {
        kind: 'fact',
        content: candidate.content,
        subject: null,
        source: candidate.source,
        evidenceMessageIds: candidate.evidence,
        confidence: candidate.confidence,
        sensitivity: candidate.sensitivity,
        privateToBot: true,
        validUntilMs: candidate.validUntilMs ?? null,
        evidenceRunId: null,
      });
      return { ok: true, reason: 'kept as bot-private memory' };
    }
    this.#profileStore.insertProposal({
      botId,
      op: 'add',
      payload: {
        category: candidate.category,
        content: candidate.content,
        source: candidate.source,
        evidenceMessageIds: candidate.evidence,
        confidence: candidate.confidence,
        ...(candidate.validUntilMs !== undefined && candidate.validUntilMs !== null
          ? { validUntil: candidate.validUntilMs }
          : {}),
      },
    });
    this.scheduleCuration(candidate.immediate === true);
    return { ok: true, reason: '' };
  }

  /** Retract proposal for one profile item (memory_feedback / forget / recall). */
  submitRetractProposal(botId: string | null, targetItemId: string, immediate: boolean): void {
    this.#profileStore.insertProposal({
      botId,
      op: 'retract',
      targetItemId,
      payload: { targetItemId },
    });
    this.scheduleCuration(immediate);
  }

  /** profile_curation job registration: 60s delay merges proposals (任务 8). */
  scheduleCuration(immediate: boolean): void {
    const delay = this.#deps.curationDelayMs ?? PROFILE_CURATION_DELAY_MS;
    this.#deps.jobs.enqueue({
      type: 'profile_curation',
      payload: {},
      priority: 2,
      dedupeKey: 'profile_curation',
      ...(immediate ? {} : { runAfter: this.#deps.clock.now() + delay }),
    });
    // Dedupe keeps one pending job per key: an immediate request must pull the
    // already-scheduled job forward, not be dropped (forget 立即整理, 任务 8;
    // BR-P07-003).
    if (immediate) {
      const hastened = this.#deps.jobs.hasten('profile_curation', this.#deps.clock.now());
      if (hastened > 0) {
        this.#deps.logger.debug({ hastened }, 'pending curation pulled forward (immediate)');
      }
    }
  }

  // --- tools ---------------------------------------------------------------

  async recall(
    botId: string,
    conversationId: string,
    query: string,
    kind?: MemoryKind | undefined,
  ): Promise<RetrievedMemories> {
    const conversation = this.#deps.conversations.get(conversationId);
    const result = await retrieveRelevant({
      store: this.storeFor(botId),
      refreshStore: () => this.storeFor(botId),
      embedder: this.currentEmbedder(),
      queryText: query,
      filters: {
        isGroup: conversation?.type === 'group',
        now: this.#deps.clock.now(),
      },
      ...(kind !== undefined ? {} : {}),
      rerank: this.#retrievalReranker() ?? undefined,
    });
    if (kind !== undefined) {
      result.items = result.items.filter((item) => item.kind === kind);
      const lines = result.items.map((item) => `- [${item.id}] ${item.content}`);
      result.text =
        lines.length > 0 ? `<relevant_memories>\n${lines.join('\n')}\n</relevant_memories>` : '';
    }
    return result;
  }

  getUserProfile(category?: ProfileCategory | undefined): ProfileItem[] {
    return this.#profileStore.list('active', category);
  }

  listCommitments(botId: string): MemoryItem[] {
    if (!this.#manager.exists(botId)) return [];
    return this.storeFor(botId).commitments();
  }

  /** One memory item (schedule service looks up commitment content/status). */
  getItemFor(botId: string, id: string): MemoryItem | null {
    if (!this.#manager.exists(botId)) return null;
    return this.storeFor(botId).getItem(id);
  }

  #emitCommitmentCreated(botId: string, conversationId: string | null, item: MemoryItem): void {
    if (item.kind !== 'commitment' || item.dueAt === null) return;
    this.#deps.publish?.('memory.commitment_created', {
      botId,
      conversationId: item.originConversationId ?? conversationId,
      item,
    });
  }

  #emitCommitmentInvalidated(botId: string, item: MemoryItem | null): void {
    if (item === null || item.kind !== 'commitment') return;
    this.#deps.publish?.('memory.commitment_invalidated', { botId, commitmentId: item.id });
  }

  /**
   * memory_feedback: wrong → retracted, outdated → superseded; profile items
   * produce a retract proposal for the curation loop instead.
   */
  feedback(
    botId: string,
    itemId: string,
    reason: 'outdated' | 'wrong',
  ): { ok: boolean; message: string } {
    if (itemId.startsWith('prf_')) {
      const item = this.#profileStore.getItem(itemId);
      if (!item) return { ok: false, message: '画像条目不存在' };
      this.submitRetractProposal(botId, itemId, false);
      return { ok: true, message: '已提交画像撤回提案，将由画像整理任务处理' };
    }
    const store = this.storeFor(botId);
    const item = store.getItem(itemId);
    if (!item) return { ok: false, message: '记忆条目不存在' };
    if (reason === 'wrong') {
      store.retract(itemId);
      this.#emitCommitmentInvalidated(botId, item);
    } else store.supersede(itemId);
    return { ok: true, message: reason === 'wrong' ? '已撤回该记忆' : '已标记该记忆为已过时' };
  }

  /** forget: bot memory retracts immediately; profile items go via curation. */
  forget(botId: string, itemIds: string[]): { retracted: string[]; proposed: string[] } {
    const retracted: string[] = [];
    const proposed: string[] = [];
    for (const id of itemIds) {
      if (id.startsWith('prf_')) {
        if (this.#profileStore.getItem(id) !== null) {
          this.submitRetractProposal(botId, id, true);
          proposed.push(id);
        }
        continue;
      }
      if (!this.#manager.exists(botId)) continue;
      const store = this.storeFor(botId);
      if (store.getItem(id) !== null) {
        const item = store.getItem(id);
        store.retract(id);
        this.#emitCommitmentInvalidated(botId, item);
        retracted.push(id);
      }
    }
    return { retracted, proposed };
  }

  /**
   * propose_profile_change (阻塞审批，docs/design/03-bot.md "以消息形式请用户
   * 确认"): parks the run until the user decides; an approved proposal is
   * applied to the bot's own Profile immediately.
   */
  async requestProfileChange(
    identity: RunIdentity,
    changes: Array<{ field: string; value: string }>,
    reason: string,
    signal?: AbortSignal | undefined,
  ): Promise<{ approved: boolean; note: string }> {
    const approvals = this.#deps.approvals;
    if (approvals === undefined) {
      throw new AppError('INTERNAL', '审批服务未就绪');
    }
    const payload = profileChangeApprovalPayloadSchema.parse({ changes, reason });
    const outcome = await approvals.request(
      identity,
      'profile_change',
      payload as Record<string, unknown>,
      {
        ...(signal !== undefined ? { signal } : {}),
      },
    );
    if (outcome.decision !== 'approved') {
      return { approved: false, note: outcome.decision === 'denied' ? '已拒绝' : '已取消' };
    }
    const botId = identity.botId;
    if (botId !== null) {
      const bot = this.#deps.bots.get(botId);
      if (bot !== null) {
        const nextProfile = applyProfileChanges(bot.profile, changes);
        this.#deps.bots.update(botId, nextProfile);
      }
    }
    return { approved: true, note: '' };
  }

  // --- prompt sections --------------------------------------------------------

  /** <user_profile> body: the compiled card, truncated to its budget. */
  profileCardSection(): string {
    const card = this.#profileStore.getCard();
    if (card.content === null || card.content.length === 0) return '';
    return truncateToBudget(card.content, PROFILE_CARD_TOKEN_BUDGET).text;
  }

  /** <my_state> body: due commitments + other-conversation activity titles. */
  myStateSection(botId: string, currentConversationId: string | null): string {
    if (!this.#manager.exists(botId)) return '';
    const activeRuns = this.#runsActive(botId);
    const lines = buildMyState({
      botId,
      currentConversationId,
      now: this.#deps.clock.now(),
      store: this.storeFor(botId),
      activeRuns,
      getConversation: (id) => this.#deps.conversations.get(id),
      getMessage: (id) => this.#deps.messages.getById(id),
    });
    return formatMyState(lines);
  }

  /** <relevant_memories> section for one trigger (empty result = no section). */
  async relevantMemoriesSection(input: {
    botId: string;
    conversationId: string;
    queryText: string;
  }): Promise<string> {
    if (!this.#manager.exists(input.botId)) return '';
    const conversation = this.#deps.conversations.get(input.conversationId);
    const result = await retrieveRelevant({
      store: this.storeFor(input.botId),
      refreshStore: () => this.storeFor(input.botId),
      embedder: this.currentEmbedder(),
      queryText: input.queryText,
      filters: {
        isGroup: conversation?.type === 'group',
        now: this.#deps.clock.now(),
      },
      rerank: this.#retrievalReranker() ?? undefined,
    });
    if (result.items.length === 0) return '';
    return `<relevant_memories>\n${result.text}\n</relevant_memories>`;
  }

  // --- lifecycle hooks (03-data-model.md 删除级联) ------------------------------

  /** Deleting a conversation voids every bot's commitments made in it. */
  onConversationDeleted(conversationId: string, memberBotIds: string[]): void {
    for (const botId of memberBotIds) {
      if (!this.#manager.exists(botId)) continue;
      const store = this.storeFor(botId);
      const voided = store.voidCommitmentsOfConversation(conversationId);
      for (const commitmentId of voided) {
        this.#deps.publish?.('memory.commitment_invalidated', { botId, commitmentId });
      }
      if (voided.length > 0) {
        this.#deps.logger.info(
          { botId, conversationId, voided: voided.length },
          'commitments voided',
        );
      }
    }
  }

  /** Removing a bot from a group voids its commitments made in that group. */
  onGroupMemberRemoved(botId: string, conversationId: string): void {
    if (!this.#manager.exists(botId)) return;
    const voided = this.storeFor(botId).voidCommitmentsOfConversation(conversationId);
    for (const commitmentId of voided) {
      this.#deps.publish?.('memory.commitment_invalidated', { botId, commitmentId });
    }
    if (voided.length > 0) {
      this.#deps.logger.info(
        { botId, conversationId, voided: voided.length },
        'commitments voided',
      );
    }
  }

  // --- consolidation scheduling (任务 9) ---------------------------------------

  /**
   * Registers the post-response reflection job (任务 5): dedupe key
   * `run:{runId}` means a run is reflected on at most once even across
   * restarts. Best-effort background — failures only mark the job.
   */
  registerReflection(input: {
    runId: string;
    botId: string;
    conversationId: string;
    triggerMessageIds: string[];
    batchId: string | null;
    /** Loop 续接 (D56): runs whose process records were replayed into this run. */
    continuedFromRunIds?: string[];
  }): void {
    this.#deps.jobs.enqueue({
      type: 'reflection',
      botId: input.botId,
      conversationId: input.conversationId,
      payload: {
        runId: input.runId,
        triggerMessageIds: input.triggerMessageIds,
        batchId: input.batchId,
        ...(input.continuedFromRunIds !== undefined && input.continuedFromRunIds.length > 0
          ? { continuedFromRunIds: input.continuedFromRunIds }
          : {}),
      },
      priority: 2,
      dedupeKey: `run:${input.runId}`,
    });
  }

  /** Startup + hourly: enqueue the daily consolidation for each due bot. */
  enqueueDueConsolidations(): number {
    const now = this.#deps.clock.now();
    const today = localDateKey(new Date(now), this.#deps.timeZone);
    let scheduled = 0;
    for (const bot of this.#deps.bots.listActive()) {
      if (!this.#manager.exists(bot.id)) continue;
      const store = this.storeFor(bot.id);
      if (store.getMeta('last_consolidation_date') === today) continue;
      const localHour = localHourOf(new Date(now), this.#deps.timeZone);
      if (localHour < CONSOLIDATION_LOCAL_HOUR) continue; // 本地时间 03:00 之后
      const enqueued = this.#deps.jobs.enqueue({
        type: 'memory_consolidation',
        botId: bot.id,
        payload: { day: today },
        priority: 2,
        dedupeKey: `memory_consolidation:${bot.id}:${today}`,
      });
      void enqueued;
      scheduled += 1;
    }
    return scheduled;
  }

  // --- RPC -----------------------------------------------------------------

  listMemory(botId: string): MemoryItem[] {
    if (!this.#manager.exists(botId)) return [];
    return this.storeFor(botId).list();
  }

  /**
   * profile.update / memory.update — the user's direct-edit write path
   * (content edit +「只属于该 Bot」toggle, 任务书任务 13).
   */
  updateMemory(
    botId: string,
    id: string,
    patch: { content?: string; privateToBot?: boolean },
  ): MemoryItem {
    const store = this.storeFor(botId);
    if (store.getItem(id) === null) throw new AppError('NOT_FOUND', `记忆条目 ${id} 不存在`);
    if (patch.content !== undefined) {
      if (containsCredential(patch.content)) {
        throw new AppError('INVALID_INPUT', '内容包含疑似凭据，不会被存储');
      }
      store.updateContent(id, patch.content);
      void this.#syncVector(botId, id, patch.content);
    }
    if (patch.privateToBot !== undefined) store.setPrivateToBot(id, patch.privateToBot);
    return store.getItem(id)!;
  }

  retractMemory(botId: string, id: string): void {
    const store = this.storeFor(botId);
    const item = store.getItem(id);
    if (item === null) throw new AppError('NOT_FOUND', `记忆条目 ${id} 不存在`);
    store.retract(id);
    this.#emitCommitmentInvalidated(botId, item);
  }

  listProfile(): ProfileItem[] {
    return this.#profileStore.list('active');
  }

  /** profile.update RPC: direct user edit (writer path #2, same store API). */
  updateProfile(id: string, patch: { content?: string; category?: ProfileCategory }): ProfileItem {
    const item = this.#profileStore.getItem(id);
    if (!item) throw new AppError('NOT_FOUND', `画像条目 ${id} 不存在`);
    if (patch.content !== undefined) {
      if (containsCredential(patch.content)) {
        throw new AppError('INVALID_INPUT', '内容包含疑似凭据，不会被存储');
      }
      this.#profileStore.updateContent(id, patch.content);
    }
    if (patch.category !== undefined) this.#profileStore.updateCategory(id, patch.category);
    return this.#profileStore.getItem(id)!;
  }

  retractProfile(id: string): void {
    if (this.#profileStore.getItem(id) === null) {
      throw new AppError('NOT_FOUND', `画像条目 ${id} 不存在`);
    }
    this.#profileStore.retract(id);
  }

  profileCard(): { content: string | null; compiledAt: number | null } {
    return this.#profileStore.getCard();
  }

  async #syncVector(botId: string, id: string, content: string): Promise<void> {
    const embedder = this.currentEmbedder();
    if (embedder === null || !embedder.ready()) return;
    try {
      const [vector] = await embedder.embed([content]);
      if (vector === undefined) return;
      this.#rememberDim(embedder, [vector]);
      const store = this.storeFor(botId); // after the await (BR-P07-005)
      await store.ensureVecTable(embedder.id, vector.length);
      const rowid = store.rowidOf(id);
      if (rowid !== null) store.upsertVec(rowid, vector);
    } catch (error) {
      this.#deps.logger.warn(
        { botId, error: error instanceof Error ? error.message : String(error) },
        'vector resync failed',
      );
    }
  }

  /**
   * Recomputes memory_vec for every bot (memory_vec_rebuild job). Throws when
   * the embedder is not ready so the job can defer itself. The dimension is
   * taken from the embed results — a persisted dim may be stale or absent
   * (BR-P07-001: the old `embedder.dim !== null` gate made a vendor source
   * throw forever, deferring the job permanently).
   */
  async rebuildAllVectors(): Promise<{ bots: number; vectors: number }> {
    const embedder = this.currentEmbedder();
    if (embedder === null || !embedder.ready()) {
      throw new AppError('PROVIDER_UNAVAILABLE', '向量来源未就绪');
    }
    let bots = 0;
    let vectors = 0;
    for (const bot of this.#deps.bots.listActive()) {
      if (!this.#manager.exists(bot.id)) continue;
      const entries = this.storeFor(bot.id).allActiveWithRowids();
      const CHUNK = 16;
      for (let i = 0; i < entries.length; i += CHUNK) {
        const chunk = entries.slice(i, i + CHUNK);
        const vectorsForChunk = await embedder.embed(chunk.map((entry) => entry.item.content));
        const first = vectorsForChunk[0];
        if (first === undefined) continue;
        this.#rememberDim(embedder, vectorsForChunk);
        // Re-acquire per chunk: the pool may evict (close) the connection
        // while the embed request is in flight (BR-P07-005).
        const store = this.storeFor(bot.id);
        await store.ensureVecTable(embedder.id, first.length);
        chunk.forEach((entry, index) => {
          const vector = vectorsForChunk[index];
          if (vector !== undefined) store.upsertVec(entry.rowid, vector);
        });
      }
      bots += 1;
      vectors += entries.length;
    }
    return { bots, vectors };
  }

  #evidenceFrom(messages: Message[], runId: string | null): MemoryEvidence[] {
    return messages.map((m) => ({
      messageId: m.id,
      conversationId: m.conversationId,
      runId,
    }));
  }

  /** Bot's active runs; an unavailable runs service means "none". */
  #runsActive(botId: string): Run[] {
    try {
      return this.#deps.runs.listActiveByBot(botId);
    } catch {
      return [];
    }
  }

  #checkContext(): WriteCheckContext {
    return {
      getMessage: (id) => {
        const message = this.#deps.messages.getById(id);
        return message === null
          ? null
          : {
              id: message.id,
              conversationId: message.conversationId,
              // D71：委派代发消息虽是 user 发送者，文本却是另一个 Bot 写的——
              // 不能作为「关于用户」的证据，按 Bot 内容对待。
              senderType: isDelegationProxy(message) ? 'bot' : message.senderType,
              status: message.status,
            };
      },
      botConversationIds: (id) => {
        const ids = new Set<string>();
        // The bot's direct conversation + every group it is currently in.
        for (const conv of this.#deps.conversations.listDirectByBot(id)) ids.add(conv.id);
        try {
          const rows = this.#deps.mainDb
            .prepare('select conversation_id as id from conversation_members where bot_id = ?')
            .all(id) as Array<{ id: string }>;
          for (const row of rows) ids.add(row.id);
        } catch {
          // membership table unavailable in stripped unit setups
        }
        return ids;
      },
    };
  }
}

function parseIsoOrThrow(iso: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    throw new AppError('INVALID_INPUT', `时间格式无效：${iso}（需要 ISO 8601）`);
  }
  return parsed;
}

/** Whitelisted Profile dot-paths a bot may change (design/03-bot.md). */
const PROFILE_FIELD_SETTERS: Record<string, (profile: BotProfile, value: string) => void> = {
  // identity.name 仅被 setup interview（对话式新建）写入；常规审批路径的
  // 白名单是 PROFILE_CHANGE_FIELDS（不含 name），此处只是写入器的全集。
  'identity.name': (profile, value) => {
    profile.identity.name = value;
  },
  'identity.bio': (profile, value) => {
    profile.identity.bio = value;
  },
  'persona.personality': (profile, value) => {
    profile.persona.personality = value;
  },
  'persona.tone': (profile, value) => {
    profile.persona.tone = value;
  },
  'persona.style': (profile, value) => {
    profile.persona.style = value;
  },
  'persona.values': (profile, value) => {
    profile.persona.values = value;
  },
  'persona.sample_dialogues': (profile, value) => {
    profile.persona.sample_dialogues = value;
  },
  'role.expertise': (profile, value) => {
    profile.role.expertise = value;
  },
  'role.responsibilities': (profile, value) => {
    profile.role.responsibilities = value;
  },
};

export function applyProfileChanges(
  profile: BotProfile,
  changes: Array<{ field: string; value: string }>,
): BotProfile {
  const next = structuredClone(profile);
  for (const change of changes) {
    const setter = PROFILE_FIELD_SETTERS[change.field];
    if (setter !== undefined) setter(next, change.value);
  }
  return next;
}

/** D71 proxied user message (origin = 'delegation'): the text was written by another bot. */
function isDelegationProxy(message: Message): boolean {
  return (
    message.kind === 'text' &&
    'origin' in message.content &&
    (message.content as { origin?: string }).origin === 'delegation'
  );
}
