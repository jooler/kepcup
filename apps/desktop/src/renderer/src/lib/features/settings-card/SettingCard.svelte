<script lang="ts">
  import { getSettingItem, type Message, type SettingValues } from '@kepcup/shared';
  import { ExternalLink, SlidersHorizontal } from '@lucide/svelte';
  import { userPrefersMode } from 'mode-watcher';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import {
    i18n,
    localeOptions,
    settingFieldText,
    settingItemText,
    settingOptionText,
    t,
  } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { getChatSession } from '$lib/features/chats/chat-session-context';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { sensors } from '$lib/sensors/sensors.svelte';
  import { Button } from '$lib/components/ui/button';
  import SettingCardEmbed from './SettingCardEmbed.svelte';
  import { cardEmbeddable } from './card-components';
  import { openSettingDeepLink } from './open-deep-link';
  import { applyRendererValues } from './renderer-items';
  import {
    applySettingItem,
    autoVerifySettingCardOnce,
    completeSettingCard,
    dismissSettingCard,
    undoSettingCard,
  } from './apply';
  import {
    SELF_APPLYING_CARD_KEYS,
    COMPONENT_SAVE_CARD_KEYS,
    embeddedCardKey,
    hostApplies,
    linkCardSettled,
    confirmHasFields,
    nonSensitiveValues,
    offersManualComplete,
    autoVerifiable,
    receiptUndo,
    settingCardOf,
    settingCardPrefill,
    settingCardStateKey,
    settingCardView,
    settingDiffRows,
    type ValueText,
  } from './setting-card-model';

  /**
   * 对话内设置卡（system_event `setting_card`，todo/conversational-app-setup.md §六）：Bot 用
   * settings_change 出的卡，留在消息流里（同一对话可并存多张），状态经 message.updated 重绘。
   *
   * - 回执卡（direct）：「原来 → 现在」+「撤销」（24 小时内，`settings.cards.undo`，冲突不覆盖）；
   * - confirm：「当前 → 建议」+「应用 / 不用了」；「应用」经 `settings.items.apply` 做条目级 CAS
   *   （`expected` = 出卡时的当前值），冲突时提示「设置已在别处修改」并按最新值刷新对比再确认；
   *   「改一下」展开同一个设置页组件（预填建议值）自己保存；
   * - form：内嵌设置页组件（Bot 只预填非敏感字段），保存后 `settings.cards.complete` 由 core 核对；
   * - user-only：空白卡——只显示 Bot 的理由与组件初始状态，不采用 Bot 的值；
   * - link：「在设置中打开」深链 +「我已设置好」；设置页保存触发 `settings.changed` 时自动完成。
   *
   * 「应用 / 不用了」都带卡片消息 id，core 据此唤醒 Bot 续答（每张卡一次，§6.2）。
   */
  let { message }: { message: Message } = $props();
  const session = getChatSession();

  const content = $derived(settingCardOf(message)!);
  const item = $derived(getSettingItem(content.itemId));
  const view = $derived(settingCardView(content));
  const pending = $derived(content.state === 'pending');
  const isProject = $derived(session.view?.conversation.type === 'project');
  /** bot 范围条目的作用 Bot：卡片 target，缺省为出卡的 Bot。 */
  const targetBotId = $derived(content.target.botId ?? content.botId);

  /** CAS 冲突后按 core 返回的最新值刷新「当前」；undefined = 用卡片上的 before。 */
  let refreshedBefore = $state<SettingValues | null | undefined>(undefined);
  const before = $derived(refreshedBefore !== undefined ? refreshedBefore : content.before);
  let conflict = $state(false);
  let undoConflict = $state(false);
  let notVerified = $state(false);
  let editing = $state(false);
  let busy = $state(false);

  const valueText = $derived<ValueText>({
    on: t('settingCard.value.on'),
    off: t('settingCard.value.off'),
    empty: t('settingCard.value.empty'),
    separator: t('common.listSeparator'),
    modelLabel: (ref) =>
      settingsStore.availableModelOptions.find((option) => option.ref === ref)?.label ?? null,
    fieldLabel: (name, label) => (item === null ? label : settingFieldText(item.id, name, label)),
    optionLabel: (fieldName, value, label) =>
      item === null ? label : settingOptionText(item.id, fieldName, value, label),
  });
  const after = $derived(
    view === 'receipt' ? (content.applied ?? content.proposed) : content.proposed,
  );
  const diff = $derived(item === null ? [] : settingDiffRows(item, before, after, valueText));
  /** core 给了人话快照（且没有冲突刷新过）时优先用它。 */
  const textDiff = $derived(
    refreshedBefore === undefined &&
      content.beforeText !== undefined &&
      content.proposedText !== undefined
      ? { before: content.beforeText, after: content.proposedText }
      : null,
  );
  const prefill = $derived(
    item === null ? null : settingCardPrefill(item, content.mode, content.proposed),
  );
  const embedKey = $derived.by(() => {
    if (item === null || !pending) return null;
    const context = {
      botId: targetBotId,
      conversationId: content.target.conversationId ?? session.conversationId,
      workdirId: content.target.workdirId ?? session.view?.conversation.workdirId ?? null,
      prefill,
      agent: (id: string) => agentsStore.get(id),
      defaultAgentId: settingsStore.settings?.defaultAgentId ?? null,
    };
    return embeddedCardKey(item, view, (entry) => cardEmbeddable(entry, context));
  });
  const selfApplying = $derived(embedKey !== null && SELF_APPLYING_CARD_KEYS.has(embedKey));
  const componentSaves = $derived(embedKey !== null && COMPONENT_SAVE_CARD_KEYS.has(embedKey));
  const showHostApply = $derived(item !== null && pending && hostApplies(item, view, after));
  /** 没有可编辑字段的 confirm 卡（如关闭无人值守）直接展开组件。 */
  const embedImmediately = $derived(item !== null && view === 'confirm' && !confirmHasFields(item));
  /** 组件区：自带应用的卡与 form / user-only 直接展开；confirm 的其余组件点「改一下」才展开。 */
  const showEmbed = $derived(
    embedKey !== null &&
      (selfApplying || componentSaves || view !== 'confirm' || editing || embedImmediately),
  );
  /** 没有可内嵌组件（或本来就是 link 档）：给「在设置中打开」。 */
  const showOpen = $derived(item !== null && pending && (view === 'link' || embedKey === null));
  // 撤销截止按渲染时刻判定（卡片随 message.updated 重绘；过期后点击 core 同样拒绝）。
  const undo = $derived(receiptUndo(content, Date.now()));
  const stateKey = $derived(settingCardStateKey(content.state, view));

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await action();
    } catch (error) {
      toast.error(t('settingCard.actionFailed', { error: errorMessage(error) }));
    } finally {
      busy = false;
    }
  }

  function onConflict(current: SettingValues | null): void {
    refreshedBefore = current;
    conflict = true;
  }

  /** confirm 卡「应用」：core 条目经 CAS 写入；渲染层条目本机写后让 core 标 applied。 */
  async function apply(): Promise<void> {
    const entry = item;
    const values = entry === null ? null : nonSensitiveValues(entry, after);
    if (entry === null || values === null) return;
    await run(async () => {
      if (entry.owner === 'renderer') {
        const written = applyRendererValues(entry, values, {
          setSensorEnabled: sensors.setEnabled,
          setSensorDevice: sensors.setDeviceId,
          setTheme: (theme) => {
            userPrefersMode.current = theme;
          },
          setLanguage: (language) => {
            i18n.locale = language;
          },
          languages: localeOptions.map((option) => option.id),
        });
        if (!written) {
          await openSettingDeepLink(entry, content.target, session.view?.conversation ?? null);
          return;
        }
        // core 写不了渲染层条目：本机写完再经同一入口结卡（记下应用的值、唤醒 Bot）。
        await applySettingItem({ itemId: entry.id, values, expected: null, messageId: message.id });
        toast.success(t('settingCard.appliedToast'));
        return;
      }
      const out = await applySettingItem({
        itemId: entry.id,
        values,
        expected: before,
        target: content.target,
        messageId: message.id,
      });
      if (out.status === 'conflict') {
        onConflict(out.current);
        return;
      }
      conflict = false;
      toast.success(t('settingCard.appliedToast'));
    });
  }

  async function complete(): Promise<void> {
    const out = await completeSettingCard(message.id);
    notVerified = out.verified === false && out.state === 'pending';
  }

  /** 内嵌组件自己保存成功：自带 CAS 的卡 core 已标 applied；其余让 core 核对一次。 */
  function embedSaved(): void {
    if (selfApplying) return;
    void run(complete);
  }

  async function dismiss(): Promise<void> {
    await run(async () => {
      await dismissSettingCard(message.id);
    });
  }

  async function revert(): Promise<void> {
    await run(async () => {
      const out = await undoSettingCard(message.id);
      undoConflict = out.status === 'conflict';
    });
  }

  // 打开对话时：待处理的 link / user-only / form 卡核对一次（用户可能在卡片没挂着时已在设置页做完）。
  // 每张卡本会话只请求一次，core 只在条目确实变过时结卡并唤醒 Bot。
  $effect(() => {
    if (!pending || !autoVerifiable(view)) return;
    const id = message.id;
    untrack(() => void autoVerifySettingCardOnce(id));
  });

  // link 卡：在设置页保存后 core 广播 settings.changed，含本条目即自动完成（§6.1）。只认挂载
  // 之后的变化（序号比挂载时新），同一张卡只发一次。
  const mountedSeq = untrack(() => settingsStore.changeSeq);
  let autoCompleted = false;
  $effect(() => {
    const seq = settingsStore.changeSeq;
    if (seq <= mountedSeq || autoCompleted) return;
    if (!linkCardSettled(content, settingsStore.lastChangedItemIds)) return;
    autoCompleted = true;
    void untrack(() => run(complete));
  });
</script>

<div
  class="w-full max-w-xl min-w-0 rounded-lg border bg-background/80 p-3 text-sm"
  data-testid={`setting-card-${message.id}`}
  data-setting-card={content.itemId}
  data-state={content.state}
  data-view={view}
>
  <div class="flex items-start gap-2">
    <SlidersHorizontal
      class="mt-0.5 size-4 shrink-0 {pending ? 'text-sky-600' : 'text-muted-foreground'}"
      aria-hidden="true"
    />
    <div class="min-w-0 flex-1 space-y-0.5">
      <p class="font-medium break-words" data-testid="setting-card-title">
        {item === null ? content.itemId : settingItemText(item.id, 'title', item.title)}
        <span class="text-xs font-normal text-muted-foreground">
          · {t(`settingCard.view.${view}`)}{#if isProject}
            · {chat.botName(content.botId)}{/if}
        </span>
      </p>
      {#if content.reason.length > 0}
        <p
          class="text-xs break-words whitespace-pre-wrap text-muted-foreground"
          data-testid="setting-card-reason"
        >
          {content.reason}
        </p>
      {/if}
      {#if pending && content.modeReason !== undefined && content.modeReason.length > 0}
        <p class="text-xs text-muted-foreground" data-testid="setting-card-mode-reason">
          {content.modeReason}
        </p>
      {/if}
      {#if item === null}
        <p class="text-xs text-destructive">
          {t('settingCard.unknownItem', { id: content.itemId })}
        </p>
      {/if}
    </div>
  </div>

  {#if textDiff !== null || diff.length > 0}
    <div
      class="mt-2 space-y-1 rounded-md bg-muted/40 px-2.5 py-2 text-xs"
      data-testid="setting-card-diff"
    >
      <p class="text-muted-foreground">
        {view === 'receipt' ? t('settingCard.diffReceipt') : t('settingCard.diffConfirm')}
      </p>
      {#if textDiff !== null}
        <p class="break-words">
          <span data-testid="setting-card-before">{textDiff.before}</span>
          <span class="text-muted-foreground"> → </span>
          <span class="font-medium" data-testid="setting-card-after">{textDiff.after}</span>
        </p>
      {:else}
        {#each diff as row (row.name)}
          <p class="break-words" data-testid={`setting-card-diff-${row.name}`}>
            <span class="text-muted-foreground"
              >{t('settingCard.fieldLine', { label: row.label })}</span
            >
            <span data-testid="setting-card-before">{row.before}</span>
            <span class="text-muted-foreground"> → </span>
            <span class="font-medium" data-testid="setting-card-after">{row.after}</span>
          </p>
        {/each}
      {/if}
    </div>
  {/if}

  {#if conflict && pending}
    <p class="mt-2 text-xs text-amber-700 dark:text-amber-400" data-testid="setting-card-conflict">
      {t('settingCard.conflict')}
    </p>
  {/if}
  {#if notVerified && pending}
    <p
      class="mt-2 text-xs text-amber-700 dark:text-amber-400"
      data-testid="setting-card-not-verified"
    >
      {t('settingCard.notVerified')}
    </p>
  {/if}

  {#if pending}
    {#if view === 'user-only'}
      <p class="mt-2 text-xs text-muted-foreground">{t('settingCard.userOnlyHint')}</p>
    {:else if view === 'link' || embedKey === null}
      <p class="mt-2 text-xs text-muted-foreground">{t('settingCard.linkHint')}</p>
    {/if}

    {#if showEmbed && item !== null}
      <div class="mt-2 min-w-0 rounded-md border p-2.5" data-testid="setting-card-embed">
        <SettingCardEmbed
          {item}
          {prefill}
          botId={targetBotId}
          conversationId={content.target.conversationId ?? session.conversationId}
          workdirId={content.target.workdirId ?? session.view?.conversation.workdirId ?? null}
          expected={before}
          messageId={message.id}
          onSaved={embedSaved}
          {onConflict}
        />
      </div>
    {/if}

    <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
      <Button
        size="sm"
        variant="outline"
        class="h-7"
        disabled={busy}
        onclick={() => void dismiss()}
        data-testid="setting-card-dismiss">{t('settingCard.dismiss')}</Button
      >
      {#if showOpen && item !== null}
        <Button
          size="sm"
          variant="outline"
          class="h-7"
          onclick={() => void openSettingDeepLink(item, content.target, session.view?.conversation ?? null)}
          data-testid="setting-card-open"
        >
          <ExternalLink class="size-3.5" aria-hidden="true" />
          {t('settingCard.openSettings')}
        </Button>
      {/if}
      {#if view === 'confirm' && embedKey !== null && !selfApplying && !componentSaves && item !== null && confirmHasFields(item)}
        <Button
          size="sm"
          variant="ghost"
          class="h-7"
          onclick={() => (editing = !editing)}
          data-testid="setting-card-edit"
          >{editing ? t('settingCard.editHide') : t('settingCard.edit')}</Button
        >
      {/if}
      {#if offersManualComplete(view)}
        <Button
          size="sm"
          variant="secondary"
          class="h-7"
          disabled={busy}
          onclick={() => void run(complete)}
          data-testid="setting-card-done">{t('settingCard.done')}</Button
        >
      {/if}
      {#if showHostApply}
        <Button
          size="sm"
          class="h-7"
          disabled={busy}
          onclick={() => void apply()}
          data-testid="setting-card-apply">{t('settingCard.apply')}</Button
        >
      {/if}
    </div>
  {:else}
    <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
      {#if stateKey !== null}
        <span class="mr-auto text-xs text-muted-foreground" data-testid="setting-card-state"
          >{t(stateKey)}</span
        >
      {/if}
      {#if undoConflict}
        <span
          class="text-xs text-amber-700 dark:text-amber-400"
          data-testid="setting-card-undo-conflict">{t('settingCard.undoConflict')}</span
        >
      {/if}
      {#if undo.available}
        <Button
          size="sm"
          variant="outline"
          class="h-7"
          disabled={busy}
          onclick={() => void revert()}
          data-testid="setting-card-undo">{t('settingCard.undo')}</Button
        >
      {:else if undo.expired}
        <span class="text-xs text-muted-foreground" data-testid="setting-card-undo-expired"
          >{t('settingCard.undoExpired')}</span
        >
      {/if}
    </div>
  {/if}
</div>
