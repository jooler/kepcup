<script lang="ts">
  import type { PluginInspectOutput } from '@kepcup/shared';
  import { t, errorText } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import { plugins } from './plugins.svelte';
  import {
    buildPluginUserConfig,
    canInstallPlugin,
    clearPluginSensitive,
    initialPluginForm,
    missingPluginConfig,
    type PluginForm,
  } from './plugin-install';
  import PluginConsentPanel from './PluginConsentPanel.svelte';

  /**
   * 本地安装插件对话框（D104 P0a-3，结构同 `McpbInstall.svelte`）：选路径（文件 / 文件夹）
   * → `plugins.inspect` 展示同意面板（含 MCPB 的 user_config 表单）→ 确认安装（`plugins.install`
   * 带回检视时的 sha256；包被替换则 core 拒绝）。路径输入框始终可手填（e2e 走这里，不碰
   * 原生文件对话框）。提交后立即清空敏感值；失败时对话框保持打开。
   */

  let {
    open = $bindable(false),
    mode,
  }: {
    open: boolean;
    mode: 'file' | 'folder';
  } = $props();

  let path = $state('');
  let inspecting = $state(false);
  let installing = $state(false);
  let info = $state<PluginInspectOutput | null>(null);
  let error = $state<string | null>(null);
  let form = $state<PluginForm>({});

  const missing = $derived(info === null ? [] : missingPluginConfig(info, form));
  const installable = $derived(info !== null && canInstallPlugin(info, missing));

  function codeOf(caught: unknown): string | undefined {
    return (caught as { code?: string } | undefined)?.code;
  }

  function reasonOf(caught: unknown): string {
    const message = (caught as Error | undefined)?.message;
    return errorText(codeOf(caught), message !== undefined && message !== '' ? message : String(caught));
  }

  function reset(): void {
    info = null;
    error = null;
    form = {};
  }

  function close(): void {
    open = false;
    path = '';
    reset();
  }

  async function pick(): Promise<void> {
    const picked =
      mode === 'file'
        ? await window.kepcup?.platform?.selectFile?.(['kepcup'])
        : await window.kepcup?.platform?.selectDirectory?.({ message: t('plugins.pickFolderMessage') });
    if (picked !== null && picked !== undefined) {
      path = picked;
      await inspect();
    }
  }

  async function inspect(): Promise<void> {
    const target = path.trim();
    if (target.length === 0) return;
    inspecting = true;
    reset();
    try {
      const result = (await core.call('plugins.inspect', {
        source: { kind: mode, path: target },
      })) as PluginInspectOutput;
      info = result;
      form = initialPluginForm(result);
    } catch (caught) {
      error = t('plugins.inspectFailed', { reason: reasonOf(caught) });
    } finally {
      inspecting = false;
    }
  }

  async function install(): Promise<void> {
    if (info === null || !installable) return;
    const current = info;
    const source = { kind: mode, path: path.trim() };
    installing = true;
    try {
      await core.call('plugins.install', {
        source,
        sha256: current.packageSha256,
        userConfig: buildPluginUserConfig(current, form),
      });
      toast.success(t('plugins.toast.installed', { name: current.name }));
      await plugins.afterMutation();
      close();
    } catch (caught) {
      toast.error(t('plugins.installFailed', { reason: reasonOf(caught) }));
    } finally {
      // Never keep secret text in the form after a submit, successful or not.
      form = clearPluginSensitive(current, form);
      installing = false;
    }
  }
</script>

<Dialog
  bind:open
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="plugins-install-dialog">
    <DialogHeader>
      <DialogTitle>{t('plugins.installTitle')}</DialogTitle>
      <DialogDescription>{t('plugins.installHint')}</DialogDescription>
    </DialogHeader>

    <div class="grid gap-1.5">
      <Label for="plugins-install-path-input">{t('plugins.pathLabel')}</Label>
      <div class="flex items-center gap-2">
        <Input
          id="plugins-install-path-input"
          class="h-9 flex-1"
          bind:value={path}
          placeholder={t('plugins.pathPlaceholder')}
          onkeydown={(event) => {
            if (event.key === 'Enter') void inspect();
          }}
          data-testid="plugins-install-path"
        />
        {#if mode === 'file' && window.kepcup?.platform?.selectFile !== undefined}
          <Button size="sm" variant="outline" onclick={() => void pick()} data-testid="plugins-install-pick">
            {t('plugins.pickFile')}
          </Button>
        {:else if mode === 'folder' && window.kepcup?.platform?.selectDirectory !== undefined}
          <Button size="sm" variant="outline" onclick={() => void pick()} data-testid="plugins-install-pick">
            {t('plugins.pickFolder')}
          </Button>
        {/if}
        <Button
          size="sm"
          disabled={inspecting || path.trim().length === 0}
          onclick={() => void inspect()}
          data-testid="plugins-install-inspect"
        >
          {inspecting ? t('plugins.inspecting') : t('plugins.inspect')}
        </Button>
      </div>
    </div>

    {#if error !== null}
      <p class="text-xs text-destructive" data-testid="plugins-install-error">{error}</p>
    {/if}

    {#if info !== null}
      <PluginConsentPanel bind:form {info} {missing} />
    {/if}

    <div class="flex items-center gap-2">
      {#if info !== null}
        <Button
          size="sm"
          disabled={!installable || installing}
          onclick={() => void install()}
          data-testid="plugins-install-confirm"
        >
          {installing ? t('plugins.installing') : t('plugins.confirm')}
        </Button>
      {/if}
      <Button size="sm" variant="ghost" onclick={close} data-testid="plugins-install-cancel">
        {t('plugins.cancel')}
      </Button>
    </div>
  </DialogContent>
</Dialog>
