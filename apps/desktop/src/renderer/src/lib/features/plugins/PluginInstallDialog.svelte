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
    marketplace,
  }: {
    open: boolean;
    /** `marketplace`：不选路径，打开即按 id 检视；已装同 id 时确认走 `plugins.update`。 */
    mode: 'file' | 'folder' | 'marketplace';
    marketplace?: { id: string; version?: string } | undefined;
  } = $props();

  let path = $state('');
  let inspecting = $state(false);
  let installing = $state(false);
  let info = $state<PluginInspectOutput | null>(null);
  let error = $state<string | null>(null);
  let form = $state<PluginForm>({});
  /** P1-2：权限扩大差异的确认勾选（勾选后才允许确认，随 plugins.install 带回）。 */
  let ackDiff = $state(false);

  const source = $derived(
    mode === 'marketplace'
      ? {
          kind: 'marketplace' as const,
          id: marketplace?.id ?? '',
          ...(marketplace?.version !== undefined ? { version: marketplace.version } : {}),
        }
      : { kind: mode, path: path.trim() },
  );
  const missing = $derived(info === null ? [] : missingPluginConfig(info, form));
  const installable = $derived(info !== null && canInstallPlugin(info, missing, ackDiff));

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

  function reset(): void {
    info = null;
    error = null;
    form = {};
    ackDiff = false;
  }

  function close(): void {
    open = false;
    path = '';
    reset();
  }

  // 市场模式：对话框打开即检视一次（没有路径可填，也没有选择按钮）。失败不自动重试。
  let autoInspected = $state(false);
  $effect(() => {
    if (!open) {
      autoInspected = false;
      return;
    }
    if (mode !== 'marketplace' || autoInspected) return;
    autoInspected = true;
    void inspect();
  });

  async function pick(): Promise<void> {
    const picked =
      mode === 'file'
        ? await window.kepcup?.platform?.selectFile?.(['kepcup'])
        : await window.kepcup?.platform?.selectDirectory?.({
            message: t('plugins.pickFolderMessage'),
          });
    if (picked !== null && picked !== undefined) {
      path = picked;
      await inspect();
    }
  }

  async function inspect(): Promise<void> {
    if (mode !== 'marketplace' && path.trim().length === 0) return;
    inspecting = true;
    reset();
    try {
      const result = (await core.call('plugins.inspect', { source })) as PluginInspectOutput;
      info = result;
      form = initialPluginForm(result);
    } catch (caught) {
      error = t('plugins.inspectFailed', { reason: reasonOf(caught) });
    } finally {
      inspecting = false;
    }
  }

  /** 已装同 id 且检视判定为「更新」时走 `plugins.update`（市场来源），否则 `plugins.install`。 */
  const updating = $derived(info?.existing !== null && info?.update !== null);

  async function install(): Promise<void> {
    if (info === null || !installable) return;
    const current = info;
    const payload = {
      sha256: current.packageSha256,
      userConfig: buildPluginUserConfig(current, form),
      acknowledgeDiff: ackDiff,
    };
    installing = true;
    try {
      if (updating && mode === 'marketplace') {
        await core.call('plugins.update', { id: current.id, ...payload });
        toast.success(t('plugins.update.done', { name: current.name, version: current.version }));
      } else {
        await core.call('plugins.install', { source, ...payload });
        toast.success(t('plugins.toast.installed', { name: current.name }));
      }
      await plugins.afterMutation();
      close();
    } catch (caught) {
      toast.error(
        updating
          ? t('plugins.update.failed', { reason: reasonOf(caught) })
          : t('plugins.installFailed', { reason: reasonOf(caught) }),
      );
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
  <DialogContent
    class="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
    data-testid="plugins-install-dialog"
  >
    <DialogHeader>
      <DialogTitle>
        {updating ? t('plugins.update.title') : t('plugins.installTitle')}
      </DialogTitle>
      <DialogDescription>{t('plugins.installHint')}</DialogDescription>
    </DialogHeader>

    {#if mode !== 'marketplace'}
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
            <Button
              size="sm"
              variant="outline"
              onclick={() => void pick()}
              data-testid="plugins-install-pick"
            >
              {t('plugins.pickFile')}
            </Button>
          {:else if mode === 'folder' && window.kepcup?.platform?.selectDirectory !== undefined}
            <Button
              size="sm"
              variant="outline"
              onclick={() => void pick()}
              data-testid="plugins-install-pick"
            >
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
    {/if}

    {#if error !== null}
      <p class="text-xs text-destructive" data-testid="plugins-install-error">{error}</p>
    {/if}

    {#if info !== null}
      <PluginConsentPanel bind:form bind:ackDiff {info} {missing} />
    {/if}

    <div class="flex items-center gap-2">
      {#if info !== null}
        <Button
          size="sm"
          disabled={!installable || installing}
          onclick={() => void install()}
          data-testid="plugins-install-confirm"
        >
          {installing
            ? t('plugins.installing')
            : updating
              ? t('plugins.update.button')
              : t('plugins.confirm')}
        </Button>
      {/if}
      <Button size="sm" variant="ghost" onclick={close} data-testid="plugins-install-cancel">
        {t('plugins.cancel')}
      </Button>
    </div>
  </DialogContent>
</Dialog>
