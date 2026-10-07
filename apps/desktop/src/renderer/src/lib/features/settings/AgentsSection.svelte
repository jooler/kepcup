<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import AgentCard from './AgentCard.svelte';

  /**
   * 设置页「智能体」（D72，docs/design/28-external-agents-acp.md §2.2）：实验
   * 开关 + 目录卡片（`AgentCard`：与对话内 Agent 设置卡、onboarding 订阅分支
   * 共用同一份卡片与保存 RPC）。
   */

  let experimentalBusy = $state(false);
  let defaultBusy = $state(false);

  /**
   * 新建 Bot 的默认智能体（`settings.defaultAgentId`，onboarding「我有订阅」
   * 写入）：可选已启用的 Agent；当前值不在其中（已停用）时仍列出以便看见。
   */
  const defaultAgentId = $derived(settingsStore.settings?.defaultAgentId ?? '');
  const defaultAgentOptions = $derived.by(() => {
    const enabled = agentsStore.agents.filter((agent) => agent.enabled);
    const current = agentsStore.get(defaultAgentId);
    return current !== null && !enabled.includes(current) ? [...enabled, current] : enabled;
  });

  async function setDefaultAgent(id: string): Promise<void> {
    defaultBusy = true;
    try {
      await settingsStore.update({ defaultAgentId: id });
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      defaultBusy = false;
    }
  }

  $effect(() => {
    agentsStore.start();
    void agentsStore.refresh().catch(() => undefined);
  });

  async function toggleExperimental(enabled: boolean): Promise<void> {
    experimentalBusy = true;
    try {
      await agentsStore.setExperimental(enabled);
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      experimentalBusy = false;
    }
  }
</script>

<section class="space-y-3" data-testid="agents-section">
  <h3 class="text-sm font-medium">{t('agents.title')}</h3>
  <p class="text-xs text-muted-foreground">{t('agents.hint')}</p>

  <label class="flex items-start gap-2 text-sm" data-testid="agents-experimental">
    <Checkbox
      checked={agentsStore.experimental}
      disabled={experimentalBusy}
      onCheckedChange={(checked) => void toggleExperimental(checked === true)}
    />
    <span class="space-y-0.5">
      <span class="block">{t('agents.experimental')}</span>
      <span class="block text-xs text-muted-foreground">{t('agents.experimentalHint')}</span>
    </span>
  </label>

  {#if agentsStore.experimental}
    {#if agentsStore.loaded && agentsStore.agents.length === 0}
      <p class="text-xs text-muted-foreground">{t('agents.empty')}</p>
    {/if}
    <div class="grid gap-1.5" data-testid="agents-default-agent">
      <Label for="agents-default-agent">{t('agents.defaultAgent')}</Label>
      <select
        id="agents-default-agent"
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        value={defaultAgentId}
        disabled={defaultBusy}
        onchange={(event) => void setDefaultAgent(event.currentTarget.value)}
        data-testid="agents-default-agent-select"
      >
        <option value="">{t('agents.defaultAgentNone')}</option>
        {#each defaultAgentOptions as agent (agent.id)}
          <option value={agent.id}>{agent.name}</option>
        {/each}
      </select>
      <p class="text-xs text-muted-foreground">{t('agents.defaultAgentHint')}</p>
    </div>
    {#each agentsStore.agents as agent (agent.id)}
      <AgentCard {agent} />
    {/each}
  {/if}
</section>
