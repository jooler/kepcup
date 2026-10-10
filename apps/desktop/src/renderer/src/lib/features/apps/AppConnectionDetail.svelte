<script lang="ts">
  import type { AppToolView } from '@kepcup/shared';
  import { ArrowLeft, Eye, EyeOff } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { appDetailStore } from '$lib/stores/app-detail.svelte';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { Badge } from '$lib/components/ui/badge';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import McpRiskBadge from '$lib/features/approvals/McpRiskBadge.svelte';
  import ConnectAppPanel from './ConnectAppPanel.svelte';
  import ConnectedSkillsPrompt from './ConnectedSkillsPrompt.svelte';
  import {
    BADGE_TONE_CLASSES,
    appIconSrc,
    appInitial,
    disconnectImpact,
    isConnectionGone,
    statusBadge,
    toolsLoadableStatus,
  } from './app-catalog';
  import {
    TOOL_POLICY_CHOICES,
    TOOL_STATE_LABEL_KEYS,
    diffStats,
    policyForChoice,
    splitTools,
    toolDefinitionDiff,
    toolPolicyChoice,
    type ToolPolicyChoice,
  } from './app-tools';

  /**
   * 一个目录连接的详情（D73 §5.9）：账号名（可改）、停用开关、已授予权限、工具表
   * （风险档 / 锁定状态 / 逐工具策略 / 是否暴露给 Bot）、待复核工具的新旧定义对比与
   * 接受、持续授权（Bot 级 / 对话级）的撤销、重新连接（ConnectAppPanel）与断开
   * （确认框列出受影响 Bot）。数据来自 appsStore（连接行）与 appDetailStore（工具 /
   * 授权缓存）。
   */
  let {
    connectionId,
    onBack,
  }: {
    connectionId: string;
    onBack: () => void;
  } = $props();

  const connection = $derived(
    appsStore.connections.find((item) => item.id === connectionId) ?? null,
  );
  const entry = $derived(connection === null ? null : appsStore.entryFor(connection.connectorId));
  const title = $derived(entry?.title ?? connection?.connectorId ?? connectionId);
  const icon = $derived(appIconSrc(entry?.iconDataUri));
  const toolsView = $derived(appDetailStore.toolsFor(connectionId));
  const split = $derived(splitTools(toolsView?.tools ?? []));
  const grants = $derived(appDetailStore.grantsFor(connectionId));
  const impact = $derived(disconnectImpact(contacts.bots, connectionId));

  $effect(() => {
    appsStore.start();
    appDetailStore.start();
  });

  // 连接行存在才去拉（行已被删——比如首次连接取消后残留的旧引用——拉了只会 NOT_FOUND）；
  // 授权没了 / 过期 / 缺权限的连接不去连 server 取工具清单，只拉本地的授权记录，界面改显示
  // 状态与「重新连接」。派生值相等时不会重跑 effect（connected ⇄ tools_changed 不重拉）。
  const exists = $derived(connection !== null);
  const toolsLoadable = $derived(connection !== null && toolsLoadableStatus(connection.status));

  $effect(() => {
    const id = connectionId;
    if (!exists) return;
    const withTools = toolsLoadable;
    // load 只能被 connectionId / 可拉取性驱动：store 的簿记状态不能成为这个 effect 的依赖。
    untrack(() => {
      void appDetailStore.load(id, { withTools }).catch((error: unknown) => {
        // 连接已不存在：静默（视图会显示「不存在」），绝不重试；其它失败同一连接只留一条 toast。
        if (isConnectionGone(error)) return;
        toast.error(rpcError(error), { id: `app-detail-load-${id}` });
      });
    });
  });

  function rpcError(error: unknown): string {
    const code = (error as { code?: string } | undefined)?.code;
    const fallback = error instanceof Error ? error.message : String(error);
    return errorText(code, fallback);
  }

  // --- 账号名 / 停用 -----------------------------------------------------------
  // 可写派生：输入覆盖草稿，只在已保存的 label **值**变化（保存 / 改名）时复位——不能直接
  // 派生于 connection 对象：每次刷新 / 状态推送都会换对象身份，会把正在输入的内容抹掉。
  const savedLabel = $derived(connection?.label ?? '');
  let labelDraft = $derived(savedLabel);
  let busy = $state(false);
  const labelDirty = $derived(
    connection !== null && labelDraft.trim().length > 0 && labelDraft.trim() !== connection.label,
  );

  async function saveLabel(): Promise<void> {
    if (!labelDirty || busy) return;
    busy = true;
    try {
      await appDetailStore.updateConnection(connectionId, { label: labelDraft.trim() });
      toast.success(t('apps.detail.labelSaved'));
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busy = false;
    }
  }

  async function setDisabled(disabled: boolean): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await appDetailStore.updateConnection(connectionId, { disabled });
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busy = false;
    }
  }

  // --- 工具策略 ----------------------------------------------------------------
  let savingPolicy = $state<string | null>(null);

  /**
   * 「默认」档的有效审批：未设逐工具策略时 `tool.approval` 就是 core 按风险档与应用分级算出的
   * 默认（本机连接 / `developer` 分级全部「每次确认」，破坏性恒每次确认），不在这里重算。
   */
  function defaultPolicyLabel(tool: AppToolView): string {
    return t('apps.detail.policy.default', {
      mode: tool.approval === 'auto' ? t('apps.detail.policy.auto') : t('apps.detail.policy.ask'),
    });
  }

  function policyLabel(choice: ToolPolicyChoice, tool: AppToolView): string {
    switch (choice) {
      case 'default':
        return defaultPolicyLabel(tool);
      case 'auto':
        return t('apps.detail.policy.auto');
      case 'ask':
        return t('apps.detail.policy.ask');
      default:
        return t('apps.detail.policy.disabled');
    }
  }

  async function changePolicy(tool: AppToolView, choice: ToolPolicyChoice): Promise<void> {
    savingPolicy = tool.toolName;
    try {
      await appDetailStore.setToolPolicy(connectionId, tool.toolName, policyForChoice(choice));
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      savingPolicy = null;
    }
  }

  // --- 复核 --------------------------------------------------------------------
  let selected = $state<Record<string, boolean>>({});
  let reviewing = $state(false);
  const selectedNames = $derived(
    split.pending.map((tool) => tool.toolName).filter((name) => selected[name] === true),
  );

  async function review(accept: string[]): Promise<void> {
    if (accept.length === 0 || reviewing) return;
    reviewing = true;
    try {
      const approved = await appDetailStore.reviewTools(connectionId, accept);
      selected = {};
      toast.success(t('apps.detail.reviewed', { count: approved.length }));
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      reviewing = false;
    }
  }

  // --- 持续授权 ----------------------------------------------------------------
  let revoking = $state<string | null>(null);

  function grantBotName(grant: { botId: string; botName: string | null }): string {
    return (
      grant.botName ??
      contacts.bots.find((bot) => bot.id === grant.botId)?.name ??
      t('apps.detail.grantUnknownBot')
    );
  }

  async function revoke(grantId: string): Promise<void> {
    revoking = grantId;
    try {
      await appDetailStore.revokeGrant(connectionId, grantId);
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      revoking = null;
    }
  }

  // --- 重新连接 / 断开 ---------------------------------------------------------
  let reconnectOpen = $state(false);
  let confirmOpen = $state(false);
  let disconnecting = $state(false);

  async function disconnect(): Promise<void> {
    if (disconnecting) return;
    disconnecting = true;
    try {
      await appsStore.disconnect(connectionId);
      appDetailStore.forget(connectionId);
      confirmOpen = false;
      onBack();
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      disconnecting = false;
    }
  }
</script>

<div class="space-y-4" data-testid="apps-detail" data-connection-id={connectionId}>
  <Button size="sm" variant="ghost" class="-ml-2" onclick={onBack} data-testid="apps-detail-back">
    <ArrowLeft class="size-4" aria-hidden="true" />
    {t('apps.detail.back')}
  </Button>

  {#if connection === null}
    <p class="text-sm text-muted-foreground" data-testid="apps-detail-missing">
      {t('apps.detail.notFound')}
    </p>
  {:else}
    {@const badge = statusBadge(connection.status)}
    <!-- 头部：应用 / 账号 / 状态 -->
    <div
      class="flex items-start gap-3 rounded-xl border px-4 py-3.5"
      data-testid="apps-detail-header"
    >
      {#if icon !== null}
        <img src={icon} alt="" class="size-10 shrink-0 rounded-lg" />
      {:else}
        <div
          class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-base font-medium text-muted-foreground"
          aria-hidden="true"
        >
          {appInitial(title)}
        </div>
      {/if}
      <div class="min-w-0 flex-1 space-y-2">
        <div class="flex flex-wrap items-center gap-1.5">
          <span class="text-sm font-medium" data-testid="apps-detail-title">{title}</span>
          <Badge
            variant={badge.tone === 'ok' ? 'default' : 'outline'}
            class={`text-[10px] ${BADGE_TONE_CLASSES[badge.tone]}`}
            data-testid="apps-detail-status"
            data-status={connection.status}
          >
            {t(badge.labelKey)}
          </Badge>
          {#if entry?.origin === 'local'}
            <!-- 本机自建（设计 29 §17）：未审核，所有工具默认每次确认 -->
            <Badge
              variant="outline"
              class="border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-400"
              title={t('apps.local.badgeHint')}
              data-testid="apps-detail-local-badge"
            >
              {t('apps.local.badge')}
            </Badge>
          {/if}
        </div>
        <div class="grid gap-1.5">
          <Label for="apps-detail-label" class="text-xs">{t('apps.detail.label')}</Label>
          <div class="flex items-center gap-2">
            <Input
              id="apps-detail-label"
              class="h-8 max-w-xs"
              bind:value={labelDraft}
              placeholder={t('apps.connected.defaultLabel')}
              onkeydown={(event) => {
                if (event.key === 'Enter') void saveLabel();
              }}
              data-testid="apps-detail-label"
            />
            {#if labelDirty}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onclick={() => void saveLabel()}
                data-testid="apps-detail-label-save"
              >
                {t('apps.detail.labelSave')}
              </Button>
            {/if}
          </div>
        </div>
        <label class="flex items-start gap-2 text-xs" data-testid="apps-detail-disable">
          <Checkbox
            checked={connection.status === 'disabled'}
            disabled={busy}
            onCheckedChange={(checked) => void setDisabled(checked === true)}
            data-testid="apps-detail-disable-checkbox"
          />
          <span>
            {t('apps.detail.disable')}
            <span class="block text-muted-foreground">{t('apps.detail.disableHint')}</span>
          </span>
        </label>
      </div>
    </div>

    <ConnectedSkillsPrompt {connectionId} testid="apps-detail-skills" />

    <!-- 权限 -->
    <section class="space-y-1.5" data-testid="apps-detail-scopes">
      <h4 class="text-xs font-medium">{t('apps.detail.scopes')}</h4>
      {#if connection.scopes.length === 0}
        <p class="text-xs text-muted-foreground">{t('apps.detail.scopesEmpty')}</p>
      {:else}
        <div class="flex flex-wrap gap-1">
          {#each connection.scopes as scope (scope)}
            <code class="rounded bg-muted px-1.5 py-0.5 text-[11px]">{scope}</code>
          {/each}
        </div>
      {/if}
    </section>

    <!-- 待复核 -->
    {#if split.pending.length > 0}
      <section
        class="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-3"
        data-testid="apps-detail-pending"
      >
        <h4 class="text-xs font-medium">
          {t('apps.detail.pendingTitle', { count: split.pending.length })}
        </h4>
        <p class="text-xs text-muted-foreground">{t('apps.detail.pendingHint')}</p>
        <ul class="space-y-2">
          {#each split.pending as tool (tool.toolName)}
            {@const lines = toolDefinitionDiff(tool)}
            {@const stats = diffStats(lines)}
            <li
              class="space-y-1.5 rounded-lg border bg-background px-3 py-2"
              data-testid={`apps-detail-pending-${tool.toolName}`}
            >
              <div class="flex flex-wrap items-center gap-2 text-xs">
                <Checkbox
                  checked={selected[tool.toolName] === true}
                  disabled={reviewing}
                  onCheckedChange={(checked) =>
                    (selected = { ...selected, [tool.toolName]: checked === true })}
                  data-testid={`apps-detail-pending-select-${tool.toolName}`}
                />
                <code class="rounded bg-muted px-1.5 py-0.5" title={tool.description}>
                  {tool.toolName}
                </code>
                {#if tool.title !== undefined && tool.title !== tool.toolName}
                  <span class="text-muted-foreground">{tool.title}</span>
                {/if}
                <McpRiskBadge
                  risk={tool.risk}
                  testid={`apps-detail-pending-risk-${tool.toolName}`}
                />
                <Badge variant="outline" class={`text-[10px] ${BADGE_TONE_CLASSES.warn}`}>
                  {t(TOOL_STATE_LABEL_KEYS[tool.state])}
                </Badge>
              </div>
              <details class="text-xs">
                <summary class="cursor-pointer text-muted-foreground select-none">
                  {tool.approvedDefinition === null
                    ? t('apps.detail.diffNew')
                    : t('apps.detail.diffStats', { added: stats.added, removed: stats.removed })}
                </summary>
                <pre
                  class="mt-1.5 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed"
                  data-testid={`apps-detail-diff-${tool.toolName}`}>{#each lines as line, index (index)}<span
                      class={line.kind === 'add'
                        ? 'block bg-emerald-500/15 text-emerald-800 dark:text-emerald-300'
                        : line.kind === 'del'
                          ? 'block bg-destructive/10 text-destructive line-through decoration-destructive/40'
                          : 'block text-muted-foreground'}
                      data-kind={line.kind}
                      >{line.kind === 'add'
                        ? '+ '
                        : line.kind === 'del'
                          ? '- '
                          : '  '}{line.text}</span
                    >{/each}</pre>
              </details>
            </li>
          {/each}
        </ul>
        <div class="flex items-center gap-2">
          <Button
            size="sm"
            disabled={reviewing || selectedNames.length === 0}
            onclick={() => void review(selectedNames)}
            data-testid="apps-detail-accept-selected"
          >
            {t('apps.detail.acceptSelected', { count: selectedNames.length })}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={reviewing}
            onclick={() => void review(split.pending.map((tool) => tool.toolName))}
            data-testid="apps-detail-accept-all"
          >
            {t('apps.detail.acceptAll')}
          </Button>
        </div>
      </section>
    {/if}

    <!-- 工具表 -->
    <section class="space-y-1.5" data-testid="apps-detail-tools">
      <h4 class="text-xs font-medium">{t('apps.detail.tools')}</h4>
      <p class="text-xs text-muted-foreground">{t('apps.detail.toolsHint')}</p>
      {#if toolsView === null}
        <p class="text-xs text-muted-foreground">{t('apps.detail.toolsLoading')}</p>
      {:else if toolsView.tools.length === 0}
        <p class="text-xs text-muted-foreground" data-testid="apps-detail-tools-empty">
          {t('apps.detail.toolsEmpty')}
        </p>
      {:else}
        <div class="divide-y rounded-lg border">
          {#each split.approved as tool (tool.toolName)}
            {@const choice = toolPolicyChoice(tool)}
            <div
              class="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
              data-testid={`apps-detail-tool-${tool.toolName}`}
              data-exposed={tool.exposed}
            >
              <code class="rounded bg-muted px-1.5 py-0.5" title={tool.description}>
                {tool.toolName}
              </code>
              {#if tool.title !== undefined && tool.title !== tool.toolName}
                <span class="truncate text-muted-foreground">{tool.title}</span>
              {/if}
              <McpRiskBadge risk={tool.risk} testid={`apps-detail-tool-risk-${tool.toolName}`} />
              <span class="text-muted-foreground">{t(TOOL_STATE_LABEL_KEYS[tool.state])}</span>
              <div class="ml-auto flex items-center gap-3">
                <label class="flex items-center gap-1">
                  <span class="text-muted-foreground">{t('apps.detail.policy')}</span>
                  <select
                    class="h-7 rounded-md border border-input bg-background px-2 text-xs"
                    value={choice}
                    disabled={savingPolicy === tool.toolName}
                    onchange={(event) =>
                      void changePolicy(tool, event.currentTarget.value as ToolPolicyChoice)}
                    data-testid={`apps-detail-tool-policy-${tool.toolName}`}
                  >
                    {#each TOOL_POLICY_CHOICES as option (option)}
                      <option value={option}>{policyLabel(option, tool)}</option>
                    {/each}
                  </select>
                </label>
                <span
                  class="flex items-center gap-1 {tool.exposed
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-muted-foreground'}"
                  title={tool.exposed ? t('apps.detail.exposed') : t('apps.detail.hidden')}
                  data-testid={`apps-detail-tool-exposed-${tool.toolName}`}
                >
                  {#if tool.exposed}
                    <Eye class="size-3.5" aria-hidden="true" />
                  {:else}
                    <EyeOff class="size-3.5" aria-hidden="true" />
                  {/if}
                  <span class="sr-only">
                    {tool.exposed ? t('apps.detail.exposed') : t('apps.detail.hidden')}
                  </span>
                </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- 持续授权 -->
    <section class="space-y-1.5" data-testid="apps-detail-grants">
      <h4 class="text-xs font-medium">{t('apps.detail.grants')}</h4>
      <p class="text-xs text-muted-foreground">{t('apps.detail.grantsHint')}</p>
      {#if grants === null}
        <p class="text-xs text-muted-foreground">{t('apps.detail.toolsLoading')}</p>
      {:else if grants.length === 0}
        <p class="text-xs text-muted-foreground" data-testid="apps-detail-grants-empty">
          {t('apps.detail.grantsEmpty')}
        </p>
      {:else}
        <ul class="divide-y rounded-lg border">
          {#each grants as grant (grant.id)}
            <li
              class="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
              data-testid={`apps-detail-grant-${grant.id}`}
            >
              <span class="font-medium">{grantBotName(grant)}</span>
              <code class="rounded bg-muted px-1.5 py-0.5">{grant.toolName}</code>
              <Badge variant="outline" class="text-[10px]">
                {grant.conversationId === null
                  ? t('apps.detail.grantBotLevel')
                  : t('apps.detail.grantConversation')}
              </Badge>
              <Button
                size="sm"
                variant="ghost"
                class="ml-auto h-7 text-destructive hover:text-destructive"
                disabled={revoking === grant.id}
                onclick={() => void revoke(grant.id)}
                data-testid={`apps-detail-grant-revoke-${grant.id}`}
              >
                {t('apps.detail.revoke')}
              </Button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- 重新连接 / 断开 -->
    <section class="space-y-2 border-t pt-3" data-testid="apps-detail-actions">
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          onclick={() => (reconnectOpen = !reconnectOpen)}
          data-testid="apps-detail-reconnect"
        >
          {reconnectOpen ? t('apps.catalog.close') : t('apps.detail.reconnect')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          class="text-destructive hover:text-destructive"
          disabled={disconnecting}
          onclick={() => (confirmOpen = true)}
          data-testid="apps-detail-disconnect"
        >
          {t('apps.detail.disconnect')}
        </Button>
      </div>
      {#if reconnectOpen}
        <div class="space-y-2 rounded-lg border px-3 py-2.5">
          <p class="text-xs text-muted-foreground">{t('apps.detail.reconnectHint')}</p>
          <ConnectAppPanel
            target={{ kind: 'catalog', connectorId: connection.connectorId }}
            reconnectConnectionId={connection.id}
            scopes={connection.scopes.length > 0 ? connection.scopes : undefined}
            name={title}
            allowDisconnect={false}
            onDone={() => {
              reconnectOpen = false;
              void appDetailStore.load(connectionId).catch(() => undefined);
            }}
            testid="apps-detail-reconnect-panel"
          />
        </div>
      {/if}
    </section>
  {/if}
</div>

<Dialog bind:open={confirmOpen}>
  <DialogContent data-testid="apps-detail-disconnect-dialog">
    <DialogHeader>
      <DialogTitle>{t('apps.detail.disconnectTitle', { name: title })}</DialogTitle>
      <DialogDescription>
        {t('apps.detail.disconnectBody')}
        <span class="mt-1 block" data-testid="apps-detail-disconnect-impact">
          {impact.botNames.length > 0
            ? t('apps.detail.disconnectAffected', { bots: impact.botNames.join('、') })
            : t('apps.detail.disconnectNoBots')}
        </span>
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <Button variant="outline" onclick={() => (confirmOpen = false)}>
        {t('apps.detail.cancel')}
      </Button>
      <Button
        variant="destructive"
        disabled={disconnecting}
        onclick={() => void disconnect()}
        data-testid="apps-detail-disconnect-confirm"
      >
        {t('apps.detail.confirmDisconnect')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
