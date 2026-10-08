<script lang="ts">
  import { AGENT_BACKGROUND_EVERY_N_RUNS, agentSetupReasonOf, type Settings } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';

  /**
   * 设置页「后台任务」（D72 P6，docs/design/28-external-agents-acp.md §8）：
   * 没有内置模型时后台 loop 用哪个外部智能体（自动 = 只用 Bot 自己的 / 指定 /
   * 关闭）与降配项（技能生成默认关、群聊仅 @ 响应默认开）。哪些用途仍走内置
   * 模型按两个默认模型逐用途提示；不能用于后台的智能体列出原因（审查 S1）。
   */

  const OFF = 'off';
  const AUTO = '';

  let busy = $state(false);

  const settings = $derived(settingsStore.settings);
  const tasks = $derived(
    settings?.backgroundTasks ?? {
      agentEnabled: true,
      agentSkillAuthoring: false,
      groupMentionOnly: true,
    },
  );
  /**
   * 仍走内置模型的用途（与 core llm-router 的内置取法一致，按全局默认模型
   * 估算；Bot 自己配置的模型另算）：有主模型 → 全部；只有轻量模型 → 摘要、
   * 反思、记忆整理、群聊判断。
   */
  const builtinScope = $derived.by((): 'all' | 'light' | 'none' => {
    if ((settings?.defaultMainModel ?? '').length > 0) return 'all';
    if ((settings?.defaultLightModel ?? '').length > 0) return 'light';
    return 'none';
  });
  /** 选择框当前值：off / ''（自动）/ Agent id。 */
  const selected = $derived(tasks.agentEnabled ? (settings?.backgroundAgentId ?? AUTO) : OFF);
  /** 已启用的 Agent；当前选中的若已停用仍列出以便看见。 */
  const options = $derived.by(() => {
    const enabled = agentsStore.agents.filter((agent) => agent.enabled);
    const current = selected !== OFF && selected !== AUTO ? agentsStore.get(selected) : null;
    return current !== null && !enabled.includes(current) ? [...enabled, current] : enabled;
  });
  /** 指定的 Agent 已不在目录中（stale id）：仍渲染一项，不让选择框落空。 */
  const staleSelected = $derived(
    selected !== OFF && selected !== AUTO && agentsStore.get(selected) === null ? selected : null,
  );
  /** 已启用但不能用于后台任务的 Agent 及原因。 */
  const blocked = $derived(
    agentsStore.agents.filter((agent) => agent.enabled && agent.backgroundBlocker !== null),
  );

  function usable(agentId: string): boolean {
    const view = agentsStore.get(agentId);
    return (
      view !== null &&
      agentSetupReasonOf(view, agentsStore.experimental) === null &&
      view.backgroundBlocker === null
    );
  }

  async function save(patch: Partial<Settings>): Promise<boolean> {
    busy = true;
    try {
      await settingsStore.update(patch);
      return true;
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
      return false;
    } finally {
      busy = false;
    }
  }

  async function choose(select: HTMLSelectElement): Promise<void> {
    const value = select.value;
    const ok =
      value === OFF
        ? await save({ backgroundTasks: { ...tasks, agentEnabled: false } })
        : await save({
            backgroundAgentId: value,
            backgroundTasks: { ...tasks, agentEnabled: true },
          });
    // A failed save leaves the stored choice: show it again (审查 C7).
    if (!ok) select.value = selected;
  }
</script>

<section class="space-y-3" data-testid="background-tasks-section">
  <h3 class="text-sm font-medium">{t('agents.background.title')}</h3>
  <p class="text-xs text-muted-foreground">{t('agents.background.hint')}</p>
  {#if builtinScope === 'all'}
    <p class="text-xs text-muted-foreground" data-testid="background-tasks-builtin">
      {t('agents.background.builtinActive')}
    </p>
  {:else if builtinScope === 'light'}
    <p class="text-xs text-muted-foreground" data-testid="background-tasks-builtin">
      {t('agents.background.builtinLightOnly')}
    </p>
  {/if}

  <div class="grid gap-1.5">
    <Label for="background-tasks-agent">{t('agents.background.agent')}</Label>
    <select
      id="background-tasks-agent"
      class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
      value={selected}
      disabled={busy}
      onchange={(event) => void choose(event.currentTarget)}
      data-testid="background-tasks-agent-select"
    >
      <option value={AUTO}>{t('agents.background.auto')}</option>
      {#each options as agent (agent.id)}
        <option value={agent.id}>
          {agent.name}{usable(agent.id) ? '' : t('agents.background.unavailable')}
        </option>
      {/each}
      {#if staleSelected !== null}
        <option value={staleSelected}>
          {staleSelected}{t('agents.background.notInCatalog')}
        </option>
      {/if}
      <option value={OFF}>{t('agents.background.off')}</option>
    </select>
    <p class="text-xs text-muted-foreground">
      {t('agents.background.degraded', { n: String(AGENT_BACKGROUND_EVERY_N_RUNS) })}
    </p>
    {#if blocked.length > 0}
      <ul class="space-y-0.5 text-xs text-muted-foreground" data-testid="background-tasks-blocked">
        {#each blocked as agent (agent.id)}
          <li>
            {t('agents.background.blocked', {
              name: agent.name,
              reason: agent.backgroundBlocker ?? '',
            })}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if tasks.agentEnabled}
    <label class="flex items-start gap-2 text-sm" data-testid="background-tasks-skill-authoring">
      <Checkbox
        checked={tasks.agentSkillAuthoring}
        disabled={busy}
        onCheckedChange={(checked) =>
          void save({ backgroundTasks: { ...tasks, agentSkillAuthoring: checked === true } })}
      />
      <span class="space-y-0.5">
        <span class="block">{t('agents.background.skillAuthoring')}</span>
        <span class="block text-xs text-muted-foreground"
          >{t('agents.background.skillAuthoringHint')}</span
        >
      </span>
    </label>
    <label class="flex items-start gap-2 text-sm" data-testid="background-tasks-group-mention-only">
      <Checkbox
        checked={tasks.groupMentionOnly}
        disabled={busy}
        onCheckedChange={(checked) =>
          void save({ backgroundTasks: { ...tasks, groupMentionOnly: checked === true } })}
      />
      <span class="space-y-0.5">
        <span class="block">{t('agents.background.groupMentionOnly')}</span>
        <span class="block text-xs text-muted-foreground"
          >{t('agents.background.groupMentionOnlyHint')}</span
        >
      </span>
    </label>
  {/if}
</section>
