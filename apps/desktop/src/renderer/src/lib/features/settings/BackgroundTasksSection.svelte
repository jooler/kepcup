<script lang="ts">
  import {
    AGENT_BACKGROUND_EVERY_N_RUNS,
    agentSetupReasonOf,
    type Settings,
    type SettingValues,
  } from '@kepcup/shared';
  import { toast } from 'svelte-sonner';
  import { t } from '$lib/i18n';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';

  /**
   * 设置页「后台任务」（D72 P6，docs/design/28-external-agents-acp.md §8）：
   * 摘要 / 反思 / 记忆整理等后台 loop 由内置智能体还是某个外部智能体执行。
   * 默认「内置智能体」；明确选外部智能体后「选定即生效」——即使配置了内置
   * 模型也走它。降配项（技能生成默认关、项目组仅 @ 响应默认开）只在外部智能
   * 体真正接管时出现；不能用于后台的智能体列出原因（审查 S1）。
   */

  let {
    embedded = false,
    prefill: _prefill = null,
    onSaved,
  }: {
    /** 对话内设置卡：隐藏分区标题。保存仍走设置页同一条 `settings.update`。 */
    embedded?: boolean;
    prefill?: SettingValues | null;
    onSaved?: () => void;
  } = $props();

  const BUILTIN = 'builtin';
  const OFF = 'off';

  let busy = $state(false);

  const settings = $derived(settingsStore.settings);
  const tasks = $derived(
    settings?.backgroundTasks ?? {
      builtinEnabled: true,
      agentEnabled: true,
      agentSkillAuthoring: false,
      projectMentionOnly: true,
    },
  );
  /**
   * 内置模型覆盖哪些用途（与 core llm-router 的内置取法一致，按全局默认模型
   * 估算；Bot 自己配置的模型另算）：有主模型 → 全部；只有轻量模型 → 摘要、
   * 反思、记忆整理、路由判断。
   */
  const builtinScope = $derived.by((): 'all' | 'light' | 'none' => {
    if ((settings?.defaultMainModel ?? '').length > 0) return 'all';
    if ((settings?.defaultLightModel ?? '').length > 0) return 'light';
    return 'none';
  });
  /** 选择框当前值：builtin / off / 指定的 Agent id。 */
  const selected = $derived.by(() => {
    const agent = settings?.backgroundAgentId ?? '';
    if (tasks.agentEnabled && agent.length > 0) return agent;
    // 内置智能体（默认）：内置模型优先；没有内置模型时回落到各 Bot 自己的智能体。
    return tasks.agentEnabled || tasks.builtinEnabled !== false ? BUILTIN : OFF;
  });
  /** 当前选择是否会让外部智能体真正接管（部分）后台任务（决定降配项显隐）。 */
  const selectedAgent = $derived(selected === BUILTIN || selected === OFF ? null : selected);
  const usesExternal = $derived(
    selected === OFF
      ? false
      : selectedAgent !== null || (tasks.agentEnabled && builtinScope !== 'all'),
  );
  /** 已启用的 Agent；当前选中的若已停用仍列出以便看见。 */
  const options = $derived.by(() => {
    const enabled = agentsStore.agents.filter((agent) => agent.enabled);
    const current = selectedAgent !== null ? agentsStore.get(selectedAgent) : null;
    return current !== null && !enabled.includes(current) ? [...enabled, current] : enabled;
  });
  /** 指定的 Agent 已不在目录中（stale id）：仍渲染一项，不让选择框落空。 */
  const staleSelected = $derived(
    selectedAgent !== null && agentsStore.get(selectedAgent) === null ? selectedAgent : null,
  );
  /** 已启用但不能用于后台任务的 Agent 及原因。 */
  const blocked = $derived(
    agentsStore.agents.filter((agent) => agent.enabled && agent.backgroundBlocker !== null),
  );

  function usable(agentId: string): boolean {
    const view = agentsStore.get(agentId);
    return view !== null && agentSetupReasonOf(view) === null && view.backgroundBlocker === null;
  }

  async function save(patch: Partial<Settings>): Promise<boolean> {
    busy = true;
    try {
      await settingsStore.update(patch);
      onSaved?.();
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
        ? await save({
            backgroundAgentId: '',
            backgroundTasks: { ...tasks, builtinEnabled: false, agentEnabled: false },
          })
        : value === BUILTIN
          ? await save({
              backgroundAgentId: '',
              backgroundTasks: { ...tasks, builtinEnabled: true, agentEnabled: true },
            })
          : await save({
              backgroundAgentId: value,
              backgroundTasks: { ...tasks, builtinEnabled: true, agentEnabled: true },
            });
    // A failed save leaves the stored choice: show it again (审查 C7).
    if (!ok) select.value = selected;
  }
</script>

<section class="space-y-3" data-testid="background-tasks-section">
  {#if !embedded}
    <h3 class="text-sm font-medium">{t('agents.background.title')}</h3>
    <p class="text-xs text-muted-foreground">{t('agents.background.hint')}</p>
  {/if}
  {#if selected === BUILTIN && builtinScope === 'light'}
    <p class="text-xs text-muted-foreground" data-testid="background-tasks-builtin">
      {t(
        tasks.agentEnabled
          ? 'agents.background.builtinLightOnly'
          : 'agents.background.builtinLightOnlyNoAgent',
      )}
    </p>
  {:else if selected === BUILTIN && builtinScope === 'none'}
    <p class="text-xs text-muted-foreground" data-testid="background-tasks-builtin">
      {t(
        tasks.agentEnabled
          ? 'agents.background.builtinUnavailable'
          : 'agents.background.builtinUnavailableNoAgent',
      )}
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
      <option value={BUILTIN}>{t('agents.background.builtin')}</option>
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
    {#if usesExternal}
      <p class="text-xs text-muted-foreground">
        {t('agents.background.degraded', { n: String(AGENT_BACKGROUND_EVERY_N_RUNS) })}
      </p>
    {/if}
    {#if tasks.agentEnabled && blocked.length > 0}
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

  {#if usesExternal}
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
    <label class="flex items-start gap-2 text-sm" data-testid="background-tasks-project-mention-only">
      <Checkbox
        checked={tasks.projectMentionOnly}
        disabled={busy}
        onCheckedChange={(checked) =>
          void save({ backgroundTasks: { ...tasks, projectMentionOnly: checked === true } })}
      />
      <span class="space-y-0.5">
        <span class="block">{t('agents.background.projectMentionOnly')}</span>
        <span class="block text-xs text-muted-foreground"
          >{t('agents.background.projectMentionOnlyHint')}</span
        >
      </span>
    </label>
  {/if}
</section>
