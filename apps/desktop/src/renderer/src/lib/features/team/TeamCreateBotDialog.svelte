<script lang="ts">
  import { t, errorText } from '$lib/i18n';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import { Button } from '$lib/components/ui/button';
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
  import { loadTeamBots } from './team-bots.svelte';
  import { TeamCreateBotState, TEAM_BOT_NAME_MAX } from './team-bot-dialogs.svelte';
  import { createTeamBotConversational } from '$lib/features/bot-setup';
  import TeamWorkdirPicker from './TeamWorkdirPicker.svelte';

  /**
   * 团队建 Bot 对话框（member-bots B4 子域 A）：模式（private 默认；public 仅
   * canCreatePublicBot）+ 可选名称 + 工作路径（缺省「自动分配专属目录」）→
   * `team.bots.create { interview: true }` → 关闭并跳转新访谈会话（团队来源
   * 切片）。自包含：内部拉能力面 / 提交 / 错误处理，宿主只管挂载与开关。
   */
  let { source, onClose }: { source: SourceId; onClose: () => void } = $props();

  const state = new TeamCreateBotState(source, {
    submit: (input) => createTeamBotConversational(source, input),
    refresh: () => loadTeamBots(source),
  });

  $effect(() => {
    void state.init();
  });

  async function submit(): Promise<void> {
    const created = await state.submit();
    if (created) onClose();
  }
</script>

<Dialog
  open={true}
  onOpenChange={(open) => {
    if (!open) onClose();
  }}
>
  <DialogContent class="sm:max-w-md" data-testid="team-create-bot-dialog">
    <DialogHeader>
      <DialogTitle>{t('teamBot.createTitle')}</DialogTitle>
      <DialogDescription>{t('teamBot.createDescription')}</DialogDescription>
    </DialogHeader>

    <div class="space-y-4">
      <!-- 模式：private 默认；public 仅 canCreatePublicBot（无权限隐藏并说明）。 -->
      <div class="grid gap-1.5">
        <Label>{t('teamBot.modeLabel')}</Label>
        <div class="space-y-1.5">
          <button
            type="button"
            class="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40
              {state.mode === 'private' ? 'border-primary/50 bg-accent' : 'bg-background'}"
            onclick={() => (state.mode = 'private')}
            data-testid="team-create-bot-mode-private"
            data-selected={state.mode === 'private' ? 'true' : undefined}
          >
            <span class="min-w-0 flex-1">
              <span class="block font-medium">{t('teamBot.modePrivate')}</span>
              <span class="block text-xs text-muted-foreground">{t('teamBot.modePrivateHint')}</span>
              {#if state.quota !== null}
                <span class="block text-xs text-muted-foreground" data-testid="team-create-bot-quota">
                  {t('teamBot.quotaLabel', { used: state.quota.used, limit: state.quota.limit })}
                </span>
              {/if}
            </span>
          </button>
          {#if state.publicAllowed}
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40
                {state.mode === 'public' ? 'border-primary/50 bg-accent' : 'bg-background'}"
              onclick={() => (state.mode = 'public')}
              data-testid="team-create-bot-mode-public"
              data-selected={state.mode === 'public' ? 'true' : undefined}
            >
              <span class="min-w-0 flex-1">
                <span class="block font-medium">{t('teamBot.modePublic')}</span>
                <span class="block text-xs text-muted-foreground">{t('teamBot.modePublicHint')}</span>
              </span>
            </button>
          {:else if state.capabilities !== null}
            <p class="text-xs text-muted-foreground" data-testid="team-create-bot-public-unavailable">
              {t('teamBot.publicUnavailable')}
            </p>
          {/if}
        </div>
      </div>

      <!-- 名称可选：留空走访谈让 Bot 自己问。 -->
      <div class="grid gap-1.5">
        <Label for="team-bot-name">{t('teamBot.nameLabel')}</Label>
        <Input
          id="team-bot-name"
          bind:value={state.name}
          placeholder={t('teamBot.namePlaceholder')}
          maxlength={TEAM_BOT_NAME_MAX + 10}
          data-testid="team-create-bot-name"
        />
        <p class="text-xs text-muted-foreground">{t('teamBot.nameOptional')}</p>
        {#if state.nameInvalid}
          <p class="text-xs text-destructive" data-testid="team-create-bot-name-error">
            {t('teamBot.nameTooLong', { max: TEAM_BOT_NAME_MAX })}
          </p>
        {/if}
      </div>

      <!-- 工作路径：选项集选择（B-10），缺省自动分配专属目录。 -->
      <div class="grid gap-1.5">
        <Label>{t('teamBot.workdirLabel')}</Label>
        <button
          type="button"
          class="flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:border-primary/40
            {state.workdirPath === null ? 'border-primary/50 bg-accent' : 'bg-background'}"
          onclick={() => (state.workdirPath = null)}
          data-testid="team-create-bot-workdir-auto"
          data-selected={state.workdirPath === null ? 'true' : undefined}
        >
          <span class="min-w-0 flex-1">
            <span class="block font-medium">{t('teamBot.workdirAuto')}</span>
            <span class="block text-xs text-muted-foreground">{t('teamBot.workdirAutoHint')}</span>
          </span>
        </button>
        <TeamWorkdirPicker
          {source}
          selected={state.workdirPath}
          adminOnly={state.mode === 'public'}
          onSelect={(path) => (state.workdirPath = path)}
        />
      </div>

      {#if state.mode === 'private' && state.quotaFull}
        <p class="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="team-create-bot-limit">
          {t('teamBot.limitReached', { used: state.quota?.used ?? 0, limit: state.quota?.limit ?? 0 })}
        </p>
      {/if}
      {#if state.errorCode !== null}
        <p class="text-xs text-destructive" data-testid="team-create-bot-error">
          {errorText(state.errorCode, t('teamBot.createFailed'))}
        </p>
      {/if}
    </div>

    <DialogFooter>
      <Button variant="outline" disabled={state.submitting} onclick={onClose} data-testid="team-create-bot-cancel">
        {t('common.cancel')}
      </Button>
      <Button
        disabled={state.createDisabled}
        onclick={() => void submit()}
        data-testid="team-create-bot-submit"
      >
        {state.submitting ? t('teamBot.creating') : t('teamBot.createAction')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
