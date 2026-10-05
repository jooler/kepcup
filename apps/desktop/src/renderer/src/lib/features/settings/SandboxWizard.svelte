<script lang="ts">
  import type { SandboxStatusOutput, SandboxWslStatusOutput } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { permissions } from '$lib/stores/permissions.svelte';
  import { sandboxWizard } from '$lib/stores/sandbox-wizard.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * P12-B Windows 沙箱准备向导（任务 7）+ 非 Windows 平台的增强沙箱入口。
   * 状态完全由核心侧的 wsl 状态机驱动（sandbox.wslStatus 的结构化 phase 与
   * reason/fixHint）；向导打开期间轮询状态以展示导入/配置进度。跳过后核心侧
   * 持久化跳过标记，命令保持逐条确认模式（任务书验收标准 5）。
   */

  /** 微软 WSL 官方文档（失败/策略禁用时的帮助链接）。 */
  const WSL_HELP_URL = 'https://learn.microsoft.com/windows/wsl/install';
  const POLL_INTERVAL_MS = 800;

  const PHASE_KEYS = {
    idle: 'wizard.stateIdle',
    enabling: 'wizard.stateEnabling',
    awaiting_reboot: 'wizard.stateAwaitingReboot',
    importing: 'wizard.stateImporting',
    configuring: 'wizard.stateConfiguring',
    ready: 'wizard.stateReady',
    failed: 'wizard.stateFailed',
    policy_disabled: 'wizard.statePolicyDisabled',
  } as const;

  let status = $state<SandboxWslStatusOutput | null>(null);
  let busy = $state(false);
  let skipping = $state(false);
  /** 「重启后自动继续导入」只在每次打开向导时执行一次（guard against poll）。 */
  let autoContinued = $state(false);

  const open = $derived(sandboxWizard.open);
  const enhanced = $derived<SandboxStatusOutput['enhanced'] | null>(
    settingsStore.sandboxStatus?.enhanced ?? null,
  );

  const inFlight = $derived(
    status !== null &&
      (busy ||
        status.phase === 'enabling' ||
        status.phase === 'importing' ||
        status.phase === 'configuring'),
  );
  /** 显示「开始准备/导入」动作按钮的条件（导入中/就绪/策略禁用/WSL1 死局除外）。 */
  const showPrepare = $derived(
    status !== null &&
      status.applicable &&
      !inFlight &&
      status.phase !== 'ready' &&
      status.phase !== 'policy_disabled' &&
      !(status.install === 'ok' && status.distro === 'wsl1'),
  );
  const prepareLabel = $derived.by(() => {
    if (status === null) return '';
    if (status.phase === 'failed') return t('wizard.retry');
    if (status.install === 'ok') return t('wizard.importNow');
    return t('wizard.startPrepare');
  });

  $effect(() => {
    if (!open) return;
    autoContinued = false;
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  });

  async function refresh(): Promise<void> {
    try {
      const next = (await core.call('sandbox.wslStatus')) as SandboxWslStatusOutput;
      status = next;
      // 非 Windows 平台的增强沙箱入口消费 sandbox.status 的 enhanced 子状态。
      if (!next.applicable && settingsStore.sandboxStatus === null) {
        await settingsStore.refreshSandbox(false);
      }
      // 重启后自动继续（任务 2）：授权后的 awaiting_reboot 在检测到组件已
      // 启用时，无需再次点击，直接继续导入。
      if (
        !autoContinued &&
        next.applicable &&
        next.phase === 'awaiting_reboot' &&
        next.install === 'ok' &&
        next.distro !== 'registered'
      ) {
        autoContinued = true;
        await prepare();
      }
    } catch {
      // 连接问题：保持当前展示，轮询会重试。
    }
  }

  async function prepare(): Promise<void> {
    busy = true;
    try {
      status = (await core.call('sandbox.wslPrepare')) as SandboxWslStatusOutput;
      // 默认后端状态随准备结果变化（可用 ↔ 逐条确认横幅）。
      await Promise.all([settingsStore.refreshSandbox(true), permissions.refreshSandbox(true)]);
    } catch {
      // 失败详情经下一次轮询的 status 呈现（failed phase + reason）。
    } finally {
      busy = false;
    }
  }

  async function skip(): Promise<void> {
    skipping = true;
    try {
      await core.call('sandbox.wslSkip');
      sandboxWizard.close();
    } finally {
      skipping = false;
    }
  }

  function enhancedName(backend: 'lima' | 'podman' | 'wsl'): string {
    if (backend === 'lima') return 'Lima';
    if (backend === 'podman') return 'Podman';
    return 'WSL2';
  }
</script>

<Dialog
  {open}
  onOpenChange={(value) => (value ? sandboxWizard.show() : sandboxWizard.close())}
>
  <DialogContent class="max-w-lg" data-testid="sandbox-wizard">
    <DialogHeader>
      <DialogTitle>{t('wizard.title')}</DialogTitle>
      <DialogDescription>{t('wizard.description')}</DialogDescription>
    </DialogHeader>

    {#if status === null}
      <p class="text-sm text-muted-foreground" data-testid="wizard-loading">
        {t('wizard.loading')}
      </p>
    {:else if status.applicable}
      <div class="space-y-3" data-testid="wizard-wsl" data-phase={status.phase}>
        <div class="flex items-center gap-2">
          <Badge
            variant={status.phase === 'ready' ? 'default' : status.phase === 'failed' || status.phase === 'policy_disabled' ? 'destructive' : 'secondary'}
            data-testid="wizard-state-badge"
          >
            {t(PHASE_KEYS[status.phase])}
          </Badge>
        </div>
        {#if status.reason !== undefined}
          <p class="text-sm" data-testid="wizard-reason">{status.reason}</p>
        {/if}
        {#if status.fixHint !== undefined}
          <p class="text-xs text-muted-foreground" data-testid="wizard-fix-hint">{status.fixHint}</p>
        {/if}
        {#if status.phase === 'awaiting_reboot' && status.install !== 'ok'}
          <p class="text-xs text-amber-700 dark:text-amber-400" data-testid="wizard-reboot-hint">
            {t('wizard.rebootHint')}
          </p>
        {/if}
        {#if status.phase === 'ready'}
          <p class="text-sm text-emerald-700 dark:text-emerald-400" data-testid="wizard-done">
            {t('wizard.done')}
          </p>
        {:else}
          <p class="text-xs text-muted-foreground" data-testid="wizard-confirm-note">
            {t('wizard.confirmNote')}
          </p>
        {/if}

        <div class="flex flex-wrap items-center gap-2">
          {#if showPrepare}
            <Button size="sm" disabled={busy || skipping} onclick={() => void prepare()} data-testid="wizard-prepare">
              {prepareLabel}
            </Button>
          {/if}
          {#if inFlight}
            <span class="text-xs text-muted-foreground" data-testid="wizard-progress">…</span>
          {/if}
          {#if status.install !== 'ok' && !inFlight && status.phase !== 'policy_disabled'}
            <p class="w-full text-xs text-muted-foreground" data-testid="wizard-admin-hint">
              {t('wizard.adminHint')}
            </p>
          {/if}
          {#if status.phase !== 'ready'}
            <Button
              size="sm"
              variant="ghost"
              class="ml-auto"
              disabled={skipping}
              onclick={() => void skip()}
              data-testid="wizard-skip"
            >
              {t('wizard.skip')}
            </Button>
          {/if}
        </div>

        {#if status.phase === 'failed' || status.phase === 'policy_disabled'}
          <a
            class="text-xs text-muted-foreground underline underline-offset-2"
            href={WSL_HELP_URL}
            target="_blank"
            rel="noreferrer"
            data-testid="wizard-help-link"
          >
            {t('wizard.helpLink')}
          </a>
        {/if}

        <p class="text-xs text-muted-foreground" data-testid="wizard-shared-vm-note">
          {t('wizard.sharedVmNote')}
        </p>
      </div>
    {:else}
      <!-- 非 Windows 平台：不显示 Windows 内容，展示对应平台的增强沙箱入口 -->
      <div class="space-y-3" data-testid="wizard-enhanced">
        <p class="text-sm text-muted-foreground">{t('wizard.enhancedIntro')}</p>
        {#if enhanced !== null && enhanced !== undefined}
          <div class="flex items-center gap-2" data-testid="wizard-enhanced-state">
            <Badge variant={enhanced.available ? 'default' : 'destructive'} data-testid="wizard-enhanced-badge">
              {enhanced.available ? t('settings.sandboxEnhancedAvailable') : t('settings.sandboxEnhancedMissing')}
            </Badge>
            <span class="text-sm">{enhancedName(enhanced.backend)}</span>
          </div>
          {#if !enhanced.available && enhanced.reason !== undefined}
            <p class="text-xs text-muted-foreground" data-testid="wizard-enhanced-reason">{enhanced.reason}</p>
          {/if}
          {#if !enhanced.available && enhanced.fixHint !== undefined}
            <p class="text-xs text-muted-foreground" data-testid="wizard-enhanced-hint">{enhanced.fixHint}</p>
          {/if}
        {/if}
      </div>
    {/if}
  </DialogContent>
</Dialog>
