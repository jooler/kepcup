<script lang="ts">
  /** W5：MCP 工具风险徽标（只读 / 写入 / 破坏性；破坏性用警示色）。 */
  import type { McpToolRisk } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { Badge } from '$lib/components/ui/badge';
  import { MCP_RISK_LABEL_KEYS } from './mcp-risk';

  let { risk, testid }: { risk: McpToolRisk; testid?: string } = $props();
</script>

{#if risk === 'destructive'}
  <Badge variant="destructive" class="text-[10px]" data-testid={testid} data-risk={risk}
    >{t(MCP_RISK_LABEL_KEYS[risk])}</Badge
  >
{:else if risk === 'write'}
  <Badge
    variant="outline"
    class="border-amber-500/60 text-[10px] text-amber-700 dark:text-amber-400"
    data-testid={testid}
    data-risk={risk}>{t(MCP_RISK_LABEL_KEYS[risk])}</Badge
  >
{:else}
  <Badge variant="outline" class="text-[10px] text-muted-foreground" data-testid={testid} data-risk={risk}
    >{t(MCP_RISK_LABEL_KEYS[risk])}</Badge
  >
{/if}
