<script lang="ts">
  import type { PluginInspectOutput, SetupRequirement } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { getChatSession } from './chat-session-context';
  import { plugins } from '$lib/features/plugins/plugins.svelte';
  import {
    buildPluginUserConfig,
    clearPluginSensitive,
    initialPluginForm,
    missingPluginConfig,
    type PluginForm,
  } from '$lib/features/plugins/plugin-install';
  import PluginConsentPanel from '$lib/features/plugins/PluginConsentPanel.svelte';
  import { Button } from '$lib/components/ui/button';

  /**
   * 对话内「Bot 建议安装插件」确认卡（D104 P1-3，设计 51 §6.3）：Bot 调
   * `plugin_request_install` 且 core 校验通过后，run 以 `setup.kind === 'confirm-plugin-install'`
   * 失败。卡片挂载即按 `source: { kind: 'marketplace', id, version }` 检视一次，展示与本地安装
   * 同一个同意面板（含 MCPB 的 user_config 表单）；确认后才 `plugins.install`，随后续跑本 run。
   * `reason` 是清洗后的纯文本，永不当 HTML / Markdown 渲染。
   */
  let {
    requirement,
  }: { requirement: Extract<SetupRequirement, { kind: 'confirm-plugin-install' }> } = $props();

  const session = getChatSession();

  let info = $state<PluginInspectOutput | null>(null);
  let form = $state<PluginForm>({});
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let dismissed = $state(false);

  const missing = $derived(info === null ? [] : missingPluginConfig(info, form));
  const blocked = $derived(info !== null && !info.installable);

  function codeOf(caught: unknown): string | undefined {
    return (caught as { code?: string } | undefined)?.code;
  }

  function reasonOf(caught: unknown): string {
    const message = (caught as Error | undefined)?.message;
    return errorText(
      codeOf(caught),
      message !== undefined && message !== '' ? message : String(caught),
    );
  }

  $effect(() => {
    void requirement;
    info = null;
    error = '';
    dismissed = false;
    loading = true;
    const target = requirement;
    void (async () => {
      try {
        const result = (await core.call('plugins.inspect', {
          source: { kind: 'marketplace', id: target.pluginId, version: target.version },
        })) as PluginInspectOutput;
        info = result;
        form = initialPluginForm(result);
      } catch (caught) {
        error = t('plugins.inspectFailed', { reason: reasonOf(caught) });
      } finally {
        loading = false;
      }
    })();
  });

  async function confirm(): Promise<void> {
    const current = info;
    if (current === null || busy) return;
    busy = true;
    try {
      await core.call('plugins.install', {
        source: { kind: 'marketplace', id: current.id, version: current.version },
        sha256: current.packageSha256,
        userConfig: buildPluginUserConfig(current, form),
        acknowledgeDiff: false,
      });
      await plugins.afterMutation();
      await session.continueAfterSetup();
    } catch (caught) {
      error = t('plugins.installFailed', { reason: reasonOf(caught) });
    } finally {
      form = clearPluginSensitive(current, form);
      busy = false;
    }
  }

  function dismiss(): void {
    dismissed = true;
    session.dismissSetupCard();
  }
</script>

{#if !dismissed}
  <div class="space-y-2" data-testid="plugins-bot-card">
    <p class="text-sm font-medium">{t('plugins.bot.title')}</p>
    <p class="text-xs text-muted-foreground" data-testid="plugins-bot-reason">
      {t('plugins.bot.reason', { reason: requirement.reason })}
    </p>
    <p class="text-xs text-muted-foreground">{t('plugins.bot.notice')}</p>

    {#if loading}
      <p class="text-xs text-muted-foreground">{t('plugins.inspecting')}</p>
    {:else if error !== ''}
      <p class="text-xs text-destructive" data-testid="plugins-bot-error">{error}</p>
    {:else if info !== null}
      <PluginConsentPanel bind:form {info} {missing} testid="plugins-bot-consent" />
    {/if}

    <div class="flex items-center gap-2">
      {#if info !== null && !blocked}
        <Button
          size="sm"
          disabled={busy || missing.length > 0}
          onclick={() => void confirm()}
          data-testid="plugins-bot-confirm"
        >
          {busy ? t('plugins.installing') : t('plugins.bot.confirm')}
        </Button>
      {/if}
      <Button size="sm" variant="ghost" onclick={dismiss} data-testid="plugins-bot-dismiss">
        {t('plugins.bot.dismiss')}
      </Button>
    </div>
  </div>
{/if}
