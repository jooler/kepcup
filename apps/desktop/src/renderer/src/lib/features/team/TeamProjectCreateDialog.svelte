<script lang="ts">
  import { t, errorText } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import BotAvatar from '$lib/avatars/BotAvatar.svelte';
  import MemberAvatar from './MemberAvatar.svelte';
  import { teamProjectCreate } from './team-project-create.svelte';

  /**
   * 团队项目组创建对话框（member-bots B4 子域 A）：挂在 `teamProjectCreate`
   * 宿主上（`openTeamProjectCreate(source)` 打开）；lead 单选 + Bot / 人类成员
   * 多选，提交组装 projects.create（经团队来源）+ team.projects.addMembers。
   */
  const state = $derived(teamProjectCreate.state);

  async function submit(): Promise<void> {
    if (state === null) return;
    if (await state.submit()) teamProjectCreate.close();
  }
</script>

<Dialog
  open={state !== null}
  onOpenChange={(open) => {
    if (!open && state?.submitting !== true) teamProjectCreate.close();
  }}
>
  <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-md" data-testid="team-project-create-dialog">
    {#if state !== null}
      <DialogHeader>
        <DialogTitle>{t('teamBot.projectTitle')}</DialogTitle>
        <DialogDescription>{t('teamBot.projectDescription')}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        {#if state.loading}
          <p class="py-8 text-center text-sm text-muted-foreground" data-testid="team-project-create-loading">
            {t('common.loading')}
          </p>
        {:else if state.loadError !== null}
          <p class="py-6 text-sm text-destructive" data-testid="team-project-create-error">
            {errorText(state.loadError, t('teamBot.projectLoadFailed'))}
          </p>
        {:else}
          <!-- lead（单选） -->
          <div class="grid gap-1.5">
            <p class="text-xs font-medium">{t('teamBot.projectLeadLabel')}</p>
            {#if state.bots.length === 0}
              <p class="text-xs text-muted-foreground" data-testid="team-project-create-no-bots">
                {t('teamBot.projectNoBots')}
              </p>
            {:else}
              <ul class="space-y-0.5">
                {#each state.bots as bot (bot.id)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:border-primary/40
                        {state.leadBotId === bot.id ? 'border-primary/50 bg-accent' : 'bg-background'}"
                      onclick={() => state.selectLead(bot.id)}
                      data-selected={state.leadBotId === bot.id ? 'true' : undefined}
                      data-testid={`team-project-lead-${bot.id}`}
                    >
                      <BotAvatar botId={bot.id} name={bot.name} avatar={null} accentColor={null} class="size-7" fallbackClass="text-xs" />
                      <span class="min-w-0 flex-1 truncate">{bot.name || bot.id}</span>
                      {#if state.leadBotId === bot.id}
                        <span class="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] text-amber-600 dark:text-amber-400">
                          {t('teamBot.projectLeadBadge')}
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- Bot 成员（多选，lead 不重复出现） -->
          {#if state.botCandidates.length > 0}
            <div class="grid gap-1.5">
              <p class="text-xs font-medium">{t('teamBot.projectBotMembersLabel')}</p>
              <ul class="space-y-0.5">
                {#each state.botCandidates as bot (bot.id)}
                  <li>
                    <label class="flex w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-sm">
                      <Checkbox
                        checked={state.memberBotIds.includes(bot.id)}
                        onCheckedChange={() => state.toggleBotMember(bot.id)}
                        data-testid={`team-project-member-${bot.id}`}
                      />
                      <BotAvatar botId={bot.id} name={bot.name} avatar={null} accentColor={null} class="size-6" fallbackClass="text-[10px]" />
                      <span class="min-w-0 flex-1 truncate">{bot.name || bot.id}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          <!-- 人类成员（多选；自己由服务端强制为唯一 initial 主体，这里不列） -->
          {#if state.humans.length > 0}
            <div class="grid gap-1.5">
              <p class="text-xs font-medium">{t('teamBot.projectHumanMembersLabel')}</p>
              <ul class="space-y-0.5">
                {#each state.humans as member (member.id)}
                  <li>
                    <label class="flex w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-2 text-sm">
                      <Checkbox
                        checked={state.humanMemberIds.includes(member.id)}
                        onCheckedChange={() => state.toggleHuman(member.id)}
                        data-testid={`team-project-human-${member.id}`}
                      />
                      <MemberAvatar name={member.displayName} avatar={null} state="offline" class="size-6 text-[10px]" />
                      <span class="min-w-0 flex-1 truncate">{member.displayName}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          {#if state.titlePreview.length > 0}
            <p class="text-xs text-muted-foreground" data-testid="team-project-create-title-preview">
              {t('common.labelValue', { label: t('teamBot.projectTitleLabel'), value: state.titlePreview })}
            </p>
          {/if}
          {#if state.errorCode !== null}
            <p class="text-xs text-destructive" data-testid="team-project-create-error-submit">
              {errorText(state.errorCode, t('teamBot.projectCreateFailed'))}
            </p>
          {/if}
        {/if}
      </div>

      <DialogFooter>
        <Button
          variant="outline"
          disabled={state.submitting}
          onclick={() => teamProjectCreate.close()}
          data-testid="team-project-create-cancel"
        >
          {t('common.cancel')}
        </Button>
        <Button disabled={state.submitDisabled} onclick={() => void submit()} data-testid="team-project-create-submit">
          {state.submitting ? t('teamBot.projectCreating') : t('teamBot.projectCreateAction')}
        </Button>
      </DialogFooter>
    {/if}
  </DialogContent>
</Dialog>
