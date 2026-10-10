<script lang="ts">
  import type { McpbInspectOutput } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { core } from '$lib/rpc/client.svelte';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { appsStore } from '$lib/stores/apps.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';
  import {
    buildUserConfig,
    canInstall,
    clearSensitive,
    formatBytes,
    initialForm,
    missingRequired,
    runtimeLabel,
    type McpbForm,
  } from './mcpb-install';

  /**
   * 「安装 .mcpb 包」（D73 P2 §6.5）：选文件 → `mcpb.inspect` 展示摘要 / 兼容性 / 完整启动命令 /
   * sha256 / 体积 → 填 user_config（敏感项用密码框，提交后立即清空）→ 确认安装（`mcpb.install`
   * 带回确认时的 sha256；文件被替换则 core 拒绝）。设置页内的这张确认面板就是审批：它展示的
   * 内容与对话内审批卡（environment 类）相同，用户点「确认并安装」才会解包与建 server。
   * 目录条目的 `packages[].registryType === 'mcpb'` 入口 P2 只认本地文件路径（URL 下载未做）。
   */

  let open = $state(false);
  let path = $state('');
  let inspecting = $state(false);
  let installing = $state(false);
  let info = $state<McpbInspectOutput | null>(null);
  let error = $state<string | null>(null);
  let form = $state<McpbForm>({});

  const fields = $derived(info?.userConfigFields ?? []);
  const missing = $derived(missingRequired(fields, form));
  const installable = $derived(
    info !== null && canInstall({ compatible: info.compatible, runtime: info.runtime, missing }),
  );

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
    const picked = await window.kepcup?.platform?.selectFile?.(['mcpb']);
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
      const result = (await core.call('mcpb.inspect', { path: target })) as McpbInspectOutput;
      info = result;
      form = initialForm(result.userConfigFields);
    } catch (caught) {
      error = t('settings.mcpbInspectFailed', {
        reason: String((caught as Error).message ?? caught),
      });
    } finally {
      inspecting = false;
    }
  }

  async function install(): Promise<void> {
    if (info === null || !installable) return;
    const current = info;
    installing = true;
    try {
      await core.call('mcpb.install', {
        path: path.trim(),
        sha256: current.sha256,
        userConfig: buildUserConfig(current.userConfigFields, form),
      });
      toast.success(t('settings.mcpbInstalled', { name: current.displayName }));
      await settingsStore.refresh();
      void appsStore.refresh().catch(() => undefined);
      close();
    } catch (caught) {
      toast.error(
        t('settings.mcpbInstallFailed', { reason: String((caught as Error).message ?? caught) }),
      );
    } finally {
      // Never keep secret text in the form after a submit, successful or not.
      form = clearSensitive(current.userConfigFields, form);
      installing = false;
    }
  }
</script>

<Button size="sm" variant="secondary" onclick={() => (open = true)} data-testid="mcpb-open">
  {t('settings.mcpbInstall')}
</Button>

<Dialog
  bind:open
  onOpenChange={(next) => {
    if (!next) close();
  }}
>
  <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl" data-testid="mcpb-panel">
    <DialogHeader>
      <DialogTitle>{t('settings.mcpbTitle')}</DialogTitle>
      <DialogDescription>{t('settings.mcpbHint')}</DialogDescription>
    </DialogHeader>

    <div class="grid gap-1.5">
      <Label for="mcpb-path">{t('settings.mcpbPathLabel')}</Label>
      <div class="flex items-center gap-2">
        <Input
          id="mcpb-path"
          class="h-9 flex-1"
          bind:value={path}
          placeholder={t('settings.mcpbPathPlaceholder')}
          onkeydown={(event) => {
            if (event.key === 'Enter') void inspect();
          }}
          data-testid="mcpb-path"
        />
        {#if window.kepcup?.platform?.selectFile !== undefined}
          <Button size="sm" variant="outline" onclick={() => void pick()} data-testid="mcpb-pick">
            {t('settings.mcpbPick')}
          </Button>
        {/if}
        <Button
          size="sm"
          disabled={inspecting || path.trim().length === 0}
          onclick={() => void inspect()}
          data-testid="mcpb-inspect"
        >
          {inspecting ? t('settings.mcpbInspecting') : t('settings.mcpbInspect')}
        </Button>
      </div>
    </div>

    {#if error !== null}
      <p class="text-xs text-destructive" data-testid="mcpb-error">{error}</p>
    {/if}

    {#if info !== null}
      <div class="space-y-3" data-testid="mcpb-summary">
        <div class="flex flex-wrap items-center gap-2">
          <Badge>{info.displayName}</Badge>
          <Badge variant="outline">{info.serverType}</Badge>
          <span class="text-xs text-muted-foreground">
            {t('settings.mcpbVersion')}
            {info.version}
            {#if info.author.length > 0}· {t('settings.mcpbAuthor')} {info.author}{/if}
          </span>
        </div>
        {#if info.description.length > 0}
          <p class="text-xs text-muted-foreground">{info.description}</p>
        {/if}
        <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <span class="text-muted-foreground">{t('settings.mcpbSize')}</span>
          <span data-testid="mcpb-size">
            {t('settings.mcpbSizeValue', {
              size: formatBytes(info.size),
              unpacked: formatBytes(info.unpackedSize),
            })}
          </span>
          <span class="text-muted-foreground">{t('settings.mcpbSha')}</span>
          <code class="break-all" data-testid="mcpb-sha">{info.sha256}</code>
          <span class="text-muted-foreground">{t('settings.mcpbInstallDir')}</span>
          <code class="break-all">{info.installDir}</code>
        </div>
        <div class="space-y-1">
          <Label>{t('settings.mcpbLaunch')}</Label>
          <code
            class="block rounded bg-muted px-2 py-1.5 text-xs break-all whitespace-pre-wrap"
            data-testid="mcpb-launch">{info.launchCommand}</code
          >
          <p class="text-xs text-muted-foreground">{t('settings.mcpbLaunchHint')}</p>
        </div>

        {#if !info.compatible}
          <p class="text-xs text-destructive" data-testid="mcpb-incompatible">
            {t('settings.mcpbIncompatible', { reason: info.incompatibleReason ?? '' })}
          </p>
        {/if}
        {#if info.runtime !== null && !info.runtime.available}
          <p class="text-xs text-amber-600 dark:text-amber-400" data-testid="mcpb-runtime-missing">
            {t('settings.mcpbRuntimeMissing', { runtime: runtimeLabel(info.runtime.kind) })}
          </p>
        {/if}
        <p class="text-xs text-amber-600 dark:text-amber-400">{t('settings.mcpbUntrusted')}</p>

        {#if fields.length > 0}
          <div class="space-y-2" data-testid="mcpb-config">
            <Label>{t('settings.mcpbConfigTitle')}</Label>
            {#each fields as field (field.key)}
              <div class="grid gap-1">
                <Label for={`mcpb-field-${field.key}`} class="text-xs">
                  {field.title}
                  {#if field.required}<span class="text-destructive"
                      >· {t('settings.mcpbConfigRequired')}</span
                    >{/if}
                  {#if field.sensitive}<span class="text-muted-foreground"
                      >· {t('settings.mcpbConfigSensitive')}</span
                    >{/if}
                </Label>
                {#if field.type === 'boolean'}
                  <Checkbox
                    id={`mcpb-field-${field.key}`}
                    checked={form[field.key] === true}
                    onCheckedChange={(checked) => (form[field.key] = checked === true)}
                  />
                {:else if field.multiple}
                  <textarea
                    id={`mcpb-field-${field.key}`}
                    class="min-h-16 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder={t('settings.mcpbConfigMultiple')}
                    bind:value={form[field.key] as string}></textarea>
                {:else}
                  <Input
                    id={`mcpb-field-${field.key}`}
                    class="h-8"
                    type={field.sensitive
                      ? 'password'
                      : field.type === 'number'
                        ? 'number'
                        : 'text'}
                    autocomplete="off"
                    bind:value={form[field.key] as string}
                    data-testid={`mcpb-field-${field.key}`}
                  />
                {/if}
                {#if field.description.length > 0}
                  <p class="text-xs text-muted-foreground">{field.description}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        {#if missing.length > 0}
          <p class="text-xs text-muted-foreground" data-testid="mcpb-missing">
            {t('settings.mcpbRequiredMissing', { names: missing.join('、') })}
          </p>
        {/if}
      </div>
    {/if}

    <div class="flex items-center gap-2">
      {#if info !== null}
        <Button
          size="sm"
          disabled={!installable || installing}
          onclick={() => void install()}
          data-testid="mcpb-confirm"
        >
          {installing ? t('settings.mcpbInstalling') : t('settings.mcpbConfirm')}
        </Button>
      {/if}
      <Button size="sm" variant="ghost" onclick={close} data-testid="mcpb-cancel">
        {t('settings.mcpbCancel')}
      </Button>
    </div>
  </DialogContent>
</Dialog>
