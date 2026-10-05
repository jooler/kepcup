<script lang="ts">
  import type { Approval } from '@kepcup/shared';
  import {
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
  } from '@lucide/svelte';
  import { t, type MessageKey } from '$lib/i18n';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { environmentStore } from '$lib/stores/environment.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';

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

  $effect(() => {
    if (autofocus && pending && cardEl) cardEl.focus();
  });

  function approve(): void {
    void permissions.decide(approval.id, true, access !== null ? duration : undefined);
  }

  function deny(): void {
    void permissions.decide(approval.id, false);
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!pending) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      approve();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      deny();
    } else if (access !== null && event.key === '1') {
      duration = 'once';
    } else if (access !== null && event.key === '2') {
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
      {:else if access !== null && approval.decision?.duration === 'conversation'}
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
                  : command}
      </code>
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
      {:else}
        <TerminalSquare class="size-4 text-amber-600" aria-hidden="true" />
      {/if}
      <span>{title}</span>
      <span class="ml-auto text-[11px] font-normal text-muted-foreground"
        >{t('approvals.focusHint')}</span
      >
    </div>

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
        {#if reason.length > 0}
          <span class="text-muted-foreground">{t('approvals.reason')}</span>
          <span class="break-all">{reason}</span>
        {/if}
      </div>
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
      <Button size="sm" onclick={approve} data-testid="approval-approve"
        >{t('approvals.approve')}</Button
      >
      <Button size="sm" variant="outline" onclick={deny} data-testid="approval-deny"
        >{t('approvals.deny')}</Button
      >
    </div>
  </div>
{/if}
