<script lang="ts">
  import type { AgentTestResult, SetupRequirement } from '@kepcup/shared';
  import { untrack } from 'svelte';
  import { toast } from 'svelte-sonner';
  import { t, type MessageKey } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { agentsStore } from '$lib/stores/agents.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import AgentCard from '$lib/features/settings/AgentCard.svelte';
  import { stepAutoContinue } from './setup-continue';

  /**
   * 对话内 Agent 设置卡（D58 + D72 P4，design 28 §9.1）：外部 Agent 未开实验 /
   * 未启用 / 未安装 / 未登录 / 不兼容 / 暂不可用时出现。内嵌设置页同一张
   * `AgentCard`（启用 = 安装确认 → 登录 / API key → 测试连接，保存 RPC 只有
   * 一份）；Agent 从不可用变为可用（安装完成、登录成功）或测试连接通过即
   * 自动续跑（重试原 run / 冲掉保留的草稿），也可手动「继续」。
   */
  let { requirement }: { requirement: Extract<SetupRequirement, { kind: 'agent' }> } = $props();

  let enabling = $state(false);
  let continued = false;

  $effect(() => {
    agentsStore.start();
    if (!agentsStore.loaded) void agentsStore.refresh().catch(() => undefined);
  });

  const experimental = $derived(
    agentsStore.loaded
      ? agentsStore.experimental
      : (settingsStore.settings?.experimental.externalAgents ?? false),
  );
  const agent = $derived(agentsStore.get(requirement.agentId));
  const usable = $derived(
    experimental &&
      agent !== null &&
      agent.enabled &&
      agent.login?.running !== true &&
      // 安装 / 登录后的重探进行中：此时的 ready 只是登录态未知（审查 #2）。
      agent.probing !== true &&
      (agent.status === 'ready' || agent.status === 'update_available'),
  );
  /**
   * 自动续跑只认「之后观察到的」不可用 → 可用转变（审查 #1）：基线取 Agent
   * 状态首次加载出来的那一刻（未加载时不建立——重启后打开对话、store 加载
   * 完成不应把旧消息自动重试）；实验开关关着时基线即「不可用」。已可用的
   * 基线（如登录态未知、桥未启动）等用户测试连接或手动继续。
   */
  let baseline: boolean | null = null;

  // 新的 requirement（续跑后又一次失败，原因可能不同）：重新建立基线。
  $effect(() => {
    void requirement;
    untrack(() => {
      continued = false;
      baseline = agentsStore.loaded && (agent !== null || !experimental) ? usable : null;
    });
  });

  $effect(() => {
    const next = stepAutoContinue(baseline, {
      known: agentsStore.loaded && (agent !== null || !experimental),
      usable,
    });
    baseline = next.baseline;
    if (next.proceed) void proceed();
  });

  async function proceed(): Promise<void> {
    if (continued) return;
    continued = true;
    await chat.continueAfterSetup();
  }

  const showSandboxInstall = $derived(core.platform?.platform === 'linux');

  async function enableExperimental(): Promise<void> {
    enabling = true;
    try {
      await agentsStore.setExperimental(true);
    } catch (error) {
      toast.error(
        t('agents.actionFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      enabling = false;
    }
  }

  /**
   * 测试连接通过即续跑——桥未启动 / 沙箱不可用除外：测试会话不注入宿主工具、
   * 也不跑命令，测不出这两处的真实失败点，只提供手动「继续」（审查 #6）。
   */
  const testProves = $derived(
    requirement.reason !== 'unavailable' && requirement.reason !== 'sandbox_unavailable',
  );

  function tested(result: AgentTestResult): void {
    if (result.ok && testProves) void proceed();
  }
</script>

<div class="space-y-0.5 pr-6">
  <p class="text-sm font-medium" data-testid="setup-card-title">
    {t('setupCard.agentTitle', { name: agent?.name ?? requirement.agentId })}
  </p>
  <p class="text-xs text-muted-foreground" data-testid="setup-card-agent-reason">
    {t(`setupCard.agentReason.${requirement.reason}` as MessageKey)}
  </p>
</div>

{#if !experimental}
  <div class="flex flex-wrap items-center gap-2">
    <p class="flex-1 text-xs text-muted-foreground">{t('agents.experimentalHint')}</p>
    <Button
      size="sm"
      disabled={enabling}
      onclick={() => void enableExperimental()}
      data-testid="setup-card-agent-experimental"
    >
      {t('setupCard.agentEnableExperimental')}
    </Button>
  </div>
{:else if agent === null}
  <p class="text-xs text-muted-foreground">
    {agentsStore.loaded ? t('setupCard.agentMissing') : t('setupCard.agentLoading')}
  </p>
{:else}
  {#if requirement.reason === 'sandbox_unavailable'}
    <div
      class="space-y-1 rounded-lg bg-muted/40 px-3 py-2 text-xs"
      data-testid="setup-card-agent-sandbox"
    >
      {#if showSandboxInstall}
        <p>{t('setupCard.agentSandboxInstall')}</p>
      {/if}
      <p class="text-muted-foreground">{t('setupCard.agentSandboxAsk')}</p>
    </div>
  {/if}
  <AgentCard {agent} embedded onTested={tested} />
  <div class="flex justify-end">
    <Button
      size="sm"
      disabled={!usable}
      onclick={() => void proceed()}
      data-testid="setup-card-agent-continue"
    >
      {t('setupCard.confirm')}
    </Button>
  </div>
{/if}
