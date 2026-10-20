import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  AppError,
  agentSettingSchema,
  settingsGetOutputSchema,
  browserProfilesListOutputSchema,
  browserProfilesCreateInputSchema,
  browserProfilesCreateOutputSchema,
  browserProfilesRenameInputSchema,
  browserProfileIdInputSchema,
  browserProfilesMutateOutputSchema,
  settingsUpdateInputSchema,
  inkcopHealthOutputSchema,
  inkcopListAgentsOutputSchema,
  providersSetKeyInputSchema,
  providerNameInputSchema,
  providersTestInputSchema,
  providersListOutputSchema,
  okOutputSchema,
  botsListOutputSchema,
  botGetOutputSchema,
  botsCreateInputSchema,
  botsUpdateInputSchema,
  botsAvatarUploadInputSchema,
  botsAvatarUploadOutputSchema,
  botsAvatarDataInputSchema,
  botsAvatarDataOutputSchema,
  botIdInputSchema,
  botsDeletionPreviewOutputSchema,
  interviewStartOutputSchema,
  butlerEnsureInputSchema,
  butlerEnsureOutputSchema,
  butlerAcceptRouteInputSchema,
  butlerAcceptRouteOutputSchema,
  delegationIdInputSchema,
  handoversGetInputSchema,
  handoversGetOutputSchema,
  delegationGetOutputSchema,
  taskGetOutputSchema,
  effectsListOutputSchema,
  taskIdInputSchema,
  tasksActiveInputSchema,
  tasksActiveOutputSchema,
  tasksAnswerInputSchema,
  interviewAnswerInputSchema,
  interviewAnswerOutputSchema,
  interviewAnswerPathInputSchema,
  interviewAnswerPathOutputSchema,
  conversationsListOutputSchema,
  conversationGetInputSchema,
  conversationGetOutputSchema,
  conversationsOpenDirectInputSchema,
  conversationsOpenDirectOutputSchema,
  conversationsDeleteInputSchema,
  conversationsDeleteOutputSchema,
  conversationsMarkReadInputSchema,
  conversationsMarkReadOutputSchema,
  conversationIdInputSchema,
  conversationsMembersOutputSchema,
  projectsCreateInputSchema,
  projectsCreateOutputSchema,
  projectsSetLeadInputSchema,
  projectsSetLeadOutputSchema,
  projectsUpdateInputSchema,
  projectsUpdateOutputSchema,
  projectsAddMembersInputSchema,
  projectsRemoveMemberInputSchema,
  episodesGetInputSchema,
  episodesGetOutputSchema,
  episodesResumeInputSchema,
  episodesResumeOutputSchema,
  episodesStopInputSchema,
  episodesStopOutputSchema,
  messagesListInputSchema,
  messagesListOutputSchema,
  messagesEditInputSchema,
  messagesSendInputSchema,
  messagesSendOutputSchema,
  attachmentsUploadInputSchema,
  attachmentsUploadOutputSchema,
  attachmentsGetInputSchema,
  attachmentsGetOutputSchema,
  attachmentsStatusInputSchema,
  attachmentsStatusOutputSchema,
  attachmentsDetachInputSchema,
  attachmentsDetachOutputSchema,
  mcpRemoveSecretInputSchema,
  mcpSetSecretInputSchema,
  mcpTestInputSchema,
  mcpTestOutputSchema,
  mcpToolRisksInputSchema,
  mcpToolRisksOutputSchema,
  webSearchTestInputSchema,
  webSearchTestOutputSchema,
  webSearchSetKeyInputSchema,
  webSearchRemoveKeyInputSchema,
  runIdInputSchema,
  runsCancelOutputSchema,
  runsRetryInputSchema,
  runsRetryOutputSchema,
  runsSetupDismissedOutputSchema,
  runsDismissFailureOutputSchema,
  runsStepsOutputSchema,
  runsListInputSchema,
  runsListOutputSchema,
  sandboxStatusInputSchema,
  sandboxStatusOutputSchema,
  sandboxWslStatusOutputSchema,
  sandboxWslSkipOutputSchema,
  approvalsListInputSchema,
  approvalsListOutputSchema,
  approvalsDecideInputSchema,
  approvalsDecideOutputSchema,
  grantsListInputSchema,
  grantsListOutputSchema,
  grantIdInputSchema,
  allowlistListOutputSchema,
  allowlistAddInputSchema,
  allowlistUpdateInputSchema,
  unattendedGetOutputSchema,
  unattendedEnableInputSchema,
  unattendedSummaryInputSchema,
  unattendedSummaryOutputSchema,
  workdirsListOutputSchema,
  workdirsGetInputSchema,
  workdirsGetOutputSchema,
  workdirsSelectInputSchema,
  workdirsSelectOutputSchema,
  workdirsUnbindInputSchema,
  workdirsUpdateInputSchema,
  workdirsRemoveInputSchema,
  workdirsDiffInputSchema,
  workdirsDiffOutputSchema,
  workdirsRevertInputSchema,
  workdirsRevertOutputSchema,
  workdirsRevokeLeaseInputSchema,
  workdirsRevokeLeaseOutputSchema,
  environmentListOutputSchema,
  environmentInstallIdInputSchema,
  environmentReinstallOutputSchema,
  memoryListInputSchema,
  memoryListOutputSchema,
  memoryUpdateInputSchema,
  memoryRetractInputSchema,
  profileListOutputSchema,
  profileUpdateInputSchema,
  profileRetractInputSchema,
  profileCardOutputSchema,
  usageSummaryInputSchema,
  usageSummaryOutputSchema,
  embeddingStatusOutputSchema,
  embeddingConfigureInputSchema,
  skillsListInputSchema,
  skillsListOutputSchema,
  skillsImportInputSchema,
  skillsImportOutputSchema,
  skillsSetNameInputSchema,
  skillNameInputSchema,
  skillsHistoryOutputSchema,
  skillsRollbackInputSchema,
  skillsReadOutputSchema,
  skillsPresetsListInputSchema,
  skillsPresetsListOutputSchema,
  skillsPresetsInstallInputSchema,
  skillsPresetsInstallOutputSchema,
  skillsPurgeMissingInputSchema,
  skillsPurgeMissingOutputSchema,
  wikiTreeOutputSchema,
  wikiPageInputSchema,
  wikiPageOutputSchema,
  wikiSearchInputSchema,
  wikiSearchOutputSchema,
  wikiHistoryOutputSchema,
  wikiRollbackInputSchema,
  wikiRollbackOutputSchema,
  wikiDeletePageInputSchema,
  wikiDeletePageOutputSchema,
  wikiOwnerInputSchema,
  wikiSourcesOutputSchema,
  wikiAddSourceInputSchema,
  wikiAddSourceOutputSchema,
  wikiDeleteSourceInputSchema,
  wikiDeleteSourceOutputSchema,
  todosListInputSchema,
  todosListOutputSchema,
  todosIdInputSchema,
  todosGetOutputSchema,
  todosCreateInputSchema,
  todosUpdateInputSchema,
  todosWriteOutputSchema,
  todosTransitionOutputSchema,
  memosListInputSchema,
  memosListOutputSchema,
  memosIdInputSchema,
  memosCreateInputSchema,
  memosUpdateInputSchema,
  memosMemoOutputSchema,
  schedulesListInputSchema,
  schedulesListOutputSchema,
  schedulesCancelInputSchema,
  schedulesOfferInputSchema,
  schedulesAcceptOfferOutputSchema,
  schedulesDeclineOfferOutputSchema,
  schedulesCancelOutputSchema,
  watchesListInputSchema,
  watchesListOutputSchema,
  watchIdInputSchema,
  watchGetOutputSchema,
  watchMutateOutputSchema,
  stickiesListInputSchema,
  stickiesListOutputSchema,
  stickiesCreateInputSchema,
  stickiesCreateOutputSchema,
  stickiesUpdateInputSchema,
  stickiesUpdateOutputSchema,
  stickiesDeleteInputSchema,
  stickiesDeleteOutputSchema,
  mediaGenerateImageInputSchema,
  mediaGenerateImageOutputSchema,
  mediaSynthesizeSpeechInputSchema,
  mediaSynthesizeSpeechOutputSchema,
  mediaTranscribeSpeechInputSchema,
  mediaTranscribeSpeechOutputSchema,
  mediaGenerateVideoInputSchema,
  mediaGenerateVideoOutputSchema,
  mediaVideoStatusInputSchema,
  mediaVideoStatusOutputSchema,
  mediaRerankInputSchema,
  mediaRerankOutputSchema,
  mediaUnderstandImageInputSchema,
  mediaUnderstandImageOutputSchema,
  mergePatchOnto,
  type Conversation,
  type Settings,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { WatchService } from '../watch/service.js';
import type { MemoService } from '../workbench/memo-service.js';
import type { TodoService } from '../workbench/todo-service.js';
import type { RpcMethodSpec } from './server.js';
import type { WslStatusReport } from '../sandbox/wsl/setup.js';
import { localDateKey } from '../memory/local-date.js';
import { assertAgentSelectable } from '../agent/external/catalog.js';
import { bindAgentMethods } from './agents-bindings.js';
import { oauthBindingChanged } from '../apps/disconnect.js';
import { isCatalogConnectionId } from '../apps/connection-store.js';
import { bindAppsMethods } from './apps-bindings.js';
import { bindMailMethods } from './mail-bindings.js';
import { bindAppsRuntimeMethods } from './apps-runtime-bindings.js';
import { bindMcpbMethods } from './mcpb-bindings.js';
import { bindAppsUiMethods } from './apps-ui-bindings.js';
import { bindWidgetsUiMethods } from './widgets-ui-bindings.js';
import { bindAppsConnectionMethods } from './apps-connections-bindings.js';
import { bindAppsSkillsMethods } from './apps-skills-bindings.js';
import {
  bindSettingsCatalogMethods,
  changedSettingsPaths,
  itemIdsForSettingsPaths,
  withSettingsChangedEvents,
} from './settings-bindings.js';
import { applyBotProfileUpdate, createPermissionEffects } from '../settings/bot-profile-update.js';
import type { LoopType, WikiOwner } from '@kepcup/shared';
import {
  InkcopHttpError,
  InkcopLocalBridgeClient,
  InkcopOfflineError,
  inkcopOfflineTip,
} from '../inkcop/client.js';

const voidInput = z.void();

/** P12-B wizard output for hosts with nothing to prepare (non-Windows, no
 * e2e fixture): the wizard renders the platform's enhanced entry instead. */
const WSL_NOT_APPLICABLE = {
  applicable: false,
  phase: 'idle',
  skipped: false,
  install: 'not_installed',
  distro: 'absent',
} as const;

/** Maps the state-machine report to the wizard RPC output shape. */
function wslStatusOutput(
  report: WslStatusReport,
  skipped: boolean,
): z.infer<typeof sandboxWslStatusOutputSchema> {
  return {
    applicable: true,
    phase: report.phase,
    skipped,
    install: report.state.install.kind,
    distro: report.state.distro.kind,
    ...(report.reason !== undefined ? { reason: report.reason } : {}),
    ...(report.fixHint !== undefined ? { fixHint: report.fixHint } : {}),
  };
}
/** Typed wrapper keeping handler input/output aligned with the schemas. */
function method<I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O,
  handle: (value: z.infer<I>) => Promise<z.infer<O>>,
): RpcMethodSpec {
  return {
    input,
    output,
    handle: handle as (value: unknown) => Promise<unknown>,
  };
}

/**
 * Binds the P01 RPC methods to the domain services and the orchestrator.
 * Handlers stay thin: validation happens in the server layer, business rules
 * live in the services.
 */
export function bindAppMethods(services: CoreServices): Record<string, RpcMethodSpec> {
  const domain = services.domain!;
  const orchestrator = services.orchestrator!;
  const publish = services.events.emit.bind(services.events);
  /**
   * D92 T1b WP9: a project wiki owner must be a live project conversation —
   * anything else is NOT_FOUND (bot owners need no lookup).
   */
  const wikiOwnerOf = (owner: WikiOwner): WikiOwner => {
    if (owner.kind === 'project') {
      const conversation = domain.conversations.get(owner.id);
      if (conversation === null || conversation.type !== 'project') {
        throw new AppError('NOT_FOUND', '项目组不存在');
      }
    }
    return owner;
  };
  /**
   * W3 / W8：收回授权 → 中断受影响的任务并推「已中断 N 个进行中的任务」。与设置目录的条目适配器
   * 共用同一份实现（settings/bot-profile-update.ts）。
   */
  const permissionEffects = createPermissionEffects({
    revocations: domain.revocations,
    publish,
    listBots: () => domain.bots.listActive(),
    mcpRiskOf: (serverId, toolName) =>
      services.mcp?.riskOf(serverId, toolName).risk ?? 'destructive',
    mcpKnownTools: (serverId) => services.mcp?.knownToolNames(serverId) ?? null,
  });
  const publishInterrupted = permissionEffects.publishInterrupted;
  const revokeMcp = permissionEffects.revokeMcp;
  /** `bots.update` 与设置目录 Bot 条目共用的写入路径（校验 → 写 → 锁外中断 / 收回授权）。 */
  const botProfileDeps = {
    bots: domain.bots,
    settings: domain.settings,
    agentCatalog: () => services.agents?.catalog() ?? [],
    browserProfiles: domain.browserProfiles,
    effects: permissionEffects,
    publish,
  };
  // P12-B: one in-flight preparation at a time (per services instance) — the
  // wizard reopening mid-import shares the running state-machine pass.
  let wslPrepareInflight: Promise<WslStatusReport> | null = null;

  const conversationView = (conversation: Conversation): Conversation => ({
    ...conversation,
    // D75 §2.4.3: only user-visible rows count (private task entries and
    // internal events advance last_seq but are never shown).
    unreadCount:
      conversation.lastSeq > conversation.lastReadSeq
        ? domain.messages.countVisibleAfter(conversation.id, conversation.lastReadSeq)
        : 0,
    runningBotIds: orchestrator.runningBotIds(conversation.id),
    bot:
      conversation.directBotId !== null
        ? (domain.bots.get(conversation.directBotId) ?? null)
        : null,
    ...(conversation.type === 'project'
      ? {
          memberPreviews: domain.projects.memberPreviews(conversation.id),
        }
      : {}),
  });

  /**
   * 对话内应用设置：设置页的整对象保存与目录适配器的条目级写入共用一把写锁（settings/write-lock.ts），
   * 成功后按前后差异补发 `settings.changed{itemIds}`。
   */
  const settingsCatalog = services.settingsCatalog;
  const publishSettingsChanged = (itemIds: readonly string[]): void => {
    if (settingsCatalog !== null) settingsCatalog.publishChanged(itemIds);
    else if (itemIds.length > 0) publish('settings.changed', { itemIds: [...new Set(itemIds)] });
  };
  const settingsLocked = <T>(task: () => T | Promise<T>): Promise<T> =>
    settingsCatalog !== null ? settingsCatalog.runLocked(task) : Promise.resolve().then(task);

  const methods: Record<string, RpcMethodSpec> = {
    'settings.get': method(voidInput, settingsGetOutputSchema, async () => domain.settings.get()),
    // 写锁只罩住「读最新 → 合并 → 写回」的同步关键区；MCP 断连 / 清理 / 撤销授权等网络副作用在锁外。
    // 设置页按整对象保存（capabilityModels / webSearch / mcpServers 由表单快照整体提交）：渲染层带上
    // 补丁出发时的快照 `base`，锁内与最新设置三方合并（mergePatchOnto）——表单没改的字段保留最新值，
    // 过期表单不再覆盖 Bot 直改、设置卡或别处刚做的修改。不带 `base` 的老调用方仍是整体覆盖。
    'settings.update': method(
      settingsUpdateInputSchema,
      settingsGetOutputSchema,
      async (rawInput) => {
        const previous = domain.settings.get();
        const { base, ...patch } = rawInput;
        /** 补丁按最新设置三方合并后的样子（`base` 缺省时就是补丁本身）。 */
        const resolve = (latest: Settings): typeof patch =>
          mergePatchOnto(patch, base, latest as unknown as Record<string, unknown>);
        const input = resolve(previous);
        for (const agentId of [input.defaultAgentId, input.backgroundAgentId]) {
          if (
            agentId !== undefined &&
            agentId.length > 0 &&
            !(services.agents?.catalog() ?? []).some((entry) => entry.id === agentId)
          ) {
            throw new AppError('INVALID_INPUT', `智能体「${agentId}」不在目录中`);
          }
        }
        if (input.mcpServers !== undefined) {
          // D73 P1: the `conn_` id prefix is reserved for catalog connections (McpService uses the
          // connection id as the synthesized server's id), so a custom server may not take it.
          const reserved = input.mcpServers.find((server) => isCatalogConnectionId(server.id));
          if (reserved !== undefined) {
            throw new AppError(
              'INVALID_INPUT',
              `MCP 服务器 ID 不能以「conn_」开头（保留给连接应用）：${reserved.id}`,
            );
          }
          // D73: an OAuth server switched to none/headers, or pointed at another URL, must
          // lose its connection first (revoke + clear the vault) — the tokens are bound to
          // the old URL. Done before the replacement so no run can pair old tokens with the
          // new URL; an in-flight interactive flow for it is cancelled too.
          for (const server of previous.mcpServers) {
            const after = input.mcpServers.find((entry) => entry.id === server.id);
            if (after !== undefined && oauthBindingChanged(server, after)) {
              services.apps?.flows.cancelForServer(server.id);
            }
          }
          await services.appRuntime?.disconnector.reconcileServers(
            previous.mcpServers,
            input.mcpServers,
          );
        }
        // 合并一律基于锁内读到的**最新**设置（上面有 await：期间 core 自有字段，如
        // `apps.localConnectors`、agents 的安装状态，可能被别的路径改过，拿旧快照回写会丢改动）。
        const { current, next } = await settingsLocked(() => {
          const current = domain.settings.get();
          const {
            onboarding: onboardingPatch,
            experimental: experimentalPatch,
            apps: appsPatch,
            agents: agentsPatch,
            backgroundTasks: backgroundTasksPatch,
            inkcopLocalCollab: inkcopLocalCollabPatch,
            ...rest
          } = resolve(current);
          const latestApps = current.apps;
          // P13 任务 4: the onboarding patch is partial; store the merged state so
          // a step writing one flag never erases the others.
          const next = domain.settings.update({
            ...rest,
            ...(onboardingPatch !== undefined
              ? { onboarding: { ...current.onboarding, ...onboardingPatch } }
              : {}),
            // agents: merged per id onto the stored value (never a whole-map
            // overwrite: a stale renderer snapshot must not undo a finished
            // install). installedVersion / source are core-owned (agents.*).
            ...(agentsPatch !== undefined
              ? {
                  agents: {
                    ...current.agents,
                    ...Object.fromEntries(
                      Object.entries(agentsPatch).map(([id, value]) => [
                        id,
                        agentSettingSchema.parse({ ...(current.agents[id] ?? {}), ...value }),
                      ]),
                    ),
                  },
                }
              : {}),
            ...(experimentalPatch !== undefined
              ? {
                  experimental: {
                    externalAgents:
                      experimentalPatch.externalAgents ?? current.experimental.externalAgents,
                  },
                }
              : {}),
            // D73 P2: only `developerMode` is renderer-writable; the other apps fields are core-owned.
            ...(appsPatch !== undefined
              ? {
                  apps: {
                    ...latestApps,
                    developerMode: appsPatch.developerMode ?? latestApps.developerMode,
                    taintGuard: appsPatch.taintGuard ?? latestApps.taintGuard,
                    directorySync: appsPatch.directorySync ?? latestApps.directorySync,
                  },
                }
              : {}),
            // P6 后台任务：部分 patch，与已存值合并。
            ...(backgroundTasksPatch !== undefined
              ? { backgroundTasks: { ...current.backgroundTasks, ...backgroundTasksPatch } }
              : {}),
            // InkCop 同机协作 v0.2：部分 patch。
            ...(inkcopLocalCollabPatch !== undefined
              ? {
                  inkcopLocalCollab: {
                    ...current.inkcopLocalCollab,
                    ...inkcopLocalCollabPatch,
                  },
                }
              : {}),
          });
          return { current, next };
        });
        services.scheduler?.setConcurrency(next.providerConcurrency);
        if (input.mcpServers !== undefined) {
          // D73 P1: a server dropped by this replacement (not via `mcp.removeServer`) takes its
          // tool-lock rows, connection row and tokens with it — no orphans left behind. Only a
          // server that is really gone from the saved settings is cleaned.
          for (const server of previous.mcpServers) {
            if (next.mcpServers.some((entry) => entry.id === server.id)) continue;
            await services.appRuntime?.disconnector.removeCustomServer(server.id);
            await services.mcpb?.afterServerRemoved(previous.mcpServers, server.id);
          }
        }
        if (input.mcpServers !== undefined) {
          // W3（D78）: server switched off / removed, autoApprove on → off, a tool
          // policy auto → ask or disabled — the bots using it lose their running tasks.
          permissionEffects.revokeMcpServerChanges(previous.mcpServers, next.mcpServers);
        }
        if (input.launchAtLogin !== undefined && input.launchAtLogin !== previous.launchAtLogin) {
          // P13 任务 3: the main process applies the OS login item on this event
          // (platform port B → setLoginItemSettings / XDG autostart).
          publish('platform.autostart', { enabled: next.launchAtLogin });
        }
        publishSettingsChanged(
          itemIdsForSettingsPaths(
            changedSettingsPaths(
              current as unknown as Record<string, unknown>,
              next as unknown as Record<string, unknown>,
              Object.keys(patch),
            ),
          ),
        );
        return next;
      },
    ),

    'providers.list': method(voidInput, providersListOutputSchema, async () => ({
      providers: domain.providers.list(),
    })),
    'providers.setKey': method(providersSetKeyInputSchema, okOutputSchema, async (input) => {
      domain.providers.setKey(input.provider, input.key);
      return { ok: true as const };
    }),
    'providers.removeKey': method(providerNameInputSchema, okOutputSchema, async (input) => {
      domain.providers.removeKey(input.provider);
      return { ok: true as const };
    }),
    'providers.test': method(providersTestInputSchema, okOutputSchema, async (input) => {
      await domain.providers.test(input.provider, input.model, input.capability, input.keyOverride);
      return { ok: true as const };
    }),

    // --- 统一媒体调用：网关按模型引用的厂商自动路由 -------------------------
    'media.generateImage': method(
      mediaGenerateImageInputSchema,
      mediaGenerateImageOutputSchema,
      async (input) => services.media!.generateImage(input),
    ),
    'media.synthesizeSpeech': method(
      mediaSynthesizeSpeechInputSchema,
      mediaSynthesizeSpeechOutputSchema,
      async (input) => services.media!.synthesizeSpeech(input),
    ),
    'media.transcribeSpeech': method(
      mediaTranscribeSpeechInputSchema,
      mediaTranscribeSpeechOutputSchema,
      async (input) =>
        // 语音输入（26）：用户前台行为，不属于任何 Bot / 对话。
        services.media!.transcribeSpeech(input, { loopType: 'voice_input' }),
    ),
    'media.generateVideo': method(
      mediaGenerateVideoInputSchema,
      mediaGenerateVideoOutputSchema,
      async (input) => services.media!.generateVideo(input),
    ),
    'media.videoStatus': method(
      mediaVideoStatusInputSchema,
      mediaVideoStatusOutputSchema,
      async (input) => services.media!.videoStatus(input.provider, input.taskId),
    ),
    'media.rerank': method(mediaRerankInputSchema, mediaRerankOutputSchema, async (input) =>
      services.media!.rerank(input),
    ),
    'media.understandImage': method(
      mediaUnderstandImageInputSchema,
      mediaUnderstandImageOutputSchema,
      async (input) => services.media!.understandImage(input),
    ),

    // --- MCP（docs/design/23-mcp-and-subagent.md D65） ------------------------
    'mcp.test': method(mcpTestInputSchema, mcpTestOutputSchema, async (input) => {
      if (!services.mcp) throw new AppError('NOT_IMPLEMENTED', 'MCP 模块未就绪');
      return services.mcp.testServer(input.server, input.secretValues);
    }),
    'mcp.setSecret': method(mcpSetSecretInputSchema, okOutputSchema, async (input) => {
      if (!services.mcp) throw new AppError('NOT_IMPLEMENTED', 'MCP 模块未就绪');
      services.domain!.secrets.setValue(
        `mcp:${input.serverId}:${input.kind}:${input.name}`,
        input.value,
      );
      return { ok: true as const };
    }),
    'mcp.removeSecret': method(mcpRemoveSecretInputSchema, okOutputSchema, async (input) => {
      if (!services.mcp) throw new AppError('NOT_IMPLEMENTED', 'MCP 模块未就绪');
      services.domain!.secrets.removeValue(`mcp:${input.serverId}:${input.kind}:${input.name}`);
      return { ok: true as const };
    }),
    // W5：设置页逐工具策略——工具名、风险档与判定来源。
    'mcp.toolRisks': method(mcpToolRisksInputSchema, mcpToolRisksOutputSchema, async (input) => {
      if (!services.mcp) throw new AppError('NOT_IMPLEMENTED', 'MCP 模块未就绪');
      return services.mcp.toolRisks(input.serverId);
    }),

    // --- 联网检索（docs/design/21-web-search.md） ---------------------------
    'websearch.test': method(webSearchTestInputSchema, webSearchTestOutputSchema, async (input) => {
      if (!services.search) throw new AppError('NOT_IMPLEMENTED', '检索模块未就绪');
      return services.search.test(input.provider, input.key);
    }),
    'websearch.setKey': method(webSearchSetKeyInputSchema, okOutputSchema, async (input) => {
      if (!services.search) throw new AppError('NOT_IMPLEMENTED', '检索模块未就绪');
      services.search.setKey(input.provider, input.key);
      return { ok: true as const };
    }),
    'websearch.removeKey': method(webSearchRemoveKeyInputSchema, okOutputSchema, async (input) => {
      if (!services.search) throw new AppError('NOT_IMPLEMENTED', '检索模块未就绪');
      services.search.removeKey(input.provider);
      return { ok: true as const };
    }),

    'inkcop.health': method(z.object({}).default({}), inkcopHealthOutputSchema, async () => {
      const client = new InkcopLocalBridgeClient();
      try {
        const health = await client.health();
        return {
          online: true as const,
          version: health.version,
          app: health.app,
        };
      } catch (error) {
        if (error instanceof InkcopOfflineError || error instanceof InkcopHttpError) {
          return {
            online: false as const,
            tip: inkcopOfflineTip(null),
          };
        }
        throw error;
      }
    }),
    'inkcop.listAgents': method(z.object({}).default({}), inkcopListAgentsOutputSchema, async () => {
      const client = new InkcopLocalBridgeClient();
      try {
        await client.health();
      } catch (error) {
        if (error instanceof InkcopOfflineError || error instanceof InkcopHttpError) {
          return { online: false as const, agents: [], tip: inkcopOfflineTip(null) };
        }
        throw error;
      }
      try {
        const listed = await client.listAgents();
        return { online: true as const, agents: listed.agents };
      } catch (error) {
        // Server not yet on v0.2: fall back to main_agent stub so UI can still bind.
        if (error instanceof InkcopHttpError && (error.status === 404 || error.status === 501)) {
          return {
            online: true as const,
            agents: [{ key: 'main_agent', name: '主智能体', kind: 'main' as const }],
            tip: 'InkCop 尚未提供 /v1/agents，暂仅列出主智能体',
          };
        }
        if (error instanceof InkcopOfflineError) {
          return { online: false as const, agents: [], tip: inkcopOfflineTip(null) };
        }
        throw error;
      }
    }),
    'bots.list': method(voidInput, botsListOutputSchema, async () => ({
      bots: domain.bots.listActive(),
    })),
    'bots.get': method(botIdInputSchema, botGetOutputSchema, async (input) => ({
      bot: domain.bots.get(input.id),
    })),
    'bots.create': method(botsCreateInputSchema, botGetOutputSchema, async (input) => {
      assertAgentSelectable(
        domain.settings.get(),
        services.agents?.catalog() ?? [],
        input.profile.runtime.agent.id,
      );
      // The setup interview drives save_profile / finish_setup host tools that
      // an external agent never receives (P1/P2) — it would stay interviewing.
      if (input.interview && input.profile.runtime.agent.id.length > 0) {
        throw new AppError(
          'INVALID_INPUT',
          '对话式新建暂不支持外部智能体：请先用内置模型创建，再切换',
        );
      }
      // W8: only an existing shared browser profile ('' = private).
      domain.browserProfiles.assertSelectable(input.profile.runtime.browser_profile);
      const bot = domain.bots.create(input.profile, {
        interview: input.interview,
        // InkCop 同机桥 Bot 不走默认外部 Agent（契约：不暴露为外部智能体）。
        skipDefaultAgent:
          input.skipDefaultAgent === true ||
          input.profile.runtime.message_transport === 'inkcop-local',
      });
      publish('bot.updated', { bot });
      return { bot };
    }),
    /**
     * 对话式创建第二步（UI 改版）：打开直聊并确定性下发问候 + 固定首问卡片
     *（含预置候选答案），不触发 LLM run——零延迟出题；用户作答后才由
     * orchestrator 起第一个响应 run。
     */
    /**
     * 管家（D70）：确保唯一管家存在并打开其私聊。新用户引导完成时以
     * interview=true 调用（管家进入组队访谈）；幂等，已存在则原样返回。
     */
    'butler.ensure': method(butlerEnsureInputSchema, butlerEnsureOutputSchema, async (input) =>
      orchestrator.ensureButler(input.interview === true ? { interview: true } : {}),
    ),
    'butler.acceptRoute': method(
      butlerAcceptRouteInputSchema,
      butlerAcceptRouteOutputSchema,
      async (input) => ({ message: orchestrator.acceptRoute(input.messageId) }),
    ),
    'bots.interview.start': method(botIdInputSchema, interviewStartOutputSchema, async (input) => {
      const bot = domain.bots.getOrThrow(input.id);
      if (bot.status !== 'active') {
        throw new AppError('CONVERSATION_READ_ONLY', `Bot ${input.id} has been deleted`);
      }
      if (bot.setupState !== 'interviewing') {
        throw new AppError('INVALID_INPUT', `Bot ${input.id} is not in setup interview`);
      }
      const { conversation, created } = domain.conversations.openDirect(bot.id);
      if (created) publish('conversation.updated', { conversation });
      orchestrator.beginSetupInterview(bot.id, conversation.id);
      return { conversationId: conversation.id };
    }),
    /**
     * 初始化问询的用户回答（UI 改版）：不走草稿/普通气泡——落一条带
     * setupAnswer 标记的用户消息并触发响应 run，渲染层由问题卡片展示回答。
     */
    'bots.interview.answer': method(
      interviewAnswerInputSchema,
      interviewAnswerOutputSchema,
      async (input) => {
        const message = orchestrator.answerSetupQuestion(input.conversationId, input.text);
        return { message };
      },
    ),
    /**
     * 访谈目录卡作答（19/D59）：选择目录则先绑定 workdir，然后把首答与目录
     * 决定一起投递给 Bot（首个响应 run 开始）。
     */
    'bots.interview.answerPath': method(
      interviewAnswerPathInputSchema,
      interviewAnswerPathOutputSchema,
      async (input) => {
        const message = orchestrator.answerSetupPath(input.conversationId, input.path);
        return { message };
      },
    ),
    // 与设置目录的 Bot 条目适配器同一条写入路径（settings/bot-profile-update.ts）：校验 → 写 →
    // bot.updated；锁外再中断任务 / 关页面 / 收回 MCP 与连接授权。带 `base` 时与最新 Profile
    // 三方合并，右栏过期的整表单不再覆盖 Bot 刚直改的字段。
    'bots.update': method(botsUpdateInputSchema, botGetOutputSchema, async (input) => {
      const update = await settingsLocked(() =>
        applyBotProfileUpdate(botProfileDeps, input.id, input.profile, input.base),
      );
      publishSettingsChanged(update.changedItemIds);
      const warnings = await update.settle();
      if (warnings.length > 0) {
        services.logger.warn({ botId: input.id, warnings }, 'bots.update side effects failed');
      }
      return { bot: update.bot };
    }),
    'bots.avatar.upload': method(
      botsAvatarUploadInputSchema,
      botsAvatarUploadOutputSchema,
      async (input) => {
        const bot = domain.avatars.upload(
          input.id,
          input.mime,
          Buffer.from(input.bytesBase64, 'base64'),
        );
        publish('bot.updated', { bot });
        return { bot };
      },
    ),
    'bots.avatar.data': method(
      botsAvatarDataInputSchema,
      botsAvatarDataOutputSchema,
      async (input) => {
        const data = domain.avatars.read(input.id, input.file);
        return { mime: data.mime, base64: data.base64 };
      },
    ),
    'bots.delete': method(botIdInputSchema, okOutputSchema, async (input) => {
      // Captured BEFORE deleteBot: the cascade drops the member rows, so the
      // affected projects are unenumerable afterwards — their open member lists
      // still need the push (deleted bot leaves the cards / @ popup and its
      // history messages render under its id, docs/design/01-conversation.md).
      const projectIds = domain.lifecycle.projectConversationIdsOf(input.id);
      await domain.lifecycle.deleteBot(input.id);
      publish('bot.deleted', { id: input.id });
      // Direct conversations just turned read-only; push their new state.
      for (const conversation of domain.conversations.listDirectByBot(input.id)) {
        publish('conversation.updated', { conversation });
      }
      for (const conversationId of projectIds) {
        const conversation = domain.conversations.get(conversationId);
        if (conversation) publish('conversation.updated', { conversation });
      }
      return { ok: true as const };
    }),
    'bots.deletionPreview': method(
      botIdInputSchema,
      botsDeletionPreviewOutputSchema,
      async (input) => domain.lifecycle.deletionPreview(input.id),
    ),

    'conversations.list': method(voidInput, conversationsListOutputSchema, async () => {
      // 左栏预览（每个会话最后一条可预览消息：文本或卡片摘要）随列表一并
      // 下发：启动时不逐个打开会话也能看到「最后一条消息」。
      const previews = domain.messages.latestPreviewByConversation();
      return {
        conversations: domain.conversations.list().map((conversation) => {
          const view = conversationView(conversation);
          const text = previews[conversation.id];
          return text === undefined ? view : { ...view, lastMessageText: text };
        }),
      };
    }),
    'conversations.get': method(
      conversationGetInputSchema,
      conversationGetOutputSchema,
      async (input) => {
        const conversation = domain.conversations.get(input.id);
        return { conversation: conversation ? conversationView(conversation) : null };
      },
    ),
    'conversations.openDirect': method(
      conversationsOpenDirectInputSchema,
      conversationsOpenDirectOutputSchema,
      async (input) => {
        domain.bots.getOrThrow(input.botId);
        const { conversation, created } = domain.conversations.openDirect(input.botId);
        if (created) publish('conversation.updated', { conversation });
        return { conversation: conversationView(conversation), created };
      },
    ),
    'conversations.delete': method(
      conversationsDeleteInputSchema,
      conversationsDeleteOutputSchema,
      async (input) => {
        await domain.lifecycle.deleteConversation(input.id);
        publish('conversation.deleted', { id: input.id });
        return { ok: true as const };
      },
    ),
    'conversations.markRead': method(
      conversationsMarkReadInputSchema,
      conversationsMarkReadOutputSchema,
      async (input) => {
        domain.conversations.markRead(input.conversationId, input.seq);
        const conversation = domain.conversations.get(input.conversationId);
        if (conversation) publish('conversation.updated', { conversation });
        return { ok: true as const };
      },
    ),
    'conversations.members': method(
      conversationIdInputSchema,
      conversationsMembersOutputSchema,
      async (input) => ({ members: domain.projects.members(input.conversationId) }),
    ),

    'projects.create': method(
      projectsCreateInputSchema,
      projectsCreateOutputSchema,
      async (input) => ({ conversation: domain.projects.create(input) }),
    ),
    'projects.setLead': method(
      projectsSetLeadInputSchema,
      projectsSetLeadOutputSchema,
      async (input) => ({
        conversation: domain.projects.setLead(input.conversationId, input.botId),
      }),
    ),
    'projects.update': method(
      projectsUpdateInputSchema,
      projectsUpdateOutputSchema,
      async (input) => ({
        conversation: domain.projects.update(input.conversationId, {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.goal !== undefined ? { goal: input.goal } : {}),
        }),
      }),
    ),
    'projects.addMembers': method(
      projectsAddMembersInputSchema,
      conversationsMembersOutputSchema,
      async (input) => ({
        members: await domain.projects.addMembers(input.conversationId, input.botIds),
      }),
    ),
    'projects.removeMember': method(
      projectsRemoveMemberInputSchema,
      okOutputSchema,
      async (input) => {
        await domain.projects.removeMember(input.conversationId, input.botId);
        return { ok: true as const };
      },
    ),
    'episodes.get': method(episodesGetInputSchema, episodesGetOutputSchema, async (input) => {
      const episode = orchestrator.episodes.get(input.id);
      if (episode === null) throw new AppError('NOT_FOUND', `协作回合 ${input.id} 不存在`);
      return { episode };
    }),
    'episodes.resume': method(
      episodesResumeInputSchema,
      episodesResumeOutputSchema,
      async (input) => ({
        episode: orchestrator.episodes.resume(input.id),
      }),
    ),
    'episodes.stop': method(episodesStopInputSchema, episodesStopOutputSchema, async (input) => ({
      episode: orchestrator.episodes.stop(input.id),
    })),

    'messages.list': method(messagesListInputSchema, messagesListOutputSchema, async (input) => ({
      // 内部事务事件在 SQL 层（listVisible，isVisibleToUser 的存储层镜像）
      // 就被排除：分页计数只含可见消息，短页不会截断历史
      // （docs/design/01-conversation.md 消息原则）。
      messages: domain.messages.listVisible(input.conversationId, {
        beforeSeq: input.beforeSeq,
        limit: input.limit,
      }),
    })),
    'messages.edit': method(messagesEditInputSchema, messagesListOutputSchema, async (input) => ({
      messages: [orchestrator.editMessage(input.id, input.text)],
    })),

    'messages.send': method(messagesSendInputSchema, messagesSendOutputSchema, async (input) =>
      orchestrator.sendMessage(input.conversationId, {
        text: input.text,
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
      }),
    ),

    'attachments.upload': method(
      attachmentsUploadInputSchema,
      attachmentsUploadOutputSchema,
      async (input) => {
        const bytes = Buffer.from(input.bytesBase64, 'base64');
        const attachment = domain.attachments.upload({
          conversationId: input.conversationId,
          fileName: input.fileName,
          mime: input.mime,
          bytes,
        });
        return { attachment };
      },
    ),
    'attachments.get': method(
      attachmentsGetInputSchema,
      attachmentsGetOutputSchema,
      async (input) => {
        const attachment = domain.attachments.getOrThrow(input.id);
        return {
          attachment,
          dataBase64: domain.attachments.readBytes(attachment).toString('base64'),
        };
      },
    ),
    'attachments.status': method(
      attachmentsStatusInputSchema,
      attachmentsStatusOutputSchema,
      async (input) => ({
        statuses: domain.attachments.statusOf(input.ids, input.conversationId),
      }),
    ),
    'attachments.detach': method(
      attachmentsDetachInputSchema,
      attachmentsDetachOutputSchema,
      async (input) => {
        domain.attachments.detach(input.id);
        return { ok: true } as const;
      },
    ),

    'runs.cancel': method(runIdInputSchema, runsCancelOutputSchema, async (input) => ({
      run: orchestrator.cancelRun(input.runId),
    })),
    // W3（D78）: `reviewed` comes only from the task card's review panel (the
    // user ticked 我已核实); no model tool reaches retryRun.
    'runs.retry': method(runsRetryInputSchema, runsRetryOutputSchema, async (input) => ({
      run: orchestrator.retryRun(
        input.runId,
        input.reviewed !== undefined ? { reviewed: input.reviewed } : {},
      ),
    })),
    // 缺设置卡片被用户关闭（未完成配置）：一次性通知 Bot 现状，由它给新的
    // 反馈（internal event → 对话轮）；无可通知时 notified=false。
    'runs.setupDismissed': method(
      runIdInputSchema,
      runsSetupDismissedOutputSchema,
      async (input) => ({
        notified: orchestrator.notifySetupDismissed(input.runId),
      }),
    ),
    'runs.dismissFailure': method(
      runIdInputSchema,
      runsDismissFailureOutputSchema,
      async (input) => ({
        run: orchestrator.dismissFailure(input.runId),
      }),
    ),
    'runs.steps': method(runIdInputSchema, runsStepsOutputSchema, async (input) => ({
      steps: orchestrator.stepsFor(input.runId),
    })),
    'runs.list': method(runsListInputSchema, runsListOutputSchema, async (input) => ({
      runs:
        input.active === true
          ? orchestrator.listActiveByConversation(input.conversationId)
          : orchestrator.listByConversation(input.conversationId, input.limit),
    })),

    'sandbox.status': method(sandboxStatusInputSchema, sandboxStatusOutputSchema, async (input) => {
      const availability = await services.sandbox.probe(input.probe === true);
      // P12: refresh the skills-verdict cache alongside any explicit probe.
      services.refreshEnhancedAvailability();
      // P12: enhanced-level status (null backend on Windows — the WSL distro
      // serves both levels there).
      const enhanced =
        services.sandboxEnhanced !== null
          ? await services.sandboxEnhanced.probe(input.probe === true)
          : null;
      const enhancedReport =
        enhanced !== null &&
        (enhanced.backend === 'lima' || enhanced.backend === 'podman' || enhanced.backend === 'wsl')
          ? {
              backend: enhanced.backend,
              available: enhanced.available,
              ...(enhanced.reason !== undefined ? { reason: enhanced.reason } : {}),
              ...(enhanced.fixHint !== undefined ? { fixHint: enhanced.fixHint } : {}),
            }
          : null;
      return {
        platform: process.platform,
        backend: availability.backend,
        available: availability.available,
        ...(availability.reason !== undefined ? { reason: availability.reason } : {}),
        ...(availability.fixHint !== undefined ? { fixHint: availability.fixHint } : {}),
        ...(enhancedReport !== null ? { enhanced: enhancedReport } : {}),
      };
    }),

    // P13 任务 6 诊断页: the aggregate lives in start.ts's system methods so
    // it stays reachable on locked/errored cores — exactly when diagnostics
    // matters. See createSystemMethods().

    // --- P12-B Windows 沙箱准备向导 (docs/dev/phases/P12 任务 7) -------------------
    // All three are void-input (callers must not pass `{}`). Non-applicable
    // hosts get applicable:false — the wizard then renders the platform's
    // enhanced-sandbox entry instead of the Windows flow.

    'sandbox.wslStatus': method(voidInput, sandboxWslStatusOutputSchema, async () => {
      const setup = services.wslSetup;
      if (setup === null) return WSL_NOT_APPLICABLE;
      return wslStatusOutput(await setup.status(), setup.skipped);
    }),

    'sandbox.wslPrepare': method(voidInput, sandboxWslStatusOutputSchema, async () => {
      const setup = services.wslSetup;
      if (setup === null) return WSL_NOT_APPLICABLE;
      // 企业策略禁用是本会话的终态：无动作可做，直接返回结构化原因（保持逐条确认）。
      const current = await setup.status();
      if (current.state.install.kind === 'policy_disabled') {
        return wslStatusOutput(current, setup.skipped);
      }
      // Single-flight: concurrent prepare calls (wizard reopened during an
      // in-flight import) share one state-machine run instead of racing.
      if (wslPrepareInflight !== null)
        return wslStatusOutput(await wslPrepareInflight, setup.skipped);
      const action =
        current.state.install.kind === 'ok' ? setup.ensureDistro() : setup.requestEnable();
      wslPrepareInflight = action;
      try {
        return wslStatusOutput(await action, setup.skipped);
      } finally {
        wslPrepareInflight = null;
      }
    }),

    'sandbox.wslSkip': method(voidInput, sandboxWslSkipOutputSchema, async () => {
      const setup = services.wslSetup;
      if (setup === null) return { skipped: false };
      setup.markSkipped();
      return { skipped: true };
    }),

    'approvals.list': method(
      approvalsListInputSchema,
      approvalsListOutputSchema,
      async (input) => ({
        approvals: domain.approvals.list(input.conversationId),
      }),
    ),
    'approvals.decide': method(
      approvalsDecideInputSchema,
      approvalsDecideOutputSchema,
      async (input) => ({
        approval: domain.approvals.decide(
          input.id,
          input.approve,
          input.duration,
          input.selection,
          input.payloadHash,
          input.routineSelection,
          input.handoverSelection,
          input.leadBotId,
        ),
      }),
    ),

    'delegations.get': method(
      delegationIdInputSchema,
      delegationGetOutputSchema,
      async (input) => ({
        delegation: orchestrator.getDelegation(input.id),
      }),
    ),
    'delegations.cancel': method(
      delegationIdInputSchema,
      delegationGetOutputSchema,
      async (input) => ({ delegation: orchestrator.cancelDelegation(input.id) }),
    ),

    // D88: execution progress of a handover card (renders after a reload; live updates
    // arrive as handover.updated).
    'handovers.get': method(handoversGetInputSchema, handoversGetOutputSchema, async (input) => ({
      handover: services.handover?.view(input.approvalId) ?? null,
    })),

    // D75 W3 (design 30 §4.3 / §2.4.6): task cards, the status line, question cards.
    'tasks.get': method(taskIdInputSchema, taskGetOutputSchema, async (input) => ({
      task: orchestrator.tasks.view(input.taskId),
    })),
    'tasks.active': method(tasksActiveInputSchema, tasksActiveOutputSchema, async (input) => ({
      tasks: orchestrator.tasks.activeViews(input.conversationId),
    })),
    'tasks.answer': method(tasksAnswerInputSchema, okOutputSchema, async (input) => {
      orchestrator.tasks.answerQuestion(input.messageId, input.answer, input.values);
      return { ok: true as const };
    }),
    // W2 外部副作用台账（W3 检查后重试面板）：任务沿续接链的 tool_effects 行。
    'effects.list': method(taskIdInputSchema, effectsListOutputSchema, async (input) => ({
      effects: domain.effects.listForTask(input.taskId),
    })),

    'grants.list': method(grantsListInputSchema, grantsListOutputSchema, async (input) => ({
      grants: domain.grants.listActive(input.conversationId),
    })),
    'grants.revoke': method(grantIdInputSchema, okOutputSchema, async (input) => {
      // W3（D78）: the user's revocation interrupts the grant's bot's running
      // tasks in that conversation (permission.revoked → TaskHost).
      const { grant, interruptedTasks } = domain.grants.revokeByUser(input.id);
      if (grant) {
        publish('grant.changed', {
          conversationId: grant.conversationId,
          grants: domain.grants.listActive(grant.conversationId),
        });
      }
      publishInterrupted(interruptedTasks, 'path');
      return { ok: true as const };
    }),

    'allowlist.list': method(voidInput, allowlistListOutputSchema, async () => ({
      entries: domain.allowlist.list(),
    })),
    'allowlist.add': method(allowlistAddInputSchema, allowlistListOutputSchema, async (input) => ({
      entries: domain.allowlist.add(input.pattern),
    })),
    'allowlist.update': method(
      allowlistUpdateInputSchema,
      allowlistListOutputSchema,
      async (input) => ({
        entries: domain.allowlist.update(input.id, input.enabled),
      }),
    ),
    'allowlist.reset': method(voidInput, allowlistListOutputSchema, async () => ({
      entries: domain.allowlist.reset(),
    })),

    'unattended.get': method(voidInput, unattendedGetOutputSchema, async () =>
      domain.unattended.effective(),
    ),
    'unattended.enable': method(
      unattendedEnableInputSchema,
      unattendedGetOutputSchema,
      async (input) =>
        domain.unattended.enable({
          hours: input.hours ?? null,
          acknowledgeRisk: input.acknowledgeRisk,
        }),
    ),
    'unattended.disable': method(voidInput, unattendedGetOutputSchema, async () =>
      domain.unattended.disable(),
    ),
    'unattended.summary': method(
      unattendedSummaryInputSchema,
      unattendedSummaryOutputSchema,
      async (input) => ({ items: domain.approvals.summary(input.since) }),
    ),

    'workdirs.list': method(voidInput, workdirsListOutputSchema, async () => ({
      workdirs: domain.workdirs.listRecent(),
    })),
    'workdirs.get': method(workdirsGetInputSchema, workdirsGetOutputSchema, async (input) => {
      const workdir = domain.workdirs.get(input.id);
      return { workdir: workdir !== null ? domain.workdirs.refreshStatus(workdir.id) : null };
    }),
    'workdirs.select': method(
      workdirsSelectInputSchema,
      workdirsSelectOutputSchema,
      async (input) => {
        const workdir = services.workdirRuntime!.select(input.conversationId, input.path);
        publish('conversation.updated', {
          conversation: domain.conversations.getOrThrow(input.conversationId),
        });
        publish('workdir.updated', { workdir });
        return { workdir };
      },
    ),
    'workdirs.unbind': method(workdirsUnbindInputSchema, okOutputSchema, async (input) => {
      services.workdirRuntime!.unbind(input.conversationId);
      publish('conversation.updated', {
        conversation: domain.conversations.getOrThrow(input.conversationId),
      });
      return { ok: true as const };
    }),
    'workdirs.update': method(
      workdirsUpdateInputSchema,
      workdirsGetOutputSchema,
      async (input) => ({
        workdir: services.workdirRuntime!.update(input.id, {
          ...(input.protectRules !== undefined ? { protectRules: input.protectRules } : {}),
          ...(input.allowedPorts !== undefined ? { allowedPorts: input.allowedPorts } : {}),
        }),
      }),
    ),
    'workdirs.remove': method(workdirsRemoveInputSchema, okOutputSchema, async (input) => {
      await services.workdirRuntime!.remove(input.id);
      return { ok: true as const };
    }),
    'workdirs.diff': method(workdirsDiffInputSchema, workdirsDiffOutputSchema, async (input) =>
      services.workdirRuntime!.diff(input.runId),
    ),
    'workdirs.revert': method(
      workdirsRevertInputSchema,
      workdirsRevertOutputSchema,
      async (input) => services.workdirRuntime!.revert(input.runId, input.force === true),
    ),
    'workdirs.revokeLease': method(
      workdirsRevokeLeaseInputSchema,
      workdirsRevokeLeaseOutputSchema,
      async (input) => ({
        revoked: await services.workdirRuntime!.revokeLease(input.conversationId),
      }),
    ),

    'environment.list': method(voidInput, environmentListOutputSchema, async () => ({
      installs: services.environment!.listInstalls(),
      system: services.environment!.systemStatuses(),
    })),
    'environment.recheck': method(voidInput, environmentListOutputSchema, async () => ({
      installs: await services.environment!.recheck(),
      system: services.environment!.systemStatuses(),
    })),
    'environment.remove': method(environmentInstallIdInputSchema, okOutputSchema, async (input) => {
      services.environment!.remove(input.id);
      return { ok: true as const };
    }),
    'environment.reinstall': method(
      environmentInstallIdInputSchema,
      environmentReinstallOutputSchema,
      async (input) => ({ install: await services.environment!.reinstall(input.id) }),
    ),

    // --- external agents (D72 P4) ---------------------------------------------
    ...bindAgentMethods(services),
    // D73: interactive OAuth flows (apps.connect*, apps.connections.list).
    ...bindAppsMethods(services),
    ...bindMailMethods(services),
    // D73: apps.disconnect (revocation) and mcp.removeServer (settings + secrets + tokens).
    ...bindAppsRuntimeMethods(services, { revokeMcp }),
    // D73 P2 §6.5: mcpb.inspect / mcpb.install.
    ...bindMcpbMethods(services),
    // D73 P3 §7.5: apps.ui.open / close / callTool / openLink (MCP Apps rendering).
    ...bindAppsUiMethods(services).app,
    // D81: widgets.ui.open / close / source (bot-authored interactive widgets).
    ...bindWidgetsUiMethods(services).app,
    // D73 P1: catalog list, connection update / tools / review / policy, grants, approveAfterTest.
    ...bindAppsConnectionMethods(services, { revokeMcp }),
    ...bindAppsSkillsMethods(services),

    // --- memory & profile (P07) ------------------------------------------
    'memory.list': method(memoryListInputSchema, memoryListOutputSchema, async (input) => ({
      items: services.memory!.listMemory(input.botId),
    })),
    'memory.update': method(memoryUpdateInputSchema, memoryListOutputSchema, async (input) => {
      if (input.content === undefined && input.privateToBot === undefined) {
        throw new AppError('INVALID_INPUT', 'memory.update 需要提供 content 或 privateToBot');
      }
      services.memory!.updateMemory(input.botId, input.id, {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.privateToBot !== undefined ? { privateToBot: input.privateToBot } : {}),
      });
      return { items: services.memory!.listMemory(input.botId) };
    }),
    'memory.retract': method(memoryRetractInputSchema, memoryListOutputSchema, async (input) => {
      services.memory!.retractMemory(input.botId, input.id);
      return { items: services.memory!.listMemory(input.botId) };
    }),

    'profile.list': method(voidInput, profileListOutputSchema, async () => ({
      items: services.memory!.listProfile(),
    })),
    'profile.update': method(profileUpdateInputSchema, profileListOutputSchema, async (input) => {
      services.memory!.updateProfile(input.id, {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
      });
      return { items: services.memory!.listProfile() };
    }),
    'profile.retract': method(profileRetractInputSchema, profileListOutputSchema, async (input) => {
      services.memory!.retractProfile(input.id);
      return { items: services.memory!.listProfile() };
    }),
    'profile.card': method(voidInput, profileCardOutputSchema, async () => ({
      card: services.memory!.profileCard(),
    })),

    'usage.summary': method(usageSummaryInputSchema, usageSummaryOutputSchema, async (input) => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const days = input.days ?? 7;
      const now = services.clock.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const since = now - days * dayMs;
      const buckets = new Map<
        string,
        {
          botId: string | null;
          loopType: LoopType;
          date: string;
          inputTokens: number;
          outputTokens: number;
          costUsd: number | null;
          agentId?: string;
          turns?: number;
          calls: number;
        }
      >();
      for (const entry of services.domain!.usage.entriesSince(since)) {
        const date = localDateKey(new Date(entry.createdAt), timeZone);
        // D72 P5: external agents (subscription usage) get their own rows.
        const agentId = entry.provider.startsWith('agent:')
          ? entry.provider.slice('agent:'.length)
          : null;
        const key = `${entry.botId ?? ''}|${entry.loopType}|${date}|${agentId ?? ''}`;
        const bucket = buckets.get(key) ?? {
          botId: entry.botId,
          loopType: entry.loopType,
          date,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          calls: 0,
          ...(agentId !== null ? { agentId, turns: 0 } : {}),
        };
        bucket.inputTokens += entry.inputTokens;
        bucket.outputTokens += entry.outputTokens;
        bucket.calls += 1;
        if (bucket.turns !== undefined) bucket.turns += 1;
        if (entry.costUsd !== null) bucket.costUsd = (bucket.costUsd ?? 0) + entry.costUsd;
        buckets.set(key, bucket);
      }
      return { entries: [...buckets.values()] };
    }),

    'embedding.status': method(voidInput, embeddingStatusOutputSchema, async () =>
      services.memory!.embeddingStatus(),
    ),
    'embedding.configure': method(
      embeddingConfigureInputSchema,
      embeddingStatusOutputSchema,
      async (input) => services.memory!.configureEmbedding(input),
    ),
    'embedding.download': method(voidInput, environmentReinstallOutputSchema, async () => ({
      install: await services.memory!.downloadEmbeddingModel(),
    })),

    // --- skills (P08) ------------------------------------------------------
    'skills.list': method(skillsListInputSchema, skillsListOutputSchema, async (input) => ({
      skills: services.skills!.listForBot(input.botId),
    })),
    'skills.import': method(skillsImportInputSchema, skillsImportOutputSchema, async (input) => {
      const bot = domain.bots.getOrThrow(input.botId);
      let conversationId = input.conversationId;
      if (conversationId === undefined) {
        conversationId = domain.conversations.openDirect(bot.id).conversation.id;
      } else {
        domain.conversations.getOrThrow(conversationId);
      }
      return services.skillImporter!.import({
        botId: input.botId,
        conversationId,
        sourceUrl: input.sourceUrl,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(input.subdirectory !== undefined ? { subdirectory: input.subdirectory } : {}),
      });
    }),
    'skills.enable': method(skillsSetNameInputSchema, skillsListOutputSchema, async (input) => {
      services.skills!.enable(input.botId, input.name);
      return { skills: services.skills!.listForBot(input.botId) };
    }),
    'skills.disable': method(skillsSetNameInputSchema, skillsListOutputSchema, async (input) => {
      services.skills!.disable(input.botId, input.name);
      return { skills: services.skills!.listForBot(input.botId) };
    }),
    'skills.uninstall': method(skillsSetNameInputSchema, skillsListOutputSchema, async (input) => ({
      skills: services.skills!.uninstall(input.botId, input.name),
    })),
    'skills.history': method(
      skillsSetNameInputSchema,
      skillsHistoryOutputSchema,
      async (input) => ({
        history: await services.skills!.history(input.botId, input.name),
      }),
    ),
    'skills.rollback': method(skillsRollbackInputSchema, skillsListOutputSchema, async (input) => ({
      skills: [await services.skills!.rollback(input.botId, input.name, input.commitOid)],
    })),
    'skills.read': method(skillNameInputSchema, skillsReadOutputSchema, async (input) =>
      services.skills!.readSkill(input.botId, input.name),
    ),
    // 技能市场（随应用分发的预置目录）：目录与安装态是全局的（公共技能）；
    // 点「添加」即装入 public_skills——所有 Bot 发现并调用（无审批卡片）。
    'skills.presets.list': method(
      skillsPresetsListInputSchema,
      skillsPresetsListOutputSchema,
      async () => ({ presets: services.skillPresets!.list() }),
    ),
    'skills.presets.install': method(
      skillsPresetsInstallInputSchema,
      skillsPresetsInstallOutputSchema,
      async (input) => ({ presets: services.skillPresets!.install(input.presetId) }),
    ),
    // 技能目录在应用外被删除：用户在弹框点「知道了」后清理 DB 记录。
    'skills.purgeMissing': method(
      skillsPurgeMissingInputSchema,
      skillsPurgeMissingOutputSchema,
      async (input) => ({ purged: services.skills!.purgeMissing(input.name) }),
    ),

    // --- wiki (P09; owner-generalized D92 T1b WP9 — a project owner must be a
    // live project conversation; from RPC the actor is the user, so the
    // entry-level ACL does not apply to deletePage / rollback) ----------------
    'wiki.tree': method(wikiOwnerInputSchema, wikiTreeOutputSchema, async (input) => ({
      pages: services.wiki!.tree(wikiOwnerOf(input.owner)),
    })),
    'wiki.page': method(wikiPageInputSchema, wikiPageOutputSchema, async (input) =>
      services.wiki!.readPage(wikiOwnerOf(input.owner), input.path),
    ),
    'wiki.search': method(wikiSearchInputSchema, wikiSearchOutputSchema, async (input) => ({
      hits: services.wiki!.search(wikiOwnerOf(input.owner), input.query, input.limit ?? 20),
    })),
    'wiki.history': method(wikiOwnerInputSchema, wikiHistoryOutputSchema, async (input) => ({
      history: await services.wiki!.history(wikiOwnerOf(input.owner)),
    })),
    'wiki.rollback': method(wikiRollbackInputSchema, wikiRollbackOutputSchema, async (input) => {
      await services.wiki!.rollback(wikiOwnerOf(input.owner), input.commitOid);
      return { ok: true as const };
    }),
    // 用户在右栏删除一页：同样是追加式新提交（可回滚恢复），与维护互斥。
    'wiki.deletePage': method(
      wikiDeletePageInputSchema,
      wikiDeletePageOutputSchema,
      async (input) => {
        await services.wiki!.deletePage(wikiOwnerOf(input.owner), input.path);
        return { ok: true as const };
      },
    ),

    // --- wiki sources (D92 T1b WP10): the project wiki's source ledger. The RPC
    // caller is the USER (no bot-identity checks); bot owners have no ledger.
    'wiki.sources': method(wikiOwnerInputSchema, wikiSourcesOutputSchema, async (input) => {
      const owner = wikiOwnerOf(input.owner);
      if (owner.kind !== 'project') {
        throw new AppError('NOT_SUPPORTED', 'Bot wiki 没有来源台账');
      }
      const sources = services.wiki!.listSources(owner).map((entry) => ({
        id: entry.id,
        fileName: entry.fileName,
        bytes: entry.bytes,
        kind: entry.kind,
        createdBy:
          entry.createdBy.kind === 'user'
            ? { kind: 'user' as const }
            : {
                kind: 'bot' as const,
                id: entry.createdBy.id,
                name: domain.bots.get(entry.createdBy.id)?.name ?? null,
              },
        sources: entry.sources.map((source) => ({
          type: source.type,
          ref: source.ref,
          at: source.at,
        })),
        createdAt: entry.createdAt,
      }));
      return { sources };
    }),
    'wiki.addSource': method(wikiAddSourceInputSchema, wikiAddSourceOutputSchema, async (input) => {
      const owner = wikiOwnerOf(input.owner);
      if (owner.kind !== 'project') {
        throw new AppError('NOT_SUPPORTED', 'Bot wiki 没有来源台账');
      }
      // 用户来源的执行者是项目负责人（执行者付费，D92 T1b WP9 同一口径）。
      const leadBotId = domain.conversations.get(owner.id)?.leadBotId ?? null;
      if (leadBotId === null) {
        throw new AppError('INVALID_INPUT', '项目组没有负责人');
      }
      const outcome = services.wiki!.enqueueIngest({
        owner,
        botId: leadBotId,
        conversationId: owner.id,
        source: { sourceType: input.sourceType, ref: input.ref, note: input.note ?? '' },
        createdBy: { kind: 'user' },
      });
      if (!outcome.ok) {
        throw new AppError('INVALID_INPUT', outcome.message);
      }
      return { ok: true as const };
    }),
    'wiki.deleteSource': method(
      wikiDeleteSourceInputSchema,
      wikiDeleteSourceOutputSchema,
      async (input) => {
        const owner = wikiOwnerOf(input.owner);
        if (owner.kind !== 'project') {
          throw new AppError('NOT_SUPPORTED', 'Bot wiki 没有来源台账');
        }
        const leadBotId = domain.conversations.get(owner.id)?.leadBotId ?? null;
        if (leadBotId === null) {
          throw new AppError('INVALID_INPUT', '项目组没有负责人');
        }
        // 异步托管：立即返回，删除由 wiki_remove_source job 在互斥锁内完成。
        services.wiki!.enqueueRemoveSource({
          owner,
          sourceId: input.sourceId,
          actor: { role: 'user' },
          leadBotId,
          conversationId: owner.id,
        });
        return { ok: true as const };
      },
    ),

    // --- schedules (P10) -----------------------------------------------------
    'schedules.list': method(
      schedulesListInputSchema,
      schedulesListOutputSchema,
      async (input) => ({
        schedules: services.schedules?.listEntries(input.conversationId) ?? [],
      }),
    ),
    'schedules.cancel': method(
      schedulesCancelInputSchema,
      schedulesCancelOutputSchema,
      async (input) => {
        services.schedules?.cancel(input.id);
        return { ok: true as const };
      },
    ),

    // --- workbench (D90): todos + memos ---------------------------------------------
    'todos.list': method(todosListInputSchema, todosListOutputSchema, async (input) => ({
      todos: requireTodos(services).list({
        ...(input.statuses !== undefined ? { statuses: input.statuses } : {}),
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.includeClosed !== undefined ? { includeClosed: input.includeClosed } : {}),
      }),
    })),
    'todos.get': method(todosIdInputSchema, todosGetOutputSchema, async (input) =>
      requireTodos(services).get(input.id),
    ),
    'todos.create': method(todosCreateInputSchema, todosWriteOutputSchema, async (input) =>
      requireTodos(services).create({
        title: input.title,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        ...(input.when !== undefined ? { when: input.when } : {}),
        ...(input.memoId !== undefined ? { memoId: input.memoId } : {}),
        source: 'user',
        actor: 'user',
      }),
    ),
    'todos.update': method(todosUpdateInputSchema, todosWriteOutputSchema, async (input) =>
      requireTodos(services).update(input.id, {
        actor: 'user',
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
        ...(input.assignee !== undefined ? { assignee: input.assignee } : {}),
        ...(input.when !== undefined ? { when: input.when } : {}),
      }),
    ),
    'todos.start': method(todosIdInputSchema, todosTransitionOutputSchema, async (input) => ({
      todo: requireTodos(services).start(input.id, 'user'),
    })),
    'todos.complete': method(todosIdInputSchema, todosTransitionOutputSchema, async (input) => ({
      todo: requireTodos(services).complete(input.id),
    })),
    'todos.cancel': method(todosIdInputSchema, todosTransitionOutputSchema, async (input) => ({
      todo: requireTodos(services).cancel(input.id),
    })),
    'todos.reopen': method(todosIdInputSchema, todosTransitionOutputSchema, async (input) => ({
      todo: requireTodos(services).reopen(input.id),
    })),
    'memos.list': method(memosListInputSchema, memosListOutputSchema, async (input) => ({
      memos: requireMemos(services).list({
        ...(input.query !== undefined ? { query: input.query } : {}),
        ...(input.trashed !== undefined ? { trashed: input.trashed } : {}),
      }),
    })),
    'memos.create': method(memosCreateInputSchema, memosMemoOutputSchema, async (input) => ({
      memo: requireMemos(services).create({ body: input.body, source: 'user' }),
    })),
    'memos.update': method(memosUpdateInputSchema, memosMemoOutputSchema, async (input) => ({
      memo: requireMemos(services).update(input.id, {
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      }),
    })),
    'memos.delete': method(memosIdInputSchema, memosMemoOutputSchema, async (input) => ({
      memo: requireMemos(services).delete(input.id),
    })),
    'memos.restore': method(memosIdInputSchema, memosMemoOutputSchema, async (input) => ({
      memo: requireMemos(services).restore(input.id),
    })),

    // --- 辅助阅读便签（main.db stickies；删除对话随 conversations FK 级联） ---
    'stickies.list': method(stickiesListInputSchema, stickiesListOutputSchema, async () => ({
      stickies: domain.stickies.list(),
    })),
    'stickies.create': method(
      stickiesCreateInputSchema,
      stickiesCreateOutputSchema,
      async (input) => {
        domain.conversations.getOrThrow(input.conversationId);
        return { stickie: domain.stickies.create(input) };
      },
    ),
    'stickies.update': method(
      stickiesUpdateInputSchema,
      stickiesUpdateOutputSchema,
      async (input) => {
        const { id, ...patch } = input;
        return { stickie: domain.stickies.update(id, patch) };
      },
    ),
    'stickies.delete': method(
      stickiesDeleteInputSchema,
      stickiesDeleteOutputSchema,
      async (input) => {
        domain.stickies.remove(input.id);
        return { ok: true as const };
      },
    ),

    // --- watches (W7) ---------------------------------------------------------
    'watches.list': method(watchesListInputSchema, watchesListOutputSchema, async (input) => ({
      watches: services.watches?.listEntries(input.conversationId) ?? [],
    })),
    'watches.get': method(watchIdInputSchema, watchGetOutputSchema, async (input) => ({
      watch: services.watches?.get(input.id) ?? null,
    })),
    'watches.pause': method(watchIdInputSchema, watchMutateOutputSchema, async (input) => {
      const watches = requireWatches(services);
      watches.pauseWatch(input.id);
      return { watch: watches.get(input.id)! };
    }),
    'watches.resume': method(watchIdInputSchema, watchMutateOutputSchema, async (input) => {
      const watches = requireWatches(services);
      watches.resumeWatch(input.id);
      return { watch: watches.get(input.id)! };
    }),
    'watches.stop': method(watchIdInputSchema, watchMutateOutputSchema, async (input) => {
      const watches = requireWatches(services);
      watches.stopWatch(input.id);
      return { watch: watches.get(input.id)! };
    }),

    // --- W8 共享浏览器资料 ---------------------------------------------------
    'browserProfiles.list': method(voidInput, browserProfilesListOutputSchema, async () => ({
      profiles: domain.browserProfiles.list(),
    })),
    'browserProfiles.create': method(
      browserProfilesCreateInputSchema,
      browserProfilesCreateOutputSchema,
      async (input) => {
        const profile = domain.browserProfiles.create(input.name);
        return { profile, profiles: domain.browserProfiles.list() };
      },
    ),
    'browserProfiles.rename': method(
      browserProfilesRenameInputSchema,
      browserProfilesMutateOutputSchema,
      async (input) => {
        const profiles = domain.browserProfiles.rename(input.id, input.name);
        return { profiles };
      },
    ),
    'browserProfiles.delete': method(
      browserProfileIdInputSchema,
      browserProfilesMutateOutputSchema,
      async (input) => {
        const { movedBotIds, interrupted } = await domain.browserProfiles.delete(input.id);
        publishInterrupted(interrupted, 'browser_profile');
        return { profiles: domain.browserProfiles.list(), movedBotIds, interrupted };
      },
    ),
    'browserProfiles.clear': method(
      browserProfileIdInputSchema,
      browserProfilesMutateOutputSchema,
      async (input) => {
        await domain.browserProfiles.clear(input.id);
        return { profiles: domain.browserProfiles.list() };
      },
    ),
    // D80 offer cards: deterministic creation / decline, no bot wake-up.
    'schedules.acceptOffer': method(
      schedulesOfferInputSchema,
      schedulesAcceptOfferOutputSchema,
      async (input) => {
        if (!services.schedules) throw new AppError('NOT_IMPLEMENTED', '定时服务未就绪');
        return { schedule: services.schedules.acceptOffer(input.messageId) };
      },
    ),
    'schedules.declineOffer': method(
      schedulesOfferInputSchema,
      schedulesDeclineOfferOutputSchema,
      async (input) => {
        if (!services.schedules) throw new AppError('NOT_IMPLEMENTED', '定时服务未就绪');
        services.schedules.declineOffer(input.messageId);
        return { ok: true as const };
      },
    ),
    // 对话内应用设置：settings.items.apply 与设置卡动作。
    ...bindSettingsCatalogMethods(services),
  };
  // 设置页原有的专用保存路径（providers.setKey、unattended.*……）成功后补发
  // settings.changed（settings.update / bots.update 已在上面按差异补发）。
  return withSettingsChangedEvents(methods, publishSettingsChanged);
}

function requireTodos(services: CoreServices): TodoService {
  if (!services.todos) throw new AppError('NOT_IMPLEMENTED', '工作台服务未就绪');
  return services.todos;
}

function requireMemos(services: CoreServices): MemoService {
  if (!services.memos) throw new AppError('NOT_IMPLEMENTED', '工作台服务未就绪');
  return services.memos;
}

function requireWatches(services: CoreServices): WatchService {
  if (!services.watches) throw new AppError('NOT_IMPLEMENTED', '监看服务未就绪');
  return services.watches;
}
