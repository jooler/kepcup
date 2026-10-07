<script lang="ts">
  import type { AgentStatus, AgentTestResult, AgentView } from '@kepcup/shared';
  import { t, type MessageKey } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { agentIconUrl } from './agent-icons';

  /**
   * 一个外部智能体的目录卡片（D72，design 28 §2.2）：图标、名称、简介、许可、
   * tier、登录方式、条款提示；状态与操作（启用 = 安装确认卡 → 后台安装；
   * 登录 / API key / 退出；测试连接；停用 / 卸载，有 Bot 在用时列出受影响 Bot
   * 再确认）；高级（系统 CLI、个人配置、并发）。安装进度与登录输出经
   * `agent.status` 事件实时更新。
   *
   * 设置页「智能体」、对话内 Agent 设置卡（D58）与 onboarding 订阅分支共用
   * 同一份卡片与保存 RPC；`embedded` 时只保留「启用 / 安装确认 / 登录 /
   * API key / 测试连接」（停用、卸载与高级项只在设置页）。
   */
  let {
    agent,
    embedded = false,
    onTested,
  }: {
    agent: AgentView;
    embedded?: boolean;
    /** 测试连接完成（对话内设置卡据此续跑）。 */
    onTested?: (result: AgentTestResult) => void;
  } = $props();

  let busy = $state(false);
  let testResult = $state<AgentTestResult | null>(null);
  let installSource = $state<'managed' | 'system'>('managed');
  let installOpen = $state(false);
  let confirmAction = $state<'disable' | 'uninstall' | null>(null);
  let confirmOpen = $state(false);
  let loginOpen = $state(false);
  let loginLoading = $state(false);
  let apiKeyDraft = $state('');
  let loginInputDraft = $state('');

  const icon = $derived(agentIconUrl(agent.icon));

  const STATUS_VARIANT: Record<AgentStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    available: 'outline',
    installing: 'secondary',
    needs_auth: 'secondary',
    ready: 'default',
    update_available: 'secondary',
    incompatible: 'destructive',
    error: 'destructive',
  };

  function sizeText(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
    if (bytes >= 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
    return `${Math.max(1, Math.round(bytes / 1024))}KB`;
  }

  function termsText(): string {
    const key = agent.termsNoticeKey ?? `agents.terms.${agent.id}`;
    const text = t(key as MessageKey);
    return text === key ? t('agents.termsGeneric') : text;
  }

  function errorOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function run(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    try {
      await action();
    } catch (error) {
      toast.error(t('agents.actionFailed', { error: errorOf(error) }));
    } finally {
      busy = false;
    }
  }

  function openInstall(source: 'managed' | 'system' = agent.source): void {
    installSource = source;
    installOpen = true;
  }

  async function confirmInstall(): Promise<void> {
    installOpen = false;
    const source = installSource;
    await run(() => agentsStore.enable(agent.id, source));
  }

  const isDefaultAgent = $derived(settingsStore.settings?.defaultAgentId === agent.id);

  function askDisable(action: 'disable' | 'uninstall'): void {
    if (action === 'disable' && agent.usedBy.length === 0 && !isDefaultAgent) {
      void run(() => agentsStore.disable(agent.id));
      return;
    }
    confirmAction = action;
    confirmOpen = true;
  }

  async function applyConfirmed(): Promise<void> {
    const action = confirmAction;
    if (action === null) return;
    confirmOpen = false;
    await run(() =>
      action === 'disable'
        ? agentsStore.disable(agent.id, true)
        : agentsStore.uninstall(agent.id, true),
    );
  }

  async function test(): Promise<void> {
    await run(async () => {
      const result = await agentsStore.test(agent.id);
      testResult = result;
      onTested?.(result);
    });
  }

  async function openLogin(): Promise<void> {
    loginOpen = !loginOpen;
    apiKeyDraft = '';
    loginInputDraft = '';
    if (!loginOpen || agent.authMethods.length > 0) return;
    if (!agent.authKinds.some((kind) => kind !== 'api-key' && kind !== 'anonymous')) return;
    loginLoading = true;
    try {
      await agentsStore.login(agent.id);
    } catch (error) {
      toast.error(t('agents.actionFailed', { error: errorOf(error) }));
    } finally {
      loginLoading = false;
    }
  }

  async function saveApiKey(): Promise<void> {
    const key = apiKeyDraft.trim();
    if (key.length === 0) return;
    await run(async () => {
      await agentsStore.login(agent.id, { apiKey: key });
      apiKeyDraft = '';
      toast.success(t('agents.apiKeySaved'));
    });
  }

  async function sendLoginInput(): Promise<void> {
    const line = loginInputDraft;
    loginInputDraft = '';
    await run(() => agentsStore.login(agent.id, { input: line }));
  }

  function toggleSystemCli(checked: boolean): void {
    if (checked) void run(() => agentsStore.enable(agent.id, 'system'));
    else openInstall('managed');
  }

  function canLogin(): boolean {
    return agent.apiKeyEnv !== null || agent.authKinds.some((kind) => kind !== 'anonymous');
  }
</script>

<div
  class="space-y-2 rounded-xl border px-4 py-3.5"
  data-testid={`agent-card-${agent.id}`}
  data-settings-anchor={`agent-${agent.id}`}
>
  <div class="flex items-start gap-3">
    {#if icon !== null}
      <img src={icon} alt="" class="size-9 shrink-0 rounded-lg" />
    {:else}
      <div
        class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium"
      >
        {agent.name.slice(0, 1)}
      </div>
    {/if}
    <div class="min-w-0 flex-1 space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium">{agent.name}</span>
        <Badge variant="outline">{t(`agents.tier.${agent.tier}` as MessageKey)}</Badge>
        <Badge variant={STATUS_VARIANT[agent.status]} data-testid={`agent-status-${agent.id}`}>
          {t(`agents.status.${agent.status}` as MessageKey)}
        </Badge>
        <span class="text-xs text-muted-foreground"
          >{t('agents.version', { version: agent.version })}</span
        >
        {#if agent.website !== null}
          <a
            class="text-xs text-muted-foreground underline"
            href={agent.website}
            target="_blank"
            rel="noreferrer">{t('agents.website')}</a
          >
        {/if}
      </div>
      <p class="text-xs text-muted-foreground">{agent.description}</p>
      <p class="text-xs text-muted-foreground">
        {t('agents.license', { license: agent.license })} · {t('agents.authNote', {
          note: agent.authNote,
        })}
      </p>
      <p class="text-xs text-amber-600 dark:text-amber-400">{termsText()}</p>
      {#if agent.authKinds.includes('anonymous')}
        <p class="text-xs text-muted-foreground">{t('agents.anonymousHint')}</p>
      {/if}
      {#if agent.statusDetail !== null}
        <p class="text-xs text-destructive">{agent.statusDetail}</p>
      {/if}
      {#if agent.progress !== null}
        <p class="text-xs text-muted-foreground" data-testid={`agent-progress-${agent.id}`}>
          {t(`agents.stage.${agent.progress.stage}` as MessageKey)}
          {#if agent.progress.receivedBytes !== undefined}
            · {sizeText(agent.progress.receivedBytes)}{agent.progress.totalBytes
              ? ` / ${sizeText(agent.progress.totalBytes)}`
              : ''}
          {/if}
        </p>
      {/if}
      {#if agent.usedBy.length > 0}
        <p class="text-xs text-muted-foreground">
          {t('agents.usedBy', { bots: agent.usedBy.map((bot) => bot.name).join('、') })}
        </p>
      {/if}
    </div>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    {#if !agent.enabled && agent.status !== 'installing' && agent.status !== 'incompatible'}
      <Button
        size="sm"
        disabled={busy}
        onclick={() => openInstall()}
        data-testid={`agent-enable-${agent.id}`}
      >
        {agent.status === 'error' ? t('agents.retry') : t('agents.enable')}
      </Button>
    {/if}
    {#if agent.enabled && (agent.status === 'update_available' || agent.status === 'error')}
      <Button size="sm" disabled={busy} onclick={() => openInstall()}>
        {agent.status === 'error' ? t('agents.retry') : t('agents.update')}
      </Button>
    {/if}
    {#if agent.enabled && agent.status !== 'installing'}
      {#if canLogin()}
        <Button
          size="sm"
          variant={agent.status === 'needs_auth' ? 'default' : 'secondary'}
          onclick={() => void openLogin()}
          data-testid={`agent-login-${agent.id}`}
        >
          {t('agents.login')}
        </Button>
      {/if}
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        onclick={() => void test()}
        data-testid={`agent-test-${agent.id}`}
      >
        {busy ? t('agents.testing') : t('agents.test')}
      </Button>
      {#if !embedded}
        <Button size="sm" variant="ghost" onclick={() => askDisable('disable')}>
          {t('agents.disable')}
        </Button>
      {/if}
    {/if}
    {#if !embedded && (agent.installedVersion !== null || agent.enabled)}
      <Button
        size="sm"
        variant="ghost"
        class="text-destructive hover:text-destructive"
        disabled={agent.status === 'installing'}
        onclick={() => askDisable('uninstall')}
      >
        {t('agents.uninstall')}
      </Button>
    {/if}
  </div>

  {#if testResult !== null}
    {#if testResult.ok}
      <p
        class="text-xs text-emerald-600 dark:text-emerald-400"
        data-testid={`agent-test-ok-${agent.id}`}
      >
        {t('agents.testOk', { ms: testResult.elapsedMs, reply: testResult.reply })}
      </p>
    {:else}
      <p class="text-xs text-destructive">
        {t('agents.testFailed', { error: testResult.error ?? '' })}
      </p>
    {/if}
  {/if}

  {#if loginOpen}
    <div class="space-y-2 rounded-lg bg-muted/40 p-3" data-testid={`agent-login-panel-${agent.id}`}>
      <p class="text-xs text-muted-foreground">{t('agents.loginHint')}</p>
      {#if loginLoading}
        <p class="text-xs text-muted-foreground">{t('agents.loginLoading')}</p>
      {:else if agent.authMethods.length > 0}
        <div class="flex flex-wrap gap-2">
          {#each agent.authMethods as method (method.id)}
            <Button
              size="sm"
              variant="outline"
              disabled={agent.login?.running === true}
              onclick={() => void run(() => agentsStore.login(agent.id, { methodId: method.id }))}
              title={method.description}
            >
              {method.name}
              <span class="text-xs text-muted-foreground"
                >（{method.type === 'terminal'
                  ? t('agents.methodTerminal')
                  : t('agents.methodAgent')}）</span
              >
            </Button>
          {/each}
        </div>
      {:else if agent.apiKeyEnv === null}
        <p class="text-xs text-muted-foreground">{t('agents.loginNoMethods')}</p>
      {/if}
      {#if agent.apiKeyEnv !== null}
        <div class="flex items-center gap-2">
          <Input
            class="h-8 flex-1"
            type="password"
            placeholder={agent.hasApiKey
              ? t('agents.apiKeySet')
              : t('agents.apiKeyLabel', { env: agent.apiKeyEnv })}
            bind:value={apiKeyDraft}
          />
          <Button
            size="sm"
            disabled={apiKeyDraft.trim().length === 0}
            onclick={() => void saveApiKey()}
          >
            {t('agents.apiKeySave')}
          </Button>
        </div>
      {/if}
      {#if agent.login !== null}
        <p class="text-xs">
          {#if agent.login.running}
            {t('agents.loginRunning')}
          {:else if agent.login.error === null && agent.login.exitCode === 0}
            <span class="text-emerald-600 dark:text-emerald-400">{t('agents.loginDone')}</span>
          {:else if agent.login.error !== null}
            <span class="text-destructive"
              >{t('agents.loginFailed', { error: agent.login.error })}</span
            >
          {/if}
        </p>
        {#if agent.login.output.length > 0}
          <pre
            class="max-h-48 overflow-auto rounded bg-background p-2 text-xs whitespace-pre-wrap"
            aria-label={t('agents.loginOutput')}>{agent.login.output}</pre>
        {/if}
        {#if agent.login.running}
          <div class="flex items-center gap-2">
            <Input
              class="h-8 flex-1"
              placeholder={t('agents.loginInputPlaceholder')}
              bind:value={loginInputDraft}
              onkeydown={(event) => {
                if (event.key === 'Enter') void sendLoginInput();
              }}
            />
            <Button size="sm" variant="secondary" onclick={() => void sendLoginInput()}>
              {t('agents.loginSend')}
            </Button>
          </div>
        {/if}
      {/if}
      {#if agent.authKinds.length > 0}
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => void run(() => agentsStore.logout(agent.id))}
        >
          {t('agents.logout')}
        </Button>
      {/if}
    </div>
  {/if}

  {#if !embedded}
    <details class="text-xs">
      <summary class="cursor-pointer text-muted-foreground">{t('agents.advanced')}</summary>
      <div class="mt-2 space-y-2">
        {#if agent.systemCli !== null}
          <label class="flex items-center gap-1.5">
            <Checkbox
              checked={agent.source === 'system'}
              disabled={busy || agent.status === 'installing'}
              onCheckedChange={(checked) => toggleSystemCli(checked === true)}
            />
            {t('agents.useSystemCli')}
          </label>
          <p class="pl-6 text-muted-foreground">
            {#if !agent.systemCli.found}
              {t('agents.systemCliMissing')}
            {:else if !agent.systemCli.compatible}
              {t('agents.systemCliIncompatible', {
                version: agent.systemCli.version ?? '?',
                range: agent.systemCli.versionRange ?? '',
              })}
            {:else}
              {t('agents.systemCliFound', {
                path: agent.systemCli.path ?? '',
                version: agent.systemCli.version ?? '?',
              })}
            {/if}
          </p>
        {/if}
        <label class="flex items-center gap-1.5">
          <Checkbox
            checked={agent.loadUserConfig}
            onCheckedChange={(checked) =>
              void run(() => agentsStore.configure(agent.id, { loadUserConfig: checked === true }))}
          />
          {t('agents.loadUserConfig')}
        </label>
        <p class="pl-6 text-muted-foreground">{t('agents.loadUserConfigHint')}</p>
        <p
          class="pl-6 font-medium text-amber-700 dark:text-amber-400"
          data-testid={`agent-load-user-config-warning-${agent.id}`}
        >
          {t('agents.loadUserConfigWarning')}
        </p>
        <label class="flex items-center gap-2">
          {t('agents.concurrency')}
          <Input
            class="h-7 w-16"
            type="number"
            min="1"
            max="16"
            value={agent.concurrency}
            onchange={(event) => {
              const value = Math.min(16, Math.max(1, Number(event.currentTarget.value) || 1));
              void run(() => agentsStore.configure(agent.id, { concurrency: value }));
            }}
          />
        </label>
      </div>
    </details>
  {/if}
</div>

<Dialog bind:open={installOpen}>
  <DialogContent data-testid="agent-install-dialog">
    {#if installOpen}
      {@const plan = agent.install}
      <DialogHeader>
        <DialogTitle>{t('agents.installTitle', { name: agent.name })}</DialogTitle>
        <DialogDescription>{t('agents.installBody')}</DialogDescription>
      </DialogHeader>
      <ul class="space-y-1 text-sm">
        {#if installSource === 'system' || plan.kind === 'system'}
          <li>
            {t('agents.installSystem', {
              path: agent.systemCli?.path ?? plan.source,
            })}
          </li>
        {:else}
          <li>
            {plan.sizeBytes > 0
              ? t('agents.installSize', { size: sizeText(plan.sizeBytes) })
              : t('agents.installSizeUnknown')}
          </li>
          <li class="break-all">{t('agents.installSource', { source: plan.source })}</li>
          {#if plan.prerequisites.includes('node')}
            <li>{t('agents.installPrereqNode')}</li>
          {/if}
        {/if}
        <li>{t('agents.installLicense', { license: plan.license })}</li>
        <li class="text-amber-600 dark:text-amber-400">{termsText()}</li>
      </ul>
      <DialogFooter>
        <Button variant="outline" onclick={() => (installOpen = false)}>{t('agents.cancel')}</Button
        >
        <Button onclick={() => void confirmInstall()} data-testid="agent-install-confirm">
          {t('agents.installConfirm')}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>

<Dialog bind:open={confirmOpen}>
  <DialogContent data-testid="agent-confirm-dialog">
    {#if confirmAction !== null}
      <DialogHeader>
        <DialogTitle>
          {agent.usedBy.length > 0
            ? t('agents.affectedTitle', { name: agent.name })
            : confirmAction === 'disable'
              ? t('agents.disableTitle', { name: agent.name })
              : t('agents.uninstallTitle', { name: agent.name })}
        </DialogTitle>
        <DialogDescription>
          {#if agent.usedBy.length > 0}
            {t('agents.affectedBody', {
              bots: agent.usedBy.map((bot) => bot.name).join('、'),
            })}
          {/if}
          {#if confirmAction === 'uninstall'}
            {t('agents.uninstallBody')}
          {/if}
          {#if isDefaultAgent}
            <span class="mt-1 block" data-testid="agent-confirm-default-note"
              >{t('agents.defaultAgentAffected')}</span
            >
          {/if}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onclick={() => (confirmOpen = false)}>{t('agents.cancel')}</Button
        >
        <Button
          variant="destructive"
          onclick={() => void applyConfirmed()}
          data-testid="agent-confirm"
        >
          {confirmAction === 'disable' ? t('agents.confirmDisable') : t('agents.confirmUninstall')}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
