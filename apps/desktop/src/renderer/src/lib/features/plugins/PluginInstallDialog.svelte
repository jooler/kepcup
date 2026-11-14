<script lang="ts">
  import type { PluginInspectOutput } from '@kepcup/shared';
  import { pluginsPackageProgressPayloadSchema } from '@kepcup/shared';
  import { Loader2 } from '@lucide/svelte';
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
  import { formatBytes } from '../settings/mcpb-install';
  import PluginConsentPanel from './PluginConsentPanel.svelte';
  import PluginInstallHintDialog from './PluginInstallHintDialog.svelte';

  /**
   * 本地安装插件对话框（D104 P0a-3，结构同 `McpbInstall.svelte`）：选路径（文件 / 文件夹）
   * → `plugins.inspect` 展示同意面板（含 MCPB 的 user_config 表单）→ 确认安装（`plugins.install`
   * 带回检视时的 sha256；包被替换则 core 拒绝）。路径输入框始终可手填（e2e 走这里，不碰
   * 原生文件对话框）。提交后立即清空敏感值；失败时对话框保持打开。
   * D105 P4：安装（非更新）成功后弹接入引导 `PluginInstallHintDialog`——市场与本地两条
   * 安装路径都经这里，Bot 发起的对话内确认卡不经过这里所以不弹。
   */

  const INSTALL_HINT_DISMISSED_KEY = 'kepcup.plugins.installHint.dismissed';

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
  /** P4：安装成功后的接入引导弹框（更新不弹）。 */
  let hintOpen = $state(false);
  let hintPlugin = $state<{ id: string; name: string } | null>(null);

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

  /**
   * 市场包下载进度（`plugins.package.progress`）：received / total 来自 core 节流推送，
   * 速度在渲染端按相邻事件差值算即时速率再 EMA 平滑。只在市场模式跟踪当前目标，
   * 关闭 / 重新检视时清零。
   */
  let progress = $state<{ received: number; total: number; bps: number } | null>(null);
  let lastSample: { received: number; at: number } | null = null;
  let speed = 0;

  function handlePackageProgress(raw: unknown): void {
    // onEvent 边界是 unknown：先按契约解析，坏载荷直接丢弃（事件是尽力而为的进度流）。
    const parsed = pluginsPackageProgressPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    const payload = parsed.data;
    if (mode !== 'marketplace') return;
    const targetId = marketplace?.id ?? info?.id;
    if (targetId !== undefined && payload.id !== targetId) return;
    const now = performance.now();
    if (lastSample !== null && payload.received > lastSample.received) {
      const dt = (now - lastSample.at) / 1000;
      if (dt > 0) {
        const instant = (payload.received - lastSample.received) / dt;
        speed = speed === 0 ? instant : speed * 0.6 + instant * 0.4;
      }
    }
    lastSample = { received: payload.received, at: now };
    progress = { received: payload.received, total: payload.total, bps: speed };
  }

  // 订阅只随 open 建撤；handler 在事件到达时才读 mode / marketplace / info。
  $effect(() => {
    if (!open) return;
    return core.onEvent('plugins.package.progress', handlePackageProgress);
  });

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
    progress = null;
    lastSample = null;
    speed = 0;
  }

  /**
   * 检视请求序号：市场检视要拉索引 / 验签，可能耗时数秒；关掉对话框再打开另一个插件、
   * 或改路径连按回车时，晚返回的旧请求不得覆盖新目标，也不得提前把 loading 置回去。
   */
  let inspectSeq = 0;

  function close(): void {
    open = false;
    path = '';
    inspectSeq += 1;
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
    const seq = ++inspectSeq;
    inspecting = true;
    reset();
    try {
      const result = (await core.call('plugins.inspect', { source })) as PluginInspectOutput;
      if (seq !== inspectSeq) return;
      info = result;
      form = initialPluginForm(result);
    } catch (caught) {
      if (seq !== inspectSeq) return;
      error = t('plugins.inspectFailed', { reason: reasonOf(caught) });
    } finally {
      if (seq === inspectSeq) inspecting = false;
    }
  }

  /** 已装同 id 且检视判定为「更新」时走 `plugins.update`（市场来源），否则 `plugins.install`。 */
  const updating = $derived(info !== null && info.existing !== null && info.update !== null);

  /** 安装成功后的接入引导：本设备勾过「不再提醒」就不弹（键不在设置目录，先例 acpNoticeAck）。 */
  function maybeShowInstallHint(installed: { id: string; name: string }): void {
    try {
      if (localStorage.getItem(INSTALL_HINT_DISMISSED_KEY) === '1') return;
    } catch {
      // localStorage 不可用：按未勾处理，引导照常弹。
    }
    hintPlugin = installed;
    hintOpen = true;
  }

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
        maybeShowInstallHint({ id: current.id, name: current.name });
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

    <!-- 检视（市场模式要拉索引/验签/下载，可能数秒）与安装期间给出行内等待提示，避免
        弹窗只剩标题和取消，被误以为失败。检视提示只在面板/错误都还没有时展示；
        有下载进度（市场包缓存未命中）时升级为进度条 + 速度。 -->
    {#if (inspecting && info === null && error === null) || installing}
      {#if progress !== null}
        {@const percent = Math.min(100, Math.floor((progress.received / progress.total) * 100))}
        <div class="grid gap-1.5" data-testid="plugins-install-status">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="size-4 animate-spin" aria-hidden="true" />
            <span>
              {t('plugins.downloadProgress', {
                received: formatBytes(progress.received),
                total: formatBytes(progress.total),
                percent,
                speed: formatBytes(Math.round(progress.bps)),
              })}
            </span>
          </div>
          <div class="h-1 overflow-hidden rounded-full bg-muted">
            <div
              class="h-full bg-primary transition-[width] duration-150"
              style={`width: ${percent}%`}
            ></div>
          </div>
        </div>
      {:else}
        <div
          class="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="plugins-install-status"
        >
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
          <span>
            {installing
              ? t('plugins.installing')
              : mode === 'marketplace'
                ? t('plugins.inspectingMarketplace')
                : t('plugins.inspectingLocal')}
          </span>
        </div>
      {/if}
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

<PluginInstallHintDialog bind:open={hintOpen} plugin={hintPlugin} />
