<script lang="ts">
  import type { AppsSkillsInstallOutput, AppsSkillsOffers } from '@kepcup/shared';
  import { Sparkles } from '@lucide/svelte';
  import { toast } from 'svelte-sonner';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    failureText,
    promptStateOf,
    visibleBots,
    type SkillInstallResult,
  } from './connected-skills';

  /**
   * 随附技能提示（D73 P3 §7.6，设计 29 §4 `_meta.skills`）：应用连接完成后（连接面板的完成
   * 状态、设置里的连接详情）为被授权的 Bot 显示「{应用} 附带 N 个技能，安装到 {Bot}？」。
   * 数据来自 `apps.skills.offers`（只含 Bot 还没有的技能），`apps.skills_offer` 事件与
   * `skills.changed` 触发重拉。点「安装」= `apps.skills.install`：core 为每个技能提交一张
   * 既有的 `skill_import` 审批卡（来源 / commit / 扫描结果在卡上，在该 Bot 的单聊里批准），
   * **批准前什么都不会安装**；本组件从不自动安装。没有缺口时不渲染任何内容。
   */
  let { connectionId, testid = 'connected-skills' }: { connectionId: string; testid?: string } =
    $props();

  let offers = $state<AppsSkillsOffers | null>(null);
  let busyBot = $state<string | null>(null);
  let dismissed = $state<ReadonlySet<string>>(new Set());
  let results = $state<Record<string, SkillInstallResult[]>>({});

  async function load(): Promise<void> {
    const id = connectionId;
    try {
      const next = (await core.call('apps.skills.offers', {
        connectionId: id,
      })) as AppsSkillsOffers;
      if (id === connectionId) offers = next;
    } catch {
      // 连接已不存在 / core 未就绪：当作没有提示。
      if (id === connectionId) offers = null;
    }
  }

  $effect(() => {
    void connectionId;
    void load();
    const offHints = core.onEvent('apps.skills_offer', (payload) => {
      if ((payload as { connectionId?: string }).connectionId === connectionId) void load();
    });
    // 技能装好 / 卸载后缺口变化。
    const offChanged = core.onEvent('skills.changed', () => void load());
    return () => {
      offHints();
      offChanged();
    };
  });

  const rows = $derived(visibleBots(offers?.bots ?? [], dismissed));

  function rpcError(error: unknown): string {
    const code = (error as { code?: string } | undefined)?.code;
    const fallback = error instanceof Error ? error.message : String(error);
    return errorText(code, fallback);
  }

  async function install(botId: string): Promise<void> {
    if (busyBot !== null) return;
    busyBot = botId;
    try {
      const out = (await core.call('apps.skills.install', {
        connectionId,
        botId,
      })) as AppsSkillsInstallOutput;
      results = { ...results, [botId]: out.results };
    } catch (error) {
      toast.error(rpcError(error));
    } finally {
      busyBot = null;
    }
  }

  function later(botId: string): void {
    dismissed = new Set([...dismissed, botId]);
  }
</script>

{#if offers !== null && rows.length > 0}
  <div class="space-y-2" data-testid={testid}>
    {#each rows as row (row.botId)}
      {@const state = promptStateOf(results[row.botId])}
      <div
        class="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5"
        data-testid={`${testid}-card`}
        data-bot={row.botId}
        data-state={state}
      >
        <p class="flex items-center gap-1.5 text-xs font-medium">
          <Sparkles class="size-3.5 text-primary" aria-hidden="true" />
          {t('apps.skills.prompt', {
            app: offers.title,
            count: row.skills.length,
            bot: row.botName,
          })}
        </p>
        <ul class="space-y-0.5 text-xs" data-testid={`${testid}-list`}>
          {#each row.skills as skill (skill.name)}
            <li>
              <code class="rounded bg-muted px-1 py-0.5 text-[11px]">{skill.name}</code>
              {#if skill.description.length > 0}
                <span class="text-muted-foreground">{skill.description}</span>
              {/if}
              <span class="block text-[11px] break-all text-muted-foreground">
                {t('apps.skills.source', { source: skill.source })}
              </span>
            </li>
          {/each}
        </ul>
        {#if state === 'submitted'}
          <p class="text-xs text-muted-foreground" data-testid={`${testid}-submitted`}>
            {t('apps.skills.submitted', { bot: row.botName })}
          </p>
        {:else if state === 'pending'}
          <p class="text-xs text-muted-foreground" data-testid={`${testid}-pending`}>
            {t('apps.skills.pending', { bot: row.botName })}
          </p>
        {:else}
          <p class="text-xs text-muted-foreground">{t('apps.skills.hint', { bot: row.botName })}</p>
          {#if state === 'failed'}
            <p class="text-xs text-destructive" data-testid={`${testid}-failed`}>
              {t('apps.skills.failed', { error: failureText(results[row.botId]) })}
            </p>
          {/if}
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              disabled={busyBot !== null}
              onclick={() => void install(row.botId)}
              data-testid={`${testid}-install`}
            >
              {t('apps.skills.install', { bot: row.botName })}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busyBot !== null}
              onclick={() => later(row.botId)}
              data-testid={`${testid}-later`}
            >
              {t('apps.skills.later')}
            </Button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
