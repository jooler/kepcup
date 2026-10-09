<script lang="ts">
  /**
   * W5：MCP server 的逐工具策略——工具名、风险徽标、判定来源（注解 / 按名字
   * 推断 / 未声明）、审批（默认 / 免审批 / 每次确认）与启用开关。按工具名存
   * 在 server.toolPolicies，刷新工具列表后保留；服务器已不再列出的工具标灰。
   */
  import type { McpServer, McpToolRisksOutput } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import McpRiskBadge from '../approvals/McpRiskBadge.svelte';
  import {
    MCP_RISK_SOURCE_KEYS,
    effectiveApproval,
    withToolPolicy,
    type McpApprovalChoice,
  } from '../approvals/mcp-risk';

  let { server }: { server: McpServer } = $props();

  let loading = $state(true);
  let report = $state<McpToolRisksOutput | null>(null);
  let loadError = $state<string | null>(null);
  let saving = $state(false);

  // Reload only when the server changes, not on every policy edit.
  const serverId = $derived(server.id);

  $effect(() => {
    const id = serverId;
    loading = true;
    loadError = null;
    void settingsStore
      .mcpToolRisks(id)
      .then((result) => {
        report = result;
        loadError = result.error ?? null;
      })
      .catch((error: unknown) => {
        loadError = String((error as Error).message ?? error);
      })
      .finally(() => {
        loading = false;
      });
  });

  function approvalChoice(toolName: string): McpApprovalChoice {
    return server.toolPolicies?.[toolName]?.approval ?? 'default';
  }

  function defaultLabel(toolName: string, risk: 'read' | 'write' | 'destructive'): string {
    const mode = effectiveApproval({ autoApprove: server.autoApprove }, toolName, risk);
    return t('settings.mcpToolApprovalDefault', {
      mode: mode === 'auto' ? t('settings.mcpToolApprovalAuto') : t('settings.mcpToolApprovalAsk'),
    });
  }

  async function patchPolicy(
    toolName: string,
    patch: { approval?: McpApprovalChoice; enabled?: boolean },
  ): Promise<void> {
    saving = true;
    try {
      const existing = settingsStore.settings?.mcpServers ?? [];
      const next = existing.map((entry) => {
        if (entry.id !== server.id) return entry;
        const toolPolicies = withToolPolicy(entry.toolPolicies, toolName, patch);
        const { toolPolicies: _old, ...rest } = entry;
        void _old;
        return toolPolicies !== undefined ? { ...rest, toolPolicies } : rest;
      });
      await settingsStore.update({ mcpServers: next });
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      saving = false;
    }
  }
</script>

<div class="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2" data-testid={`mcp-tool-policies-${server.id}`}>
  <p class="text-xs text-muted-foreground">{t('settings.mcpToolsHint')}</p>
  {#if loading}
    <p class="text-xs text-muted-foreground">{t('settings.mcpToolsLoading')}</p>
  {/if}
  {#if loadError !== null}
    <p class="text-xs text-destructive">{loadError}</p>
  {/if}
  {#if !loading && report !== null}
    {#if report.tools.length === 0}
      <p class="text-xs text-muted-foreground">{t('settings.mcpToolsEmpty')}</p>
    {/if}
    {#each report.tools as tool (tool.name)}
      {@const enabled = server.toolPolicies?.[tool.name]?.enabled !== false}
      <div
        class={`flex flex-wrap items-center gap-2 text-xs ${tool.missing ? 'opacity-50' : ''}`}
        data-testid={`mcp-tool-${server.id}-${tool.name}`}
      >
        <code class="rounded bg-muted px-1.5 py-0.5" title={tool.description}>{tool.name}</code>
        <McpRiskBadge risk={tool.risk} testid={`mcp-tool-risk-${tool.name}`} />
        <span class="text-muted-foreground">{t(MCP_RISK_SOURCE_KEYS[tool.source])}</span>
        {#if tool.missing}
          <span class="text-muted-foreground">{t('settings.mcpToolMissing')}</span>
        {/if}
        <div class="ml-auto flex items-center gap-3">
          <label class="flex items-center gap-1">
            <span class="text-muted-foreground">{t('settings.mcpToolApproval')}</span>
            <select
              class="h-7 rounded-md border border-input bg-background px-2 text-xs"
              value={approvalChoice(tool.name)}
              disabled={saving}
              onchange={(event) =>
                void patchPolicy(tool.name, {
                  approval: event.currentTarget.value as McpApprovalChoice,
                })}
              data-testid={`mcp-tool-approval-${tool.name}`}
            >
              <option value="default">{defaultLabel(tool.name, tool.risk)}</option>
              <option value="auto">{t('settings.mcpToolApprovalAuto')}</option>
              <option value="ask">{t('settings.mcpToolApprovalAsk')}</option>
            </select>
          </label>
          <label class="flex items-center gap-1">
            <Checkbox
              checked={enabled}
              disabled={saving}
              onCheckedChange={(checked) => void patchPolicy(tool.name, { enabled: checked === true })}
              data-testid={`mcp-tool-enabled-${tool.name}`}
            />
            {t('settings.mcpToolEnabled')}
          </label>
        </div>
      </div>
    {/each}
  {/if}
</div>
