<script lang="ts">
  import { t, errorText } from '$lib/i18n';
  import type { SourceId } from '$lib/rpc/connections.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { TEAM_BOT_NAME_MAX, TeamBotEditState } from './team-bot-dialogs.svelte';
  import TeamWorkdirPicker from './TeamWorkdirPicker.svelte';

  /**
   * 团队 Bot 编辑对话框（member-bots B4 子域 A）：identity / persona / role /
   * boundaries / behavior（字段参照本机 Bot 编辑）+ 模型（team.bots.modelOptions，
   * 限服务器启用列表）+ 工作路径（TeamWorkdirPicker）。私有 Bot 底部「转交给
   * 成员」（active 成员选择器）与「删除」（确认）；公共 Bot 无转交。保存 →
   * `team.bots.update`（子结构整体替换，未碰字段以加载基线回填）。自包含：
   * 宿主只传 { source, botId, onClose }。
   */
  let { source, botId, onClose }: { source: SourceId; botId: string; onClose: () => void } = $props();

  const state = new TeamBotEditState(source, botId);

  $effect(() => {
    void state.init();
  });

  async function save(): Promise<void> {
    if (await state.save()) onClose();
  }

  async function transfer(): Promise<void> {
    if (await state.transfer()) onClose();
  }

  async function remove(): Promise<void> {
    if (await state.remove()) onClose();
  }
</script>

<Dialog
  open={true}
  onOpenChange={(open) => {
    if (!open && !state.deleting) onClose();
  }}
>
  <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-lg" data-testid="team-bot-edit-dialog">
    <DialogHeader>
      <DialogTitle>{t('teamBot.editTitle')}</DialogTitle>
      <DialogDescription>{t('teamBot.editDescription')}</DialogDescription>
    </DialogHeader>

    {#if state.loading}
      <p class="py-8 text-center text-sm text-muted-foreground" data-testid="team-bot-edit-loading">
        {t('common.loading')}
      </p>
    {:else if state.loadError !== null}
      <div class="space-y-2 py-6" data-testid="team-bot-edit-error">
        <p class="text-sm text-destructive">{errorText(state.loadError, t('teamBot.editLoadFailed'))}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" onclick={onClose}>{t('common.close')}</Button>
        </div>
      </div>
    {:else if state.view !== null}
      <div class="space-y-4">
        <!-- identity -->
        <div class="grid gap-1.5">
          <Label for="team-edit-name">{t('contacts.name')}</Label>
          <Input
            id="team-edit-name"
            bind:value={state.name}
            placeholder={t('contacts.namePlaceholder')}
            maxlength={TEAM_BOT_NAME_MAX + 10}
            data-testid="team-bot-edit-name"
          />
          {#if state.nameInvalid}
            <p class="text-xs text-destructive" data-testid="team-bot-edit-name-error">
              {state.name.trim().length === 0
                ? t('teamBot.nameRequired')
                : t('teamBot.nameTooLong', { max: TEAM_BOT_NAME_MAX })}
            </p>
          {/if}
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-bio">{t('contacts.bio')}</Label>
          <Input id="team-edit-bio" bind:value={state.bio} placeholder={t('contacts.bioPlaceholder')} data-testid="team-bot-edit-bio" />
        </div>

        <!-- persona -->
        <div class="grid gap-1.5">
          <Label for="team-edit-personality">{t('contacts.personality')}</Label>
          <Textarea id="team-edit-personality" bind:value={state.personality} rows={2} data-testid="team-bot-edit-personality" />
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-tone">{t('contacts.tone')}</Label>
          <Textarea id="team-edit-tone" bind:value={state.tone} rows={2} />
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-style">{t('contacts.style')}</Label>
          <Textarea id="team-edit-style" bind:value={state.style} rows={2} />
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-values">{t('contacts.values')}</Label>
          <Textarea id="team-edit-values" bind:value={state.values} rows={2} />
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-samples">{t('contacts.sampleDialogues')}</Label>
          <Textarea id="team-edit-samples" bind:value={state.sampleDialogues} rows={3} />
        </div>

        <!-- role -->
        <div class="grid gap-1.5">
          <Label for="team-edit-expertise">{t('contacts.expertise')}</Label>
          <Textarea id="team-edit-expertise" bind:value={state.expertise} rows={2} />
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-responsibilities">{t('contacts.responsibilities')}</Label>
          <Textarea id="team-edit-responsibilities" bind:value={state.responsibilities} rows={2} />
        </div>
        <div class="grid gap-1.5">
          <Label for="team-edit-boundaries">{t('contacts.boundaries')}</Label>
          <Textarea id="team-edit-boundaries" bind:value={state.boundariesText} rows={2} data-testid="team-bot-edit-boundaries" />
        </div>

        <!-- behavior -->
        <label class="flex items-center gap-2 text-sm" data-testid="team-bot-edit-proactive">
          <Checkbox id="team-edit-proactive" bind:checked={state.proactive} />
          {t('teamBot.behaviorProactive')}
        </label>

        <!-- model -->
        <div class="grid gap-1.5">
          <Label for="team-edit-model">{t('contacts.mainModel')}</Label>
          <select
            id="team-edit-model"
            class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
            bind:value={state.model}
            data-testid="team-bot-edit-model"
          >
            <option value="">{t('contacts.modelDefault')}</option>
            {#each state.modelOptions as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        </div>

        <!-- workdir：当前绑定 + 选项集改绑（未改动不进 patch；opaque key + 展示名，
             服务器真实路径不出服务端——2026-11 工作路径重构）。 -->
        <div class="grid gap-1.5">
          <Label>{t('teamBot.workdirLabel')}</Label>
          <p class="text-xs text-muted-foreground" data-testid="team-bot-edit-workdir-current">
            {t('teamBot.workdirCurrent', {
              path: state.currentWorkdirName ?? t('teamBot.workdirUnbound'),
            })}
          </p>
          <TeamWorkdirPicker
            {source}
            selected={state.workdirKey ?? null}
            adminOnly={state.view.mode !== 'private'}
            onSelect={(key) => (state.workdirKey = key)}
          />
        </div>

        {#if state.saveError !== null}
          <p class="text-xs text-destructive" data-testid="team-bot-edit-save-error">
            {errorText(state.saveError, t('teamBot.editSaveFailed'))}
          </p>
        {/if}

        <!-- 私有 Bot：转交 + 删除（B-7：目录与 memory 不迁移，旧 owner 立即失可见）。 -->
        {#if state.isPrivate}
          <div class="space-y-2 rounded-lg border p-3" data-testid="team-bot-edit-transfer">
            <p class="text-sm font-medium">{t('teamBot.transferAction')}</p>
            <p class="text-xs text-muted-foreground">{t('teamBot.transferHint')}</p>
            {#if state.members.length > 0}
              <div class="grid gap-1.5">
                <Label for="team-edit-transfer-target">{t('teamBot.transferTarget')}</Label>
                <select
                  id="team-edit-transfer-target"
                  class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                  bind:value={state.transferMemberId}
                  data-testid="team-bot-edit-transfer-target"
                >
                  <option value="">{t('teamBot.transferPickPlaceholder')}</option>
                  {#each state.members as member (member.id)}
                    <option value={member.id}>{member.displayName}</option>
                  {/each}
                </select>
              </div>
              {#if state.transferError !== null}
                <p class="text-xs text-destructive" data-testid="team-bot-edit-transfer-error">
                  {errorText(state.transferError, t('teamBot.transferFailed'))}
                </p>
              {/if}
              <Button
                variant="outline"
                class="h-8 w-fit"
                disabled={state.transferDisabled}
                onclick={() => void transfer()}
                data-testid="team-bot-edit-transfer-submit"
              >
                {state.transferring ? t('teamBot.transferring') : t('teamBot.transferConfirm')}
              </Button>
            {:else}
              <p class="text-xs text-muted-foreground">{t('teamBot.transferNoTargets')}</p>
            {/if}
          </div>
        {/if}
        {#if state.view.canDelete}
          <div class="space-y-2 rounded-lg border border-destructive/30 p-3" data-testid="team-bot-edit-delete">
            {#if !state.confirmingDelete}
              <Button
                variant="ghost"
                class="h-8 w-fit text-destructive hover:text-destructive"
                onclick={() => (state.confirmingDelete = true)}
                data-testid="team-bot-edit-delete-open"
              >
                {t('teamBot.deleteAction')}
              </Button>
            {:else}
              <p class="text-sm">{t('teamBot.deleteConfirmBody')}</p>
              {#if state.deleteError !== null}
                <p class="text-xs text-destructive" data-testid="team-bot-edit-delete-error">
                  {errorText(state.deleteError, t('teamBot.deleteFailed'))}
                </p>
              {/if}
              <div class="flex gap-2">
                <Button
                  variant="destructive"
                  class="h-8"
                  disabled={state.deleting}
                  onclick={() => void remove()}
                  data-testid="team-bot-edit-delete-confirm"
                >
                  {state.deleting ? t('teamBot.deleting') : t('teamBot.deleteConfirmYes')}
                </Button>
                <Button variant="outline" class="h-8" disabled={state.deleting} onclick={() => (state.confirmingDelete = false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <DialogFooter>
        <Button variant="outline" disabled={state.saving} onclick={onClose} data-testid="team-bot-edit-cancel">
          {t('common.cancel')}
        </Button>
        <Button disabled={state.saveDisabled} onclick={() => void save()} data-testid="team-bot-edit-save">
          {state.saving ? t('teamBot.saving') : t('common.save')}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
