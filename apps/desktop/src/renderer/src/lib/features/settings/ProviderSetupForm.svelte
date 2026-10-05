<script lang="ts">
  import type { CustomProvider, VendorId, VendorProvider } from '@kepcup/shared';
  import { AppError, isVendorId, VENDOR_DESCRIPTORS } from '@kepcup/shared';
  import { Plus, Trash2 } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { settingsStore } from '$lib/stores/settings.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';

  /**
   * 供应商新增 / 设 Key / 编辑厂商模型 表单（docs/design/18-inline-setup.md）：
   * 从 ModelsSection 的新增弹框整体拆出，供设置弹框与对话内设置卡片共用
   * 同一份表单事实与保存逻辑（settings.update + providers.setKey）。
   * mode='add'：选厂商（国内厂商带 baseUrl/模型行 / 自定义接口 / 内置厂商）；
   * 'key'：给已存在条目补 Key；'edit'：改国内厂商的对话模型登记。
   * 保存成功后回调 onSaved(providerId)（弹框用法借此关闭弹框）。
   * 「测试连接」会先落盘（providers.test 只读已存 key）——对话内引导卡据
   * 此要求 blockSaveAfterFailedTest：任一测试（表单级/厂商行内）失败后禁用
   * 保存，直到某次测试通过（切换厂商重置表单即重置），失败绝不放行。
   */
  let {
    mode,
    target,
    testidPrefix = 'provider-add',
    blockSaveAfterFailedTest = false,
    onSaved,
  }: {
    mode: 'add' | 'key' | 'edit';
    /** 厂商 id / 自定义条目 id（'custom:xxx'）/ 'custom'（仅 add 模式）。 */
    target: string;
    /** data-testid 前缀（save/test 按钮）；key-input 保持全局固定形态。 */
    testidPrefix?: string;
    /** 测试失败后禁用保存（对话内设置卡片用；设置页保存不设限）。 */
    blockSaveAfterFailedTest?: boolean;
    onSaved?: (providerId: string) => void;
  } = $props();

  // 弹框选择的目标（add 模式下可在表单内切换）；props 变化时在下方 effect 跟随。
  let selectedTarget = $state(target);

  let addKey = $state('');
  let customDraft = $state<CustomProvider>(emptyCustom());
  let customModelsText = $state('');
  // 国内厂商分支：可覆盖的兼容根 + 对话模型行。
  let vendorBaseUrl = $state('');
  let vendorModels = $state<string[]>([]);
  let rowTesting = $state<number | null>(null);
  /** 行内测试结果：'ok' 或本地化失败原因。 */
  let rowResults = $state<Record<number, string>>({});
  let busy = $state(false);
  /** 最近一次测试（表单级/行内）失败：blockSaveAfterFailedTest 时禁存。 */
  let lastTestFailed = $state(false);

  const configuredProviders = $derived(
    settingsStore.providers.filter((provider) => provider.kind === 'custom' || provider.hasKey),
  );
  const unconfiguredProviders = $derived(
    settingsStore.providers.filter(
      (provider) =>
        (provider.kind === 'builtin' || provider.kind === 'vendor') &&
        !provider.hasKey &&
        !configuredProviders.some((configured) => configured.id === provider.id),
    ),
  );
  const configuredVendorIds = $derived(
    settingsStore.providers.filter((p) => p.kind === 'vendor' && p.hasKey).map((p) => p.id),
  );

  const isVendorTarget = $derived(mode !== 'key' && isVendorId(selectedTarget));
  const vendorDescriptor = $derived(
    isVendorTarget ? VENDOR_DESCRIPTORS[selectedTarget as VendorId] : null,
  );
  /** add 模式下选择「自定义接口」。 */
  const isCustomTarget = $derived(mode === 'add' && selectedTarget === 'custom');
  /** 测试按钮显隐：厂商 add/edit 分支没有（原弹框行为；key 模式仍可测）。 */
  const showTest = $derived(!isVendorTarget);
  const testDisabled = $derived(
    busy || (mode !== 'edit' && !isCustomTarget && addKey.length === 0),
  );

  function emptyCustom(): CustomProvider {
    return { id: '', name: '', baseUrl: '', models: [] };
  }

  /** 切换弹框目标时重置对应分支的草稿（与设置弹框原行为一致）。 */
  function resetVendorDraft(vendor: VendorId, baseUrl?: string, models?: string[]): void {
    const descriptor = VENDOR_DESCRIPTORS[vendor];
    vendorBaseUrl = baseUrl ?? descriptor.baseUrl;
    vendorModels = models ?? [];
    rowResults = {};
  }

  /** 重置表单草稿（切换目标 / props 变化时；与设置弹框原行为一致）。 */
  function resetDraftsFor(t: string): void {
    addKey = '';
    customDraft = emptyCustom();
    customModelsText = '';
    rowResults = {};
    // 换目标 = 换了一份待验证的配置，失败拦截随之解除。
    lastTestFailed = false;
    if (mode === 'edit' && isVendorId(t)) {
      const provider = settingsStore.providers.find((p) => p.id === t);
      resetVendorDraft(
        t,
        provider?.baseUrl,
        provider?.models.map((m) => m.id),
      );
    } else if (isVendorId(t)) {
      resetVendorDraft(t);
    }
  }

  // props 目标变化（弹框重开 / 卡片换目标）时同步选择并重置表单草稿。
  // 只依赖 props（target/mode），不读 selectedTarget——用户在表单内切换目标
  // 不能触发本 effect（否则会被回写为 props 值）。
  $effect(() => {
    selectedTarget = target;
    resetDraftsFor(target);
  });

  function parseModels(text: string): CustomProvider['models'] {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [id, name, context] = line.split('|').map((part) => part.trim());
        return {
          id: id ?? '',
          name: name && name.length > 0 ? name : (id ?? ''),
          contextWindow: Number(context) > 0 ? Number(context) : 128_000,
        };
      })
      .filter((model) => model.id.length > 0);
  }

  /**
   * 落盘表单当前值：国内厂商 upsert 一条 vendorProviders（只含对话模型），
   * 自定义接口追加 customProviders，内置厂商只存 key；key 填了才落钥。
   */
  async function persistAdd(): Promise<string> {
    if (mode === 'add' && selectedTarget === 'custom') {
      const models = parseModels(customModelsText);
      if (models.length === 0) throw new Error(t('settings.customModels'));
      const provider: CustomProvider = { ...customDraft, models };
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider.id) || provider.baseUrl.length === 0) {
        throw new Error(t('settings.customBaseUrl'));
      }
      const current = settingsStore.settings;
      if (!current) throw new Error(t('settings.customBaseUrl'));
      // 按 id 覆盖（与厂商分支同构）：失败后修正草稿重测会再次落盘，
      // 追加式写入会堆出同 id 重复条目。
      await settingsStore.update({
        customProviders: [...current.customProviders.filter((c) => c.id !== provider.id), provider],
      });
      if (addKey.length > 0) {
        // setKey 内部会 refresh；无 key 时这里也要刷一次让新卡片出现。
        await settingsStore.setKey(`custom:${provider.id}`, addKey);
      } else {
        await settingsStore.refresh();
      }
      return `custom:${provider.id}`;
    }
    if (isVendorTarget && vendorDescriptor !== null) {
      const models: VendorProvider['models'] = vendorModels
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
        .map((id) => ({ id }));
      if (models.length === 0) throw new Error(t('settings.vendorNoModels'));
      if (mode === 'add' && addKey.length === 0) {
        throw new Error(t('settings.providerKeyPlaceholder'));
      }
      const current = settingsStore.settings;
      if (!current) throw new Error(t('settings.vendorNoModels'));
      const override = vendorBaseUrl.trim();
      const entry: VendorProvider = {
        id: vendorDescriptor.id,
        ...(override.length > 0 && override !== vendorDescriptor.baseUrl
          ? { baseUrl: override }
          : {}),
        models,
      };
      await settingsStore.update({
        vendorProviders: [...current.vendorProviders.filter((v) => v.id !== entry.id), entry],
      });
      if (addKey.length > 0) {
        await settingsStore.setKey(entry.id, addKey);
      } else {
        await settingsStore.refresh();
      }
      return entry.id;
    }
    if (addKey.length === 0) throw new Error(t('settings.providerKeyPlaceholder'));
    await settingsStore.setKey(selectedTarget, addKey);
    return selectedTarget;
  }

  function testFailMessage(error: unknown): string {
    const code = error instanceof AppError ? error.code : 'PROVIDER_UNAVAILABLE';
    return t('settings.testFailed', {
      reason:
        code === 'PROVIDER_AUTH_FAILED'
          ? t('chats.errorCode.PROVIDER_AUTH_FAILED')
          : String((error as Error).message ?? ''),
    });
  }

  /** 行内「测试」：先落盘（providers.test 只读已存 key），再对话探测。 */
  async function testRow(index: number): Promise<void> {
    const modelId = vendorModels[index]?.trim();
    if (!modelId || vendorDescriptor === null) return;
    rowTesting = index;
    try {
      const providerId = await persistAdd();
      await settingsStore.test(providerId, modelId, 'chat');
      rowResults = { ...rowResults, [index]: 'ok' };
      lastTestFailed = false;
    } catch (error) {
      lastTestFailed = true;
      const message =
        error instanceof AppError
          ? testFailMessage(error)
          : String((error as Error).message ?? error);
      rowResults = { ...rowResults, [index]: message };
      toast.error(message);
    } finally {
      rowTesting = null;
    }
  }

  /** 「测试连接」(custom / builtin)：先落盘（providers.test 只读已存 key），再对话探测。 */
  async function testForm(): Promise<void> {
    busy = true;
    try {
      const providerId = await persistAdd();
      await settingsStore.test(providerId);
      lastTestFailed = false;
      toast.success(t('settings.testOk'));
    } catch (error) {
      lastTestFailed = true;
      const message =
        error instanceof AppError
          ? testFailMessage(error)
          : String((error as Error).message ?? error);
      toast.error(message);
    } finally {
      busy = false;
    }
  }

  async function save(): Promise<void> {
    busy = true;
    try {
      const providerId = await persistAdd();
      onSaved?.(providerId);
    } catch (error) {
      toast.error(String((error as Error).message ?? error));
    } finally {
      busy = false;
    }
  }
</script>

<div class="-mr-4 min-h-0 space-y-4 overflow-y-auto pr-4 pl-2" data-testid={`${testidPrefix}-form`}>
  {#if mode === 'add'}
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-target`}>{t('settings.chooseProvider')}</Label>
      <select
        id={`${testidPrefix}-target`}
        class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
        bind:value={selectedTarget}
        onchange={() => resetDraftsFor(selectedTarget)}
        data-testid={`${testidPrefix}-target`}
      >
        {#each Object.values(VENDOR_DESCRIPTORS) as vendor (vendor.id)}
          <option value={vendor.id}>
            {vendor.name}{configuredVendorIds.includes(vendor.id)
              ? t('settings.vendorConfiguredSuffix')
              : ''}
          </option>
        {/each}
        {#each unconfiguredProviders as provider (provider.id)}
          <option value={provider.id}>{provider.name}</option>
        {/each}
        <option value="custom">{t('settings.customProviders')}</option>
      </select>
    </div>
  {/if}

  {#if isVendorTarget && vendorDescriptor !== null}
    <!-- 国内厂商分支：baseUrl + key + 对话模型行（逐行测试） -->
    {#if mode === 'add'}
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-vendor-base-url`}>{t('settings.vendorBaseUrl')}</Label>
        <Input
          id={`${testidPrefix}-vendor-base-url`}
          placeholder={vendorDescriptor.baseUrl}
          bind:value={vendorBaseUrl}
          data-testid={`${testidPrefix}-vendor-base-url`}
        />
        <p class="text-xs text-muted-foreground">{t('settings.vendorBaseUrlHint')}</p>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-vendor-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testidPrefix}-vendor-key`}
          type="password"
          placeholder={t('settings.providerKeyPlaceholder')}
          bind:value={addKey}
          data-testid={`${testidPrefix}-vendor-key`}
        />
        <p class="text-xs text-muted-foreground">
          {t('settings.vendorKeyHint', { url: vendorDescriptor.consoleUrl })}
        </p>
      </div>
    {:else}
      <p class="text-xs text-muted-foreground" data-testid={`${testidPrefix}-vendor-edit-key-note`}>
        {t('settings.vendorEditKeyNote')}
      </p>
    {/if}
    <div class="grid gap-1.5">
      <Label>{t('settings.vendorModelsLabel')}</Label>
      <p class="text-xs text-muted-foreground">{t('settings.vendorTestNote')}</p>
      <div class="space-y-2">
        {#each vendorModels as modelId, index (index)}
          <div class="flex flex-wrap items-center gap-2">
            <Input
              class="h-9 min-w-40 flex-1"
              placeholder={vendorDescriptor.presets.chat[index] ?? 'model-id'}
              bind:value={vendorModels[index]}
              list={`${testidPrefix}-vendor-presets-chat`}
              data-testid={`${testidPrefix}-vendor-row-model-${index}`}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={rowTesting !== null || modelId.trim().length === 0}
              onclick={() => void testRow(index)}
              data-testid={`${testidPrefix}-vendor-row-test-${index}`}
            >
              {rowTesting === index ? t('settings.testing') : t('settings.test')}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              class="text-destructive hover:text-destructive"
              onclick={() => {
                vendorModels = vendorModels.filter((_, i) => i !== index);
                rowResults = {};
              }}
              title={t('settings.remove')}
              data-testid={`${testidPrefix}-vendor-row-remove-${index}`}
            >
              <Trash2 class="size-4" />
            </Button>
          </div>
          {#if rowResults[index] !== undefined}
            <p
              class="text-xs {rowResults[index] === 'ok' ? 'text-emerald-600' : 'text-destructive'}"
              data-testid={`${testidPrefix}-vendor-row-result-${index}`}
            >
              {rowResults[index] === 'ok' ? t('settings.testOk') : rowResults[index]}
            </p>
          {/if}
        {/each}
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          onclick={() => {
            vendorModels = [...vendorModels, ''];
            rowResults = {};
          }}
          data-testid={`${testidPrefix}-vendor-row-add`}
        >
          <Plus class="size-4" />
          {t('settings.vendorAddModel')}
        </Button>
      </div>
      {#if vendorDescriptor.presets.chat.length > 0}
        <datalist id={`${testidPrefix}-vendor-presets-chat`}>
          {#each vendorDescriptor.presets.chat as preset (preset)}
            <option value={preset}></option>
          {/each}
        </datalist>
      {/if}
    </div>
  {:else if mode === 'add' && selectedTarget === 'custom'}
    <div class="grid gap-4">
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-custom-id`}>{t('settings.customId')}</Label>
          <Input
            id={`${testidPrefix}-custom-id`}
            placeholder="my-provider"
            bind:value={customDraft.id}
            data-testid={`${testidPrefix}-custom-id`}
          />
        </div>
        <div class="grid gap-1.5">
          <Label for={`${testidPrefix}-custom-name`}>{t('settings.customName')}</Label>
          <Input
            id={`${testidPrefix}-custom-name`}
            placeholder={t('settings.customName')}
            bind:value={customDraft.name}
            data-testid={`${testidPrefix}-custom-name`}
          />
        </div>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-custom-base-url`}>{t('settings.customBaseUrl')}</Label>
        <Input
          id={`${testidPrefix}-custom-base-url`}
          placeholder="https://api.example.com/v1"
          bind:value={customDraft.baseUrl}
          data-testid={`${testidPrefix}-custom-base-url`}
        />
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-custom-key`}>{t('settings.providerKey')}</Label>
        <Input
          id={`${testidPrefix}-custom-key`}
          type="password"
          placeholder={t('settings.customKeyPlaceholder')}
          bind:value={addKey}
          data-testid="custom-key-input"
        />
        <p class="text-xs text-muted-foreground">{t('settings.customKeyHint')}</p>
      </div>
      <div class="grid gap-1.5">
        <Label for={`${testidPrefix}-custom-models`}>{t('settings.customModels')}</Label>
        <Textarea
          id={`${testidPrefix}-custom-models`}
          rows={3}
          bind:value={customModelsText}
          placeholder={t('settings.customModelsHint')}
          data-testid={`${testidPrefix}-custom-models`}
        />
      </div>
    </div>
  {:else if mode !== 'edit'}
    <div class="grid gap-1.5">
      <Label for={`${testidPrefix}-key`}>{t('settings.providerKey')}</Label>
      <Input
        id={`${testidPrefix}-key`}
        type="password"
        placeholder={t('settings.providerKeyPlaceholder')}
        bind:value={addKey}
        data-testid={`key-input-${selectedTarget}`}
      />
    </div>
  {/if}
</div>

<!-- 底部按钮：与原弹框 footer 相同（国内厂商 add/edit 分支不显示测试按钮） -->
<div class="flex items-center justify-end gap-2 pt-2">
  {#if blockSaveAfterFailedTest && lastTestFailed}
    <p class="mr-auto text-xs text-destructive" data-testid={`${testidPrefix}-save-blocked`}>
      {t('settings.saveBlockedAfterFailedTest')}
    </p>
  {/if}
  {#if showTest}
    <Button
      variant="outline"
      disabled={testDisabled}
      onclick={() => void testForm()}
      data-testid={`${testidPrefix}-test`}
    >
      {busy ? t('settings.testing') : t('settings.test')}
    </Button>
  {/if}
  <Button
    disabled={busy || (blockSaveAfterFailedTest && lastTestFailed)}
    onclick={() => void save()}
    data-testid={`${testidPrefix}-save`}
  >
    {t('settings.save')}
  </Button>
</div>
