<script lang="ts">
  import type { Approval } from '@kepcup/shared';
  import {
    agentToolApprovalPayloadSchema,
    butlerProposalPayloadSchema,
    describeScheduleWhen,
    skillImportApprovalPayloadSchema,
    skillPresetApprovalPayloadSchema,
    mcpToolApprovalPayloadSchema,
    type SkillImportApprovalPayload,
  } from '@kepcup/shared';
  import {
    ShieldAlert,
    TerminalSquare,
    FileWarning,
    ShieldCheck,
    ShieldX,
    Clock,
    Package,
    Puzzle,
    Plug,
    AlertTriangle,
    Users,
    Bot,
  } from '@lucide/svelte';
  import { t, type MessageKey } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { environmentStore } from '$lib/stores/environment.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import McpRiskBadge from './McpRiskBadge.svelte';
  import {
    approvalEffectLine,
    decisionBinding,
    priorEffectFlag,
    priorEffectOf,
    receiptText,
  } from './approval-effect';

  let {
    approval,
    autofocus = false,
    /** 'folded' renders the collapsed one-line record (message flow). */
    variant = 'card',
  }: { approval: Approval; autofocus?: boolean; variant?: 'card' | 'folded' } = $props();

  const pending = $derived(approval.status === 'pending');
  const access = $derived(
    approval.kind === 'access' ? (approval.payload['access'] === 'write' ? 'write' : 'read') : null,
  );
  const path = $derived(String(approval.payload['path'] ?? ''));
  const command = $derived(String(approval.payload['command'] ?? ''));
  const cwd = $derived(String(approval.payload['cwd'] ?? ''));
  const reason = $derived(String(approval.payload['reason'] ?? ''));
  const sensitive = $derived(approval.payload['sensitive'] === true);

  let cardEl: HTMLDivElement | undefined = $state();
  let duration = $state<'once' | 'conversation'>('once');

  // D72 P3 agent_tool payload：外部智能体的工具权限请求 / 项目内 Agent 配置确认。
  const agentTool = $derived.by(() => {
    if (approval.kind !== 'agent_tool') return null;
    const parsed = agentToolApprovalPayloadSchema.safeParse(approval.payload);
    return parsed.success ? parsed.data : null;
  });
  /** 路径类 agent_tool 可选「本对话内」（记为访问授权）；命令类只有「仅这一次」。 */
  const agentToolDurations = $derived(
    agentTool !== null &&
      agentTool.kind !== 'config' &&
      agentTool.durations.includes('conversation'),
  );
  /** 卡片是否显示「仅这一次 / 本对话内」选择。 */
  const choosesDuration = $derived(access !== null || agentToolDurations);

  $effect(() => {
    if (autofocus && pending && cardEl) cardEl.focus();
  });

  // D70 butler_proposal payload: 组队 / 建 Bot / 建群提议（条目可勾选）。
  const butlerProposal = $derived.by(() => {
    if (approval.kind !== 'butler_proposal') return null;
    const parsed = butlerProposalPayloadSchema.safeParse(approval.payload);
    return parsed.success ? parsed.data : null;
  });
  /** Indexes of proposed bots the user unchecked (default: keep everything). */
  let butlerDropped = $state<number[]>([]);
  const butlerKept = $derived(
    butlerProposal !== null && butlerProposal.proposalType !== 'group'
      ? butlerProposal.bots
          .map((_, index) => index)
          .filter((index) => !butlerDropped.includes(index))
      : [],
  );

  function toggleButlerItem(index: number): void {
    butlerDropped = butlerDropped.includes(index)
      ? butlerDropped.filter((i) => i !== index)
      : [...butlerDropped, index];
  }

  // W4：决定绑定到卡片渲染时的内容（payloadHash；不符 → APPROVAL_STALE）。
  const boundHash = $derived(decisionBinding(approval).payloadHash);

  /** D80: routines the user unchecked, as "{botIndex}:{routineIndex}". */
  let routinesDropped = $state<string[]>([]);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function toggleRoutine(key: string): void {
    routinesDropped = routinesDropped.includes(key)
      ? routinesDropped.filter((k) => k !== key)
      : [...routinesDropped, key];
  }

  function routineWhen(routine: { when: string; timezone: string | null }): string {
    const iso = /^\d{4}-\d{2}-\d{2}/.test(routine.when) ? Date.parse(routine.when) : NaN;
    return Number.isNaN(iso)
      ? describeScheduleWhen(
          { kind: 'cron', cron: routine.when, runAt: null, timezone: routine.timezone ?? localTimeZone },
          { localTimeZone },
        )
      : describeScheduleWhen({ kind: 'once', runAt: iso, cron: null, timezone: localTimeZone }, { now: Date.now() });
  }

  /** Pending: the local choice; decided: what the decision kept. */
  function routineChecked(botIndex: number, key: string): boolean {
    if (pending) return !routinesDropped.includes(key) && !butlerDropped.includes(botIndex);
    const decision = approval.decision;
    if (approval.status !== 'approved' || decision === null) return false;
    if (decision.selection !== undefined && !decision.selection.includes(botIndex)) return false;
    return decision.routineSelection === undefined || decision.routineSelection.includes(key);
  }

  /** Kept routine keys of the kept bots; undefined when the proposal has none. */
  const routinesKept = $derived.by(() => {
    if (butlerProposal === null || butlerProposal.proposalType === 'group') return undefined;
    const keys = butlerProposal.bots.flatMap((bot, botIndex) =>
      bot.routines.map((_, routineIndex) => `${botIndex}:${routineIndex}`),
    );
    if (keys.length === 0) return undefined;
    return keys.filter(
      (key) => !routinesDropped.includes(key) && butlerKept.includes(Number(key.split(':')[0])),
    );
  });

  function approve(): void {
    if (butlerProposal !== null && butlerProposal.proposalType !== 'group') {
      // 一项都不留 = 拒绝（core 同样按拒绝处理）。
      void permissions.decide(
        approval.id,
        butlerKept.length > 0,
        undefined,
        butlerKept,
        boundHash,
        routinesKept,
      );
      return;
    }
    void permissions.decide(
      approval.id,
      true,
      choosesDuration ? duration : undefined,
      undefined,
      boundHash,
    );
  }

  function deny(): void {
    void permissions.decide(approval.id, false, undefined, undefined, boundHash);
  }

  // W4 回执：已批准的卡片底部显示执行结果（已完成 / 失败 / 结果未知 / 已拒绝 /
  // 执行中）；去重门的「上次同样的操作结果未知」提示在待决卡片顶部。
  const effectLine = $derived(approvalEffectLine(approval));
  const effectReceipt = $derived(receiptText(approval.effect?.receipt));
  const priorEffect = $derived(priorEffectOf(approval));
  const priorFlag = $derived(priorEffectFlag(approval));
  const priorReceipt = $derived(receiptText(priorEffect?.receipt));

  function onKeydown(event: KeyboardEvent): void {
    if (!pending) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      approve();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      deny();
    } else if (choosesDuration && event.key === '1') {
      duration = 'once';
    } else if (choosesDuration && event.key === '2') {
      duration = 'conversation';
    }
  }

  const gitRemoteOp = $derived(String(approval.payload['operation'] ?? ''));
  const gitRemoteArgs = $derived(
    Array.isArray(approval.payload['args']) ? (approval.payload['args'] as string[]).join(' ') : '',
  );

  // P06 environment payload (name / version / size / source / reason).
  const envItem = $derived(String(approval.payload['item'] ?? ''));
  const envDisplayName = $derived(String(approval.payload['displayName'] ?? '') || envItem);
  const envVersion = $derived(String(approval.payload['version'] ?? ''));
  const envSizeBytes = $derived(Number(approval.payload['sizeBytes'] ?? 0));
  const envSource = $derived(String(approval.payload['source'] ?? ''));
  const envObtain = $derived(String(approval.payload['obtain'] ?? 'archive'));
  const envSystemCommand = $derived(String(approval.payload['systemCommand'] ?? ''));
  // D72 外部智能体条目（`agent:{id}`）：许可证与条款提示。
  const envLicense = $derived(String(approval.payload['license'] ?? ''));
  const envTermsKey = $derived(String(approval.payload['termsNoticeKey'] ?? ''));
  const envTermsText = $derived.by(() => {
    if (envTermsKey.length === 0) return '';
    const text = t(envTermsKey as MessageKey);
    return text === envTermsKey ? t('agents.termsGeneric') : text;
  });
  // Install row linked to this approval (exists once the install started).
  const envProgress = $derived(
    environmentStore.installs.find((install) => install.approvalId === approval.id),
  );
  const envProgressEvent = $derived(
    envProgress !== undefined ? (environmentStore.progress[envProgress.id] ?? null) : null,
  );
  const envPercent = $derived.by(() => {
    const event = envProgressEvent;
    if (event === null || event.totalBytes === undefined || event.totalBytes <= 0) return null;
    const received = event.receivedBytes ?? 0;
    return Math.min(100, Math.round((received / event.totalBytes) * 100));
  });

  function envSizeText(bytes: number): string {
    if (bytes <= 0) return '';
    if (bytes >= 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  // P08 skill_import payload: source / commit / scan results (兼容性、依赖、风险).
  const skillImport = $derived.by(() => {
    if (approval.kind !== 'skill_import') return null;
    const parsed = skillImportApprovalPayloadSchema.safeParse(approval.payload);
    return parsed.success ? parsed.data : null;
  });
  // D63 skill_preset payload: 内置推荐技能的轻授权卡（名称/摘要/版本/缺失依赖）。
  const skillPreset = $derived.by(() => {
    if (approval.kind !== 'skill_preset') return null;
    const parsed = skillPresetApprovalPayloadSchema.safeParse(approval.payload);
    return parsed.success ? parsed.data : null;
  });
  // D65 mcp_tool payload: MCP 工具调用卡（服务器/工具/参数摘要）。
  const mcpTool = $derived.by(() => {
    if (approval.kind !== 'mcp_tool') return null;
    const parsed = mcpToolApprovalPayloadSchema.safeParse(approval.payload);
    return parsed.success ? parsed.data : null;
  });
  const skillCompatKeys: Record<SkillImportApprovalPayload['scan']['compatibility'], MessageKey> = {
    compatible: 'skills.compat.compatible',
    partial: 'skills.compat.partial',
    incompatible: 'skills.compat.incompatible',
  };

  const agentToolTitle = $derived(
    agentTool === null
      ? t('approvals.agentToolTitle')
      : agentTool.kind === 'config'
        ? t('approvals.agentToolConfigTitle')
        : agentTool.kind === 'read'
          ? t('approvals.agentToolReadTitle')
          : agentTool.kind === 'write'
            ? t('approvals.agentToolWriteTitle')
            : agentTool.kind === 'execute'
              ? t('approvals.agentToolExecuteTitle')
              : t('approvals.agentToolTitle'),
  );
  const agentToolAgentName = $derived(
    agentTool !== null ? agentTool.agentName || agentTool.agentId : '',
  );

  const title = $derived(
    approval.kind === 'access'
      ? t('approvals.accessTitle')
      : approval.kind === 'unsandboxed'
        ? t('approvals.unsandboxedTitle')
        : approval.kind === 'git_remote'
          ? t('approvals.gitRemoteTitle')
          : approval.kind === 'environment'
            ? t('approvals.environmentTitle')
            : approval.kind === 'skill_import'
              ? t('approvals.skillImportTitle')
              : approval.kind === 'skill_preset'
                ? t('approvals.skillPresetTitle')
                : approval.kind === 'mcp_tool'
                  ? t('approvals.mcpToolTitle')
                  : approval.kind === 'agent_tool'
                    ? agentToolTitle
                    : approval.kind === 'butler_proposal'
                      ? butlerProposal?.proposalType === 'group'
                        ? t('approvals.butlerGroupTitle')
                        : butlerProposal?.proposalType === 'bot'
                          ? t('approvals.butlerBotTitle')
                          : t('approvals.butlerTeamTitle')
                      : t('approvals.commandTitle'),
  );
</script>

{#if variant === 'folded' || !pending}
  <!-- 处理后折叠为一行记录（docs/design/12-ui-layout.md 焦点三） -->
  <div
    class="mx-auto flex w-full max-w-3xl items-center gap-2 px-3 py-1 text-xs text-muted-foreground"
    data-testid={`approval-record-${approval.id}`}
    data-approval-status={approval.status}
  >
    {#if approval.status === 'approved'}
      <ShieldCheck class="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
      {#if approval.autoApproved}
        <span>{title} · {t('approvals.foldedAutoApproved')}</span>
      {:else if choosesDuration && approval.decision?.duration === 'conversation'}
        <span>{title} · {t('approvals.foldedApprovedConversation')}</span>
      {:else}
        <span>{title} · {t('approvals.foldedApprovedOnce')}</span>
      {/if}
    {:else if approval.status === 'denied'}
      <ShieldX class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <span>{title} · {t('approvals.foldedDenied')}</span>
    {:else if approval.status === 'failed'}
      <!-- BR-P08-004: 批准后的落位动作失败，卡片终态如实呈现 -->
      <AlertTriangle class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
      <span data-testid="approval-failed-reason">
        {title} · {t('approvals.foldedFailed')}
        {#if approval.decision?.error}（{approval.decision.error}）{/if}
      </span>
    {:else}
      <Clock class="size-3.5 shrink-0" aria-hidden="true" />
      <span>{title} · {t('approvals.foldedCancelled')}</span>
    {/if}
    {#if access !== null}
      <Badge variant="outline" class="shrink-0 text-[10px]"
        >{t(access === 'write' ? 'approvals.accessWrite' : 'approvals.accessRead')}</Badge
      >
      <code class="min-w-0 flex-1 truncate">{path}</code>
    {:else}
      {#if mcpTool?.risk !== undefined}
        <McpRiskBadge risk={mcpTool.risk} />
      {/if}
      <code class="min-w-0 flex-1 truncate">
        {approval.kind === 'git_remote'
          ? `git ${gitRemoteOp} ${gitRemoteArgs}`.trim()
          : approval.kind === 'environment'
            ? `${envDisplayName} ${envVersion}`.trim()
            : approval.kind === 'skill_import'
              ? `${skillImport?.name ?? ''} ${skillImport?.sourceUrl ?? ''}`.trim()
              : approval.kind === 'skill_preset'
                ? (skillPreset?.displayName ?? skillPreset?.name ?? '')
                : approval.kind === 'mcp_tool'
                  ? `${mcpTool?.serverName ?? ''} · ${mcpTool?.toolName ?? ''}`.trim()
                  : approval.kind === 'agent_tool'
                    ? `${agentToolAgentName} · ${agentTool?.command ?? (agentTool?.locations.join('、') || agentTool?.title) ?? ''}`
                    : approval.kind === 'butler_proposal'
                      ? butlerProposal?.proposalType === 'group'
                        ? butlerProposal.title
                        : (butlerProposal?.bots
                            .filter(
                              (_, index) =>
                                approval.decision?.selection === undefined ||
                                approval.decision.selection.includes(index),
                            )
                            .map((bot) => bot.name)
                            .join('、') ?? '')
                      : command}
      </code>
    {/if}
    {#if effectLine !== null}
      <span
        class={`shrink-0 ${
          effectLine === 'completed'
            ? 'text-emerald-700 dark:text-emerald-400'
            : effectLine === 'uncertain'
              ? 'text-amber-700 dark:text-amber-400'
              : effectLine === 'failed'
                ? 'text-destructive'
                : ''
        }`}
        data-testid="approval-effect-status"
        data-effect-status={effectLine}
        title={effectReceipt ?? undefined}
        >{t(`approvals.effect.${effectLine}`)}{#if effectReceipt !== null}<span
            class="ml-1 text-muted-foreground"
            data-testid="approval-effect-receipt">{effectReceipt}</span
          >{/if}</span
      >
    {/if}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <!-- 有意为之：审批卡片是一个可聚焦的 group，键盘快捷键（P02 审批键盘流）
       绑定在卡片上；DOM 与语义保持不变。 -->
  <div
    bind:this={cardEl}
    onkeydown={onKeydown}
    tabindex="0"
    role="group"
    class="mx-auto w-full max-w-3xl rounded-lg border-2 border-amber-500/70 bg-amber-50/60 p-3 text-sm shadow-sm backdrop-blur outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:bg-amber-950/30"
    data-testid={`approval-card-${approval.id}`}
    data-approval-kind={approval.kind}
    data-approval-status={approval.status}
  >
    <div class="mb-2 flex items-center gap-2 font-medium">
      {#if approval.kind === 'access'}
        {#if sensitive}<FileWarning class="size-4 text-destructive" aria-hidden="true" />
        {:else}<ShieldAlert class="size-4 text-amber-600" aria-hidden="true" />{/if}
      {:else if approval.kind === 'environment'}
        <Package class="size-4 text-amber-600" aria-hidden="true" />
      {:else if approval.kind === 'skill_import' || approval.kind === 'skill_preset'}
        <Puzzle class="size-4 text-amber-600" aria-hidden="true" />
      {:else if approval.kind === 'mcp_tool'}
        <Plug class="size-4 text-amber-600" aria-hidden="true" />
      {:else if approval.kind === 'butler_proposal'}
        <Users class="size-4 text-amber-600" aria-hidden="true" />
      {:else if approval.kind === 'agent_tool'}
        {#if agentTool?.sensitive}<FileWarning class="size-4 text-destructive" aria-hidden="true" />
        {:else}<Bot class="size-4 text-amber-600" aria-hidden="true" />{/if}
      {:else}
        <TerminalSquare class="size-4 text-amber-600" aria-hidden="true" />
      {/if}
      <span>{title}</span>
      {#if mcpTool?.risk !== undefined}
        <McpRiskBadge risk={mcpTool.risk} testid="approval-mcp-risk" />
      {/if}
      <span class="ml-auto text-[11px] font-normal text-muted-foreground"
        >{t('approvals.focusHint')}</span
      >
    </div>

    {#if priorFlag !== null}
      <p
        class="mb-2 flex items-start gap-1.5 rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
        data-testid={priorFlag === 'uncertain' ? 'approval-prior-uncertain' : 'approval-prior-completed'}
      >
        <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span
          >{priorFlag === 'uncertain'
            ? t('approvals.priorUncertain')
            : t('approvals.priorCompleted', {
                receipt: priorReceipt ?? t('approvals.priorCompletedNoReceipt'),
              })}</span
        >
      </p>
    {/if}

    {#if access !== null}
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span class="text-muted-foreground">{t('approvals.path')}</span>
        <code class="break-all" data-testid="approval-path">{path}</code>
        <span class="text-muted-foreground">{t('approvals.botPrefix')}</span>
        <span>{t(access === 'write' ? 'approvals.accessWrite' : 'approvals.accessRead')}</span>
        {#if reason.length > 0}
          <span class="text-muted-foreground">{t('approvals.reason')}</span>
          <span class="break-all">{reason}</span>
        {/if}
      </div>
      {#if sensitive}
        <p
          class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="approval-sensitive-warning"
        >
          {t('approvals.sensitiveWarning')}
        </p>
      {/if}
      <div class="mt-2 flex items-center gap-2 text-xs" data-testid="approval-duration">
        <button
          type="button"
          class="rounded-md border px-2 py-1 {duration === 'once'
            ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/50'
            : ''}"
          onclick={() => (duration = 'once')}
          data-testid="duration-once"
        >
          1 · {t('approvals.once')}
        </button>
        <button
          type="button"
          class="rounded-md border px-2 py-1 {duration === 'conversation'
            ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/50'
            : ''}"
          onclick={() => (duration = 'conversation')}
          data-testid="duration-conversation"
        >
          2 · {t('approvals.conversation')}
        </button>
        <span class="text-muted-foreground">{t('approvals.durationHint')}</span>
      </div>
    {:else if approval.kind === 'environment'}
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="approval-environment">
        <span class="text-muted-foreground">{t('approvals.environmentItem')}</span>
        <span data-testid="approval-environment-item">{envDisplayName} {envVersion}</span>
        {#if envSizeBytes > 0}
          <span class="text-muted-foreground">{t('approvals.environmentSize')}</span>
          <span data-testid="approval-environment-size">{envSizeText(envSizeBytes)}</span>
        {/if}
        {#if envSource.length > 0}
          <span class="text-muted-foreground">{t('approvals.environmentSource')}</span>
          <span class="break-all" data-testid="approval-environment-source">{envSource}</span>
        {/if}
        {#if envLicense.length > 0}
          <span class="text-muted-foreground">{t('approvals.environmentLicense')}</span>
          <span data-testid="approval-environment-license">{envLicense}</span>
        {/if}
        {#if reason.length > 0}
          <span class="text-muted-foreground">{t('approvals.reason')}</span>
          <span class="break-all">{reason}</span>
        {/if}
      </div>
      {#if envTermsText.length > 0}
        <p
          class="mt-2 text-xs text-amber-600 dark:text-amber-400"
          data-testid="approval-environment-terms"
        >
          {envTermsText}
        </p>
      {/if}
      {#if envObtain === 'system'}
        {#if envSystemCommand.length > 0}
          <p
            class="mt-2 rounded bg-muted px-2 py-1 text-xs"
            data-testid="approval-environment-system-command"
          >
            {t('approvals.environmentSystemHint')}
            <code class="mt-1 block break-all">{envSystemCommand}</code>
          </p>
        {:else}
          <p
            class="mt-2 rounded bg-muted px-2 py-1 text-xs"
            data-testid="approval-environment-system-hint"
          >
            {t('approvals.environmentMacHint')}
          </p>
        {/if}
      {:else}
        <p class="mt-2 text-xs text-muted-foreground">{t('approvals.environmentNote')}</p>
      {/if}
      {#if envProgress !== undefined}
        <div class="mt-2" data-testid="approval-environment-progress">
          {#if envProgress.status === 'installing'}
            <div class="mb-1 flex items-center justify-between text-xs text-muted-foreground">
              <span
                >{envProgressEvent === null
                  ? t('approvals.environmentPreparing')
                  : t(`approvals.envStage.${envProgressEvent.stage}`)}</span
              >
              {#if envPercent !== null}<span>{envPercent}%</span>{/if}
            </div>
            <div class="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                class="h-full rounded-full bg-amber-500 transition-all"
                style="width: {envPercent ?? 8}%"
                data-testid="approval-environment-progress-bar"
              ></div>
            </div>
          {:else if envProgress.status === 'failed'}
            <p
              class="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
              data-testid="approval-environment-failed"
            >
              {t('approvals.environmentFailed')}
            </p>
          {:else if envProgress.status === 'installed'}
            <p
              class="rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700"
              data-testid="approval-environment-done"
            >
              {t('approvals.environmentDone')}
            </p>
          {/if}
        </div>
      {/if}
    {:else if approval.kind === 'skill_import' && skillImport !== null}
      <!-- 导入审批卡片：扫描结果（来源、commit、兼容性、依赖、风险，P08 任务 3） -->
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="approval-skill-import">
        <span class="text-muted-foreground">{t('approvals.skillImportName')}</span>
        <span data-testid="approval-skill-name">{skillImport.name}</span>
        {#if skillImport.description.length > 0}
          <span class="text-muted-foreground">{t('approvals.skillImportDescription')}</span>
          <span class="break-all" data-testid="approval-skill-description"
            >{skillImport.description}</span
          >
        {/if}
        <span class="text-muted-foreground">{t('approvals.skillImportSource')}</span>
        <code class="break-all" data-testid="approval-skill-source">{skillImport.sourceUrl}</code>
        <span class="text-muted-foreground">{t('approvals.skillImportCommit')}</span>
        <code data-testid="approval-skill-commit">{skillImport.commitOid.slice(0, 10)}</code>
        {#if skillImport.ref.length > 0}
          <span class="text-muted-foreground">{t('approvals.skillImportRef')}</span>
          <span data-testid="approval-skill-ref">{skillImport.ref}</span>
        {/if}
        {#if skillImport.subdirectory.length > 0}
          <span class="text-muted-foreground">{t('approvals.skillImportSubdirectory')}</span>
          <code data-testid="approval-skill-subdirectory">{skillImport.subdirectory}</code>
        {/if}
        <span class="text-muted-foreground">{t('approvals.skillImportCompat')}</span>
        <span class="flex flex-wrap items-center gap-1.5" data-testid="approval-skill-compat">
          <Badge
            variant={skillImport.scan.compatibility === 'compatible' ? 'secondary' : 'destructive'}
          >
            {t(skillCompatKeys[skillImport.scan.compatibility])}
          </Badge>
          {#each skillImport.scan.compatibilityReasons as reason (reason)}
            <span class="text-xs text-muted-foreground">{reason}</span>
          {/each}
        </span>
        <span class="text-muted-foreground">{t('approvals.skillImportDeps')}</span>
        <span data-testid="approval-skill-deps">
          {skillImport.scan.runtimeDeps.length > 0
            ? skillImport.scan.runtimeDeps.join('、')
            : t('approvals.skillImportDepsNone')}
        </span>
        {#if skillImport.missingDeps.length > 0}
          <span class="text-amber-700 dark:text-amber-400">{t('approvals.skillImportMissing')}</span
          >
          <span class="text-amber-700 dark:text-amber-400" data-testid="approval-skill-missing">
            {skillImport.missingDeps.join('、')}
            <span class="text-xs">{t('approvals.skillImportMissingHint')}</span>
          </span>
        {/if}
        <span class="text-muted-foreground">{t('approvals.skillImportPermissions')}</span>
        <span data-testid="approval-skill-permissions">
          {skillImport.scan.declaredPermissions.network ||
          skillImport.scan.declaredPermissions.credentials
            ? skillImport.scan.declaredPermissions.notes.join('、')
            : t('approvals.skillImportPermissionsNone')}
        </span>
      </div>
      {#if skillImport.scan.risks.length > 0}
        <div
          class="mt-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
          data-testid="approval-skill-risks"
        >
          <p class="font-medium">{t('approvals.skillImportRisks')}</p>
          <ul class="mt-0.5 list-inside list-disc">
            {#each skillImport.scan.risks as risk (risk)}
              <li>{risk}</li>
            {/each}
          </ul>
        </div>
      {/if}
      <p class="mt-2 text-xs text-muted-foreground" data-testid="approval-skill-note">
        {t('approvals.skillImportNote')}
      </p>
    {:else if approval.kind === 'skill_preset' && skillPreset !== null}
      <!-- 预置技能安装卡（docs/design/22-file-skill-routing.md）：应用内置推荐，
           发布前经同一静态扫描——轻授权，确认即安装为公共技能 -->
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="approval-skill-preset">
        <span class="text-muted-foreground">{t('approvals.skillPresetName')}</span>
        <span data-testid="approval-skill-preset-name">
          {skillPreset.displayName}
          <span class="text-xs text-muted-foreground"
            >({skillPreset.name} · v{skillPreset.version})</span
          >
        </span>
        <span class="text-muted-foreground">{t('approvals.skillPresetSummary')}</span>
        <span class="break-all" data-testid="approval-skill-preset-summary"
          >{skillPreset.summary}</span
        >
        <span class="text-muted-foreground">{t('approvals.skillPresetSource')}</span>
        <span data-testid="approval-skill-preset-source"
          >{t('approvals.skillPresetSourceValue')}</span
        >
        {#if skillPreset.missingDeps.length > 0}
          <span class="text-amber-700 dark:text-amber-400">{t('approvals.skillImportMissing')}</span
          >
          <span
            class="text-amber-700 dark:text-amber-400"
            data-testid="approval-skill-preset-missing"
          >
            {skillPreset.missingDeps.join('、')}
            <span class="text-xs">{t('approvals.skillImportMissingHint')}</span>
          </span>
        {/if}
      </div>
      <p class="mt-2 text-xs text-muted-foreground" data-testid="approval-skill-preset-note">
        {t('approvals.skillPresetNote')}
      </p>
    {:else if approval.kind === 'butler_proposal' && butlerProposal !== null}
      <!-- 管家提议卡（D70）：组队 / 建 Bot 的条目可勾选，确认后由系统确定性创建 -->
      {#if butlerProposal.proposalType === 'group'}
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="approval-butler-group">
          <span class="text-muted-foreground">{t('approvals.butlerGroupName')}</span>
          <span data-testid="approval-butler-group-title">{butlerProposal.title}</span>
          {#if butlerProposal.description.length > 0}
            <span class="text-muted-foreground">{t('approvals.butlerGroupPurpose')}</span>
            <span class="break-all">{butlerProposal.description}</span>
          {/if}
          <span class="text-muted-foreground">{t('approvals.butlerGroupMembers')}</span>
          <span data-testid="approval-butler-group-members">
            {butlerProposal.memberBotIds
              .map((id) => contacts.bots.find((bot) => bot.id === id)?.name ?? id)
              .join('、')}
          </span>
          {#if butlerProposal.reason.length > 0}
            <span class="text-muted-foreground">{t('approvals.reason')}</span>
            <span class="break-all">{butlerProposal.reason}</span>
          {/if}
        </div>
      {:else}
        {#if butlerProposal.note.length > 0}
          <p class="mb-2 text-xs text-muted-foreground">{butlerProposal.note}</p>
        {/if}
        <ul class="grid gap-1.5" data-testid="approval-butler-bots">
          {#each butlerProposal.bots as bot, index (index)}
            <li>
              <label
                class="flex cursor-pointer items-start gap-2 rounded-md border bg-background/60 p-2"
                data-testid={`approval-butler-bot-${index}`}
              >
                <input
                  type="checkbox"
                  class="mt-0.5"
                  checked={!butlerDropped.includes(index)}
                  onchange={() => toggleButlerItem(index)}
                  data-testid={`approval-butler-bot-check-${index}`}
                />
                <span class="grid min-w-0 gap-0.5">
                  <span class="font-medium">{bot.name}</span>
                  {#if bot.bio.length > 0}<span class="text-xs">{bot.bio}</span>{/if}
                  <span class="text-xs text-muted-foreground"
                    >{t('approvals.butlerResponsibilities')}：{bot.responsibilities}</span
                  >
                  {#if bot.reason.length > 0}
                    <span class="text-xs text-muted-foreground"
                      >{t('approvals.reason')}：{bot.reason}</span
                    >
                  {/if}
                </span>
              </label>
              {#if bot.routines.length > 0}
                <!-- D80 例行事项：确认后建到这个 Bot 的私聊里，可单独勾掉 -->
                <ul class="mt-1 ml-6 grid gap-1" data-testid={`approval-butler-routines-${index}`}>
                  {#each bot.routines as routine, routineIndex (routineIndex)}
                    {@const key = `${index}:${routineIndex}`}
                    <li>
                      <label
                        class="flex cursor-pointer items-center gap-2 text-xs {butlerDropped.includes(index)
                          ? 'opacity-50'
                          : ''}"
                      >
                        <input
                          type="checkbox"
                          checked={routineChecked(index, key)}
                          disabled={!pending || butlerDropped.includes(index)}
                          onchange={() => toggleRoutine(key)}
                          data-testid={`approval-butler-routine-check-${key}`}
                        />
                        <span
                          >{t('approvals.butlerRoutine', {
                            when: routineWhen(routine),
                            title: routine.title,
                          })}</span
                        >
                      </label>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="mt-2 text-xs text-muted-foreground">{t('approvals.butlerNote')}</p>
      {/if}
    {:else if approval.kind === 'agent_tool' && agentTool !== null}
      <!-- 外部智能体工具权限卡（D72 P3，design 28 §6）：Agent 标识、工具标题、
           类别、路径 / 命令原文；路径类可选「本对话内」（记为访问授权） -->
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="approval-agent-tool">
        <span class="text-muted-foreground">{t('approvals.agentToolAgent')}</span>
        <span data-testid="approval-agent-tool-agent">{agentToolAgentName}</span>
        {#if agentTool.kind !== 'config'}
          {#if agentTool.title.length > 0}
            <span class="text-muted-foreground">{t('approvals.agentToolTool')}</span>
            <span class="break-all" data-testid="approval-agent-tool-title">{agentTool.title}</span>
          {/if}
          <span class="text-muted-foreground">{t('approvals.agentToolCategory')}</span>
          <span data-testid="approval-agent-tool-category"
            >{t(`approvals.agentToolCategory.${agentTool.kind}` as MessageKey)}</span
          >
        {/if}
        {#if agentTool.command !== undefined}
          <span class="text-muted-foreground">{t('approvals.command')}</span>
          <code class="break-all whitespace-pre-wrap" data-testid="approval-agent-tool-command"
            >{agentTool.command}</code
          >
          {#if agentTool.cwd.length > 0}
            <span class="text-muted-foreground">{t('approvals.cwd')}</span>
            <code class="break-all">{agentTool.cwd}</code>
          {/if}
        {/if}
        {#if agentTool.locations.length > 0}
          <span class="text-muted-foreground"
            >{agentTool.kind === 'config'
              ? t('approvals.agentToolConfigFiles')
              : t('approvals.agentToolPaths')}</span
          >
          <span class="grid gap-0.5" data-testid="approval-agent-tool-paths">
            {#each agentTool.locations as location, index (index)}
              <code class="break-all">{location}</code>
            {/each}
          </span>
        {/if}
        {#if agentTool.kind === 'config' && agentTool.projectPath !== undefined}
          <span class="text-muted-foreground">{t('approvals.cwd')}</span>
          <code class="break-all">{agentTool.projectPath}</code>
        {/if}
        {#if agentTool.reason.length > 0}
          <span class="text-muted-foreground">{t('approvals.reason')}</span>
          <span class="break-all">{agentTool.reason}</span>
        {/if}
      </div>
      {#if agentTool.sensitive}
        <p
          class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="approval-sensitive-warning"
        >
          {t('approvals.sensitiveWarning')}
        </p>
      {/if}
      {#if agentTool.targetUncertain === true}
        <p
          class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="approval-agent-tool-target-uncertain"
        >
          {t('approvals.agentToolTargetUncertain')}
        </p>
      {/if}
      <p
        class="mt-2 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-300"
        data-testid="approval-agent-tool-note"
      >
        {agentTool.kind === 'config'
          ? t('approvals.agentToolConfigNote')
          : t('approvals.agentToolRisk')}
      </p>
      {#if agentToolDurations}
        <div class="mt-2 flex items-center gap-2 text-xs" data-testid="approval-duration">
          <button
            type="button"
            class="rounded-md border px-2 py-1 {duration === 'once'
              ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/50'
              : ''}"
            onclick={() => (duration = 'once')}
            data-testid="duration-once"
          >
            1 · {t('approvals.once')}
          </button>
          <button
            type="button"
            class="rounded-md border px-2 py-1 {duration === 'conversation'
              ? 'border-amber-500 bg-amber-100 dark:bg-amber-900/50'
              : ''}"
            onclick={() => (duration = 'conversation')}
            data-testid="duration-conversation"
          >
            2 · {t('approvals.conversation')}
          </button>
          <span class="text-muted-foreground">{t('approvals.durationHint')}</span>
        </div>
      {/if}
    {:else if approval.kind === 'mcp_tool' && mcpTool !== null}
      <!-- W5：MCP 工具卡——服务器 / 工具 / 参数摘要 + 风险档（破坏性用警示色）。 -->
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span class="text-muted-foreground">{t('approvals.mcpTool')}</span>
        <span class="break-all" data-testid="approval-mcp-tool"
          >{mcpTool.serverName} · <code>{mcpTool.toolName}</code></span
        >
        {#each mcpTool.recipients ?? [] as recipient, index (index)}
          <!-- W4 精确卡片：收件方完整列出，不随参数摘要截断。 -->
          <span class="text-muted-foreground"
            >{t('approvals.mcpRecipient')} <code class="text-[11px]">{recipient.key}</code></span
          >
          <code
            class="font-semibold break-all whitespace-pre-wrap"
            data-testid="approval-mcp-recipient">{recipient.value}</code
          >
        {/each}
        {#if mcpTool.argsSummary.length > 0}
          <span class="text-muted-foreground">{t('approvals.mcpArgs')}</span>
          <code class="break-all whitespace-pre-wrap" data-testid="approval-mcp-args"
            >{mcpTool.argsSummary}</code
          >
        {/if}
      </div>
      {#if mcpTool.risk === 'destructive'}
        <p
          class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="approval-risk-note"
        >
          {t('approvals.mcpDestructiveRisk')}
        </p>
      {/if}
    {:else if approval.kind === 'git_remote'}
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span class="text-muted-foreground">{t('approvals.gitRemoteOperation')}</span>
        <code data-testid="approval-git-operation">git {gitRemoteOp}</code>
        {#if gitRemoteArgs.length > 0}
          <span class="text-muted-foreground">{t('approvals.gitRemoteArgs')}</span>
          <code class="break-all" data-testid="approval-git-args">{gitRemoteArgs}</code>
        {/if}
        {#if cwd.length > 0}
          <span class="text-muted-foreground">{t('approvals.cwd')}</span>
          <code class="break-all">{cwd}</code>
        {/if}
        {#if reason.length > 0}
          <span class="text-muted-foreground">{t('approvals.reason')}</span>
          <span class="break-all">{reason}</span>
        {/if}
      </div>
      <p
        class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
        data-testid="approval-risk-note"
      >
        {t('approvals.gitRemoteRisk')}
      </p>
    {:else}
      <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <span class="text-muted-foreground">{t('approvals.command')}</span>
        <code class="break-all whitespace-pre-wrap" data-testid="approval-command">{command}</code>
        {#if cwd.length > 0}
          <span class="text-muted-foreground">{t('approvals.cwd')}</span>
          <code class="break-all">{cwd}</code>
        {/if}
        {#if reason.length > 0}
          <span class="text-muted-foreground">{t('approvals.reason')}</span>
          <span class="break-all">{reason}</span>
        {/if}
      </div>
      {#if approval.kind === 'unsandboxed'}
        <p
          class="mt-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
          data-testid="approval-risk-note"
        >
          {t('approvals.unsandboxedRisk')}
        </p>
      {/if}
    {/if}

    <div class="mt-3 flex items-center gap-2">
      <Button
        size="sm"
        onclick={approve}
        disabled={approval.kind === 'butler_proposal' &&
          butlerProposal !== null &&
          butlerProposal.proposalType !== 'group' &&
          butlerKept.length === 0}
        data-testid="approval-approve"
        >{approval.kind === 'butler_proposal'
          ? t('approvals.butlerConfirm')
          : t('approvals.approve')}</Button
      >
      <Button size="sm" variant="outline" onclick={deny} data-testid="approval-deny"
        >{t('approvals.deny')}</Button
      >
    </div>
  </div>
{/if}
