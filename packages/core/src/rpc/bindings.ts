import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
  AppError,
  settingsGetOutputSchema,
  settingsUpdateInputSchema,
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
  delegationGetOutputSchema,
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
  groupsCreateInputSchema,
  groupsCreateOutputSchema,
  groupsSetupStartInputSchema,
  groupsSetupStartOutputSchema,
  groupsSetupAnswerInputSchema,
  groupsSetupAnswerOutputSchema,
  groupsSetupCancelInputSchema,
  groupsRenameInputSchema,
  groupsRenameOutputSchema,
  groupsAddMembersInputSchema,
  groupsRemoveMemberInputSchema,
  groupsRedistributeInputSchema,
  messagesListInputSchema,
  messagesListOutputSchema,
  messagesEditInputSchema,
  draftsListInputSchema,
  draftsListOutputSchema,
  draftsAddInputSchema,
  draftsUpdateInputSchema,
  draftsReorderInputSchema,
  draftsRemoveInputSchema,
  draftsFlushInputSchema,
  draftsFlushOneInputSchema,
  draftsFlushOutputSchema,
  attachmentsUploadInputSchema,
  attachmentsUploadOutputSchema,
  attachmentsGetInputSchema,
  attachmentsGetOutputSchema,
  attachmentsDetachInputSchema,
  attachmentsDetachOutputSchema,
  mcpRemoveSecretInputSchema,
  mcpSetSecretInputSchema,
  mcpTestInputSchema,
  mcpTestOutputSchema,
  webSearchTestInputSchema,
  webSearchTestOutputSchema,
  webSearchSetKeyInputSchema,
  webSearchRemoveKeyInputSchema,
  runIdInputSchema,
  runsCancelOutputSchema,
  runsRetryOutputSchema,
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
  projectsListOutputSchema,
  projectsGetInputSchema,
  projectsGetOutputSchema,
  projectsSelectInputSchema,
  projectsSelectOutputSchema,
  projectsUnbindInputSchema,
  projectsUpdateInputSchema,
  projectsRemoveInputSchema,
  projectsDiffInputSchema,
  projectsDiffOutputSchema,
  projectsRevertInputSchema,
  projectsRevertOutputSchema,
  projectsRevokeLeaseInputSchema,
  projectsRevokeLeaseOutputSchema,
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
  budgetGetOutputSchema,
  budgetUpdateInputSchema,
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
  wikiBotIdInputSchema,
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
  schedulesListInputSchema,
  schedulesListOutputSchema,
  schedulesCancelInputSchema,
  schedulesCancelOutputSchema,
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
  type Conversation,
} from '@kepcup/shared';
import type { CoreServices } from '../start.js';
import type { RpcMethodSpec } from './server.js';
import type { WslStatusReport } from '../sandbox/wsl/setup.js';
import { localDateKey } from '../memory/local-date.js';
import type { LoopType } from '@kepcup/shared';

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
  // P12-B: one in-flight preparation at a time (per services instance) — the
  // wizard reopening mid-import shares the running state-machine pass.
  let wslPrepareInflight: Promise<WslStatusReport> | null = null;

  const conversationView = (conversation: Conversation): Conversation => ({
    ...conversation,
    unreadCount: Math.max(0, conversation.lastSeq - conversation.lastReadSeq),
    runningBotIds: orchestrator.runningBotIds(conversation.id),
    bot:
      conversation.directBotId !== null
        ? (domain.bots.get(conversation.directBotId) ?? null)
        : null,
  });

  return {
    'settings.get': method(voidInput, settingsGetOutputSchema, async () => domain.settings.get()),
    'settings.update': method(settingsUpdateInputSchema, settingsGetOutputSchema, async (input) => {
      const previous = domain.settings.get();
      // P13 任务 4: the onboarding patch is partial; store the merged state so
      // a step writing one flag never erases the others.
      const { onboarding: onboardingPatch, ...rest } = input;
      const next = domain.settings.update({
        ...rest,
        ...(onboardingPatch !== undefined
          ? { onboarding: { ...previous.onboarding, ...onboardingPatch } }
          : {}),
      });
      services.scheduler?.setConcurrency(next.providerConcurrency);
      if (input.launchAtLogin !== undefined && input.launchAtLogin !== previous.launchAtLogin) {
        // P13 任务 3: the main process applies the OS login item on this event
        // (platform port B → setLoginItemSettings / XDG autostart).
        publish('platform.autostart', { enabled: next.launchAtLogin });
      }
      return next;
    }),

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
      await domain.providers.test(input.provider, input.model, input.capability);
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
      async (input) => services.media!.transcribeSpeech(input),
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

    'bots.list': method(voidInput, botsListOutputSchema, async () => ({
      bots: domain.bots.listActive(),
    })),
    'bots.get': method(botIdInputSchema, botGetOutputSchema, async (input) => ({
      bot: domain.bots.get(input.id),
    })),
    'bots.create': method(botsCreateInputSchema, botGetOutputSchema, async (input) => {
      const bot = domain.bots.create(input.profile, { interview: input.interview });
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
     * 访谈目录卡作答（19/D59）：选择目录则先绑定 project，然后把首答与目录
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
    'bots.update': method(botsUpdateInputSchema, botGetOutputSchema, async (input) => {
      const bot = domain.bots.update(input.id, input.profile);
      publish('bot.updated', { bot });
      return { bot };
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
      // affected groups are unenumerable afterwards — their open member lists
      // still need the push (deleted bot leaves the cards / @ popup and its
      // history messages render under its id, docs/design/01-conversation.md).
      const groupIds = domain.lifecycle.groupConversationIdsOf(input.id);
      await domain.lifecycle.deleteBot(input.id);
      publish('bot.deleted', { id: input.id });
      // Direct conversations just turned read-only; push their new state.
      for (const conversation of domain.conversations.listDirectByBot(input.id)) {
        publish('conversation.updated', { conversation });
      }
      for (const conversationId of groupIds) {
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
      // 左栏预览（每个会话最后一条文本消息）随列表一并下发：启动时不逐个
      // 打开会话也能看到「最后一条消息」。
      const lastTexts = domain.messages.latestTextByConversation();
      return {
        conversations: domain.conversations.list().map((conversation) => {
          const view = conversationView(conversation);
          const text = lastTexts[conversation.id];
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
      async (input) => ({ members: domain.groups.members(input.conversationId) }),
    ),

    'groups.create': method(groupsCreateInputSchema, groupsCreateOutputSchema, async (input) => ({
      conversation: domain.groups.create(input),
    })),
    /**
     * 对话内群创建（19/D60）：start 创建创建中的群并下发第一问；answer 按
     * 步推进（零模型调用）；cancel 级联删除该对话。
     */
    'groups.setup.start': method(
      groupsSetupStartInputSchema,
      groupsSetupStartOutputSchema,
      async () => ({
        conversation: conversationView(orchestrator.beginGroupSetup()),
      }),
    ),
    'groups.setup.answer': method(
      groupsSetupAnswerInputSchema,
      groupsSetupAnswerOutputSchema,
      async (input) => {
        const { conversation, done } = orchestrator.answerGroupSetup(input);
        return { conversation: conversationView(conversation), done };
      },
    ),
    'groups.setup.cancel': method(groupsSetupCancelInputSchema, okOutputSchema, async (input) => {
      await domain.lifecycle.deleteConversation(input.conversationId);
      publish('conversation.deleted', { id: input.conversationId });
      return { ok: true as const };
    }),
    'groups.rename': method(groupsRenameInputSchema, groupsRenameOutputSchema, async (input) => ({
      conversation: domain.groups.rename(input.conversationId, input.title),
    })),
    'groups.addMembers': method(
      groupsAddMembersInputSchema,
      conversationsMembersOutputSchema,
      async (input) => ({
        members: await domain.groups.addMembers(input.conversationId, input.botIds),
      }),
    ),
    'groups.removeMember': method(groupsRemoveMemberInputSchema, okOutputSchema, async (input) => {
      await domain.groups.removeMember(input.conversationId, input.botId);
      return { ok: true as const };
    }),
    'groups.redistribute': method(groupsRedistributeInputSchema, okOutputSchema, async (input) => {
      orchestrator.redistributeBatch(input.conversationId, input.batchId, input.botId);
      return { ok: true as const };
    }),

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

    'drafts.list': method(draftsListInputSchema, draftsListOutputSchema, async (input) => ({
      drafts: domain.drafts.list(input.conversationId),
    })),
    'drafts.add': method(draftsAddInputSchema, draftsListOutputSchema, async (input) => {
      domain.drafts.add(input.conversationId, input.text, {
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
        ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
      });
      const drafts = domain.drafts.list(input.conversationId);
      publish('draft.changed', { conversationId: input.conversationId, drafts });
      return { drafts };
    }),
    'drafts.update': method(draftsUpdateInputSchema, draftsListOutputSchema, async (input) => {
      const draft = domain.drafts.update(input.id, input.text);
      const drafts = domain.drafts.list(draft.conversationId);
      publish('draft.changed', { conversationId: draft.conversationId, drafts });
      return { drafts };
    }),
    'drafts.reorder': method(draftsReorderInputSchema, draftsListOutputSchema, async (input) => {
      const drafts = domain.drafts.reorder(input.conversationId, input.ids);
      publish('draft.changed', { conversationId: input.conversationId, drafts });
      return { drafts };
    }),
    'drafts.remove': method(draftsRemoveInputSchema, draftsListOutputSchema, async (input) => {
      const draft = domain.drafts.getOrThrow(input.id);
      domain.drafts.remove(input.id);
      // 草稿删除级联清掉仍挂在草稿上的附件（行与文件，docs/design/20）。
      domain.attachments.deleteDraftFiles(input.id);
      const drafts = domain.drafts.list(draft.conversationId);
      publish('draft.changed', { conversationId: draft.conversationId, drafts });
      return { drafts };
    }),
    'drafts.flush': method(draftsFlushInputSchema, draftsFlushOutputSchema, async (input) =>
      orchestrator.flushDrafts(input.conversationId),
    ),
    'drafts.flushOne': method(draftsFlushOneInputSchema, draftsFlushOutputSchema, async (input) => {
      const draft = domain.drafts.getOrThrow(input.id);
      return orchestrator.flushDrafts(draft.conversationId, input.id);
    }),

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
          draftId: input.draftId ?? null,
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
    'attachments.detach': method(
      attachmentsDetachInputSchema,
      attachmentsDetachOutputSchema,
      async (input) => {
        const attachment = domain.attachments.getOrThrow(input.id);
        domain.attachments.detach(input.id);
        if (attachment.draftId !== null) {
          const drafts = domain.drafts.list(attachment.conversationId);
          publish('draft.changed', { conversationId: attachment.conversationId, drafts });
        }
        return { ok: true } as const;
      },
    ),

    'runs.cancel': method(runIdInputSchema, runsCancelOutputSchema, async (input) => ({
      run: orchestrator.cancelRun(input.runId),
    })),
    'runs.retry': method(runIdInputSchema, runsRetryOutputSchema, async (input) => ({
      run: orchestrator.retryRun(input.runId),
    })),
    'runs.steps': method(runIdInputSchema, runsStepsOutputSchema, async (input) => ({
      steps: orchestrator.stepsFor(input.runId),
    })),
    'runs.list': method(runsListInputSchema, runsListOutputSchema, async (input) => ({
      runs: orchestrator.listByConversation(input.conversationId, input.limit),
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
        ),
      }),
    ),

    'delegations.get': method(delegationIdInputSchema, delegationGetOutputSchema, async (input) => ({
      delegation: orchestrator.getDelegation(input.id),
    })),
    'delegations.cancel': method(
      delegationIdInputSchema,
      delegationGetOutputSchema,
      async (input) => ({ delegation: orchestrator.cancelDelegation(input.id) }),
    ),

    'grants.list': method(grantsListInputSchema, grantsListOutputSchema, async (input) => ({
      grants: domain.grants.listActive(input.conversationId),
    })),
    'grants.revoke': method(grantIdInputSchema, okOutputSchema, async (input) => {
      const grant = domain.grants.revoke(input.id);
      if (grant) {
        publish('grant.changed', {
          conversationId: grant.conversationId,
          grants: domain.grants.listActive(grant.conversationId),
        });
      }
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

    'projects.list': method(voidInput, projectsListOutputSchema, async () => ({
      projects: domain.projects.listRecent(),
    })),
    'projects.get': method(projectsGetInputSchema, projectsGetOutputSchema, async (input) => {
      const project = domain.projects.get(input.id);
      return { project: project !== null ? domain.projects.refreshStatus(project.id) : null };
    }),
    'projects.select': method(
      projectsSelectInputSchema,
      projectsSelectOutputSchema,
      async (input) => {
        const project = services.projectRuntime!.select(input.conversationId, input.path);
        publish('conversation.updated', {
          conversation: domain.conversations.getOrThrow(input.conversationId),
        });
        publish('project.updated', { project });
        return { project };
      },
    ),
    'projects.unbind': method(projectsUnbindInputSchema, okOutputSchema, async (input) => {
      services.projectRuntime!.unbind(input.conversationId);
      publish('conversation.updated', {
        conversation: domain.conversations.getOrThrow(input.conversationId),
      });
      return { ok: true as const };
    }),
    'projects.update': method(
      projectsUpdateInputSchema,
      projectsGetOutputSchema,
      async (input) => ({
        project: services.projectRuntime!.update(input.id, {
          ...(input.protectRules !== undefined ? { protectRules: input.protectRules } : {}),
          ...(input.allowedPorts !== undefined ? { allowedPorts: input.allowedPorts } : {}),
        }),
      }),
    ),
    'projects.remove': method(projectsRemoveInputSchema, okOutputSchema, async (input) => {
      await services.projectRuntime!.remove(input.id);
      return { ok: true as const };
    }),
    'projects.diff': method(projectsDiffInputSchema, projectsDiffOutputSchema, async (input) =>
      services.projectRuntime!.diff(input.runId),
    ),
    'projects.revert': method(
      projectsRevertInputSchema,
      projectsRevertOutputSchema,
      async (input) => services.projectRuntime!.revert(input.runId, input.force === true),
    ),
    'projects.revokeLease': method(
      projectsRevokeLeaseInputSchema,
      projectsRevokeLeaseOutputSchema,
      async (input) => ({
        revoked: await services.projectRuntime!.revokeLease(input.conversationId),
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
        }
      >();
      for (const entry of services.domain!.usage.entriesSince(since)) {
        const date = localDateKey(new Date(entry.createdAt), timeZone);
        const key = `${entry.botId ?? ''}|${entry.loopType}|${date}`;
        const bucket = buckets.get(key) ?? {
          botId: entry.botId,
          loopType: entry.loopType,
          date,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
        };
        bucket.inputTokens += entry.inputTokens;
        bucket.outputTokens += entry.outputTokens;
        if (entry.costUsd !== null) bucket.costUsd = (bucket.costUsd ?? 0) + entry.costUsd;
        buckets.set(key, bucket);
      }
      return { entries: [...buckets.values()] };
    }),

    'budget.get': method(voidInput, budgetGetOutputSchema, async () => ({
      tokens: services.budget!.limit(),
    })),
    'budget.update': method(budgetUpdateInputSchema, budgetGetOutputSchema, async (input) => {
      services.domain!.settings.update({ backgroundBudgetTokens: input.tokens });
      return { tokens: services.budget!.limit() };
    }),

    'embedding.status': method(voidInput, embeddingStatusOutputSchema, async () =>
      services.memory!.embeddingStatus(),
    ),
    'embedding.configure': method(
      embeddingConfigureInputSchema,
      embeddingStatusOutputSchema,
      async (input) => services.memory!.configureEmbedding(input),
    ),

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

    // --- wiki (P09) --------------------------------------------------------
    'wiki.tree': method(wikiBotIdInputSchema, wikiTreeOutputSchema, async (input) => ({
      pages: services.wiki!.tree(input.botId),
    })),
    'wiki.page': method(wikiPageInputSchema, wikiPageOutputSchema, async (input) =>
      services.wiki!.readPage(input.botId, input.path),
    ),
    'wiki.search': method(wikiSearchInputSchema, wikiSearchOutputSchema, async (input) => ({
      hits: services.wiki!.search(input.botId, input.query, input.limit ?? 20),
    })),
    'wiki.history': method(wikiBotIdInputSchema, wikiHistoryOutputSchema, async (input) => ({
      history: await services.wiki!.history(input.botId),
    })),
    'wiki.rollback': method(wikiRollbackInputSchema, wikiRollbackOutputSchema, async (input) => {
      await services.wiki!.rollback(input.botId, input.commitOid);
      return { ok: true as const };
    }),
    // 用户在右栏删除一页：同样是追加式新提交（可回滚恢复），与维护互斥。
    'wiki.deletePage': method(
      wikiDeletePageInputSchema,
      wikiDeletePageOutputSchema,
      async (input) => {
        await services.wiki!.deletePage(input.botId, input.path);
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
  };
}
