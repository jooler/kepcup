<script lang="ts">
  import type { SkillPresetInfo } from '@kepcup/shared';
  import { errorText, t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Search } from '@lucide/svelte';
  import { skillMarket } from './market.svelte';
  import { presetIcon } from './icons';
  import { Button } from '$lib/components/ui/button';
  import { Badge } from '$lib/components/ui/badge';
  import { Input } from '$lib/components/ui/input';

  /**
   * 扩展中心 → Skills 分组（原技能市场，行为不变）：随应用分发的预置技能按场景分区展示，
   * 每行能干什么 / 要什么依赖 / 一键添加。预置只是入口——是否安装完全由用户
   * 在这里点「添加」决定；安装落入公共作用域（public_skills）：一次安装，
   * 所有 Bot 都能发现并调用。Bot 的私有技能（git 导入 / 自建）不受影响，
   * 同名时该 Bot 的私有版本遮蔽公共版本。
   *
   * 安装进行中关闭弹框 / 切换分组不中断安装（installing 在模块级单例里）。
   * 本组件随分组挂载 / 卸载：每次挂载都重新拉一次目录，但目录与搜索词在切到别的分组再切回时
   * 保留（状态在 `skillMarket` 单例里）；只有弹框关闭时才复位（`ExtensionCenterDialog`）。
   */

  $effect(() => {
    skillMarket.start();
    void skillMarket.load(true);
  });

  const filtered = $derived.by(() => {
    const needle = skillMarket.query.trim().toLowerCase();
    if (needle.length === 0) return skillMarket.presets;
    return skillMarket.presets.filter(
      (preset) =>
        preset.displayName.toLowerCase().includes(needle) ||
        preset.summary.toLowerCase().includes(needle) ||
        preset.skillName.toLowerCase().includes(needle),
    );
  });

  /** 场景分区：已知分区按固定顺序在前，未知分区（未来 catalog 扩展）追加。 */
  const SECTIONS: string[] = ['starter'];
  const sections = $derived.by(() => {
    const grouped: Array<{ id: string; presets: SkillPresetInfo[] }> = [];
    for (const preset of filtered) {
      const group = grouped.find((g) => g.id === preset.section);
      if (group === undefined) grouped.push({ id: preset.section, presets: [preset] });
      else group.presets.push(preset);
    }
    return [
      ...SECTIONS.map((id) => grouped.find((g) => g.id === id)).filter(
        (g): g is { id: string; presets: SkillPresetInfo[] } => g !== undefined,
      ),
      ...grouped.filter((g) => !SECTIONS.includes(g.id)),
    ];
  });

  function sectionTitle(id: string): string {
    const key = `skillMarket.section.${id}` as Parameters<typeof t>[0];
    const text = t(key);
    return text === key ? id : text;
  }

  async function install(preset: SkillPresetInfo): Promise<void> {
    try {
      await skillMarket.install(preset.id);
      toast.success(t('skillMarket.installedToast', { name: preset.displayName }));
    } catch (error) {
      // core 侧的 AppError 消息（如「已存在同名公共技能…」「技能库条目写入失败…」）
      // 比按错误码映射的通用文案更具体：有消息就原样展示，并把完整错误打到
      // 控制台（code / details 一起），便于排查。
      const code = (error as { code?: string } | undefined)?.code;
      const message = error instanceof Error && error.message.length > 0 ? error.message : null;
      console.error('[extension-center/skills] install failed', {
        presetId: preset.id,
        code,
        error,
      });
      toast.error(message ?? errorText(code, t('skillMarket.installFailed')));
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-4" data-testid="skill-market-panel">
  <p class="shrink-0 text-xs text-muted-foreground">{t('skillMarket.description')}</p>

  <div class="relative shrink-0">
    <Search
      class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
    />
    <Input
      bind:value={skillMarket.query}
      placeholder={t('skillMarket.searchPlaceholder')}
      class="h-9 pl-8"
      data-testid="skill-market-search"
    />
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto pr-0.5" data-testid="skill-market-list">
    {#if skillMarket.loading && skillMarket.presets.length === 0}
      <p class="py-6 text-center text-sm text-muted-foreground">…</p>
    {:else if skillMarket.loadError !== null && skillMarket.presets.length === 0}
      <p class="py-6 text-center text-sm text-destructive" data-testid="skill-market-error">
        {skillMarket.loadError}
      </p>
    {:else if sections.length === 0}
      <p class="py-6 text-center text-sm text-muted-foreground" data-testid="skill-market-empty">
        {t('skillMarket.empty')}
      </p>
    {:else}
      {#each sections as section (section.id)}
        <p class="pt-3 pb-1.5 text-sm font-medium">{sectionTitle(section.id)}</p>
        <!-- 一行两个技能卡片（窄窗口回退单列） -->
        <ul class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {#each section.presets as preset (preset.id)}
            {@const Icon = presetIcon(preset.icon)}
            <li
              class="flex items-center gap-3 rounded-lg border p-2.5"
              data-testid={`skill-market-item-${preset.id}`}
              data-market-installed={preset.installed}
            >
              <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon class="size-5 text-foreground/80" />
              </span>
              <span class="grid min-w-0 flex-1 gap-0.5">
                <span class="flex min-w-0 items-center gap-2">
                  <span class="truncate text-sm font-medium">{preset.displayName}</span>
                  {#if preset.missingDeps.length > 0}
                    <Badge
                      variant="outline"
                      class="shrink-0 text-amber-700 dark:text-amber-400"
                      data-testid={`skill-market-deps-${preset.id}`}
                    >
                      {t('skillMarket.needsEnv', { deps: preset.missingDeps.join('、') })}
                    </Badge>
                  {:else}
                    <Badge variant="secondary" class="shrink-0">
                      {t('skillMarket.localReady')}
                    </Badge>
                  {/if}
                </span>
                <span class="truncate text-xs text-muted-foreground">{preset.summary}</span>
                {#if preset.tryIt.length > 0}
                  <span class="truncate text-xs text-muted-foreground/70">
                    {t('skillMarket.tryIt', { tryIt: preset.tryIt })}
                  </span>
                {/if}
              </span>
              {#if preset.foreign}
                <Button
                  size="sm"
                  variant="ghost"
                  class="shrink-0 text-xs text-muted-foreground"
                  disabled
                  title={t('skillMarket.foreignHint')}
                  data-testid={`skill-market-foreign-${preset.id}`}
                >
                  {t('skillMarket.foreign')}
                </Button>
              {:else if preset.installed && preset.upToDate}
                <Button
                  size="sm"
                  variant="ghost"
                  class="shrink-0 text-xs text-emerald-700 dark:text-emerald-400"
                  disabled
                  data-testid={`skill-market-added-${preset.id}`}
                >
                  ✓ {t('skillMarket.added')}
                </Button>
              {:else if skillMarket.installing.has(preset.id)}
                <Button size="sm" variant="secondary" class="shrink-0 text-xs" disabled>
                  {t('skillMarket.adding')}
                </Button>
              {:else if preset.installed}
                <Button
                  size="sm"
                  variant="outline"
                  class="shrink-0 text-xs"
                  onclick={() => void install(preset)}
                  data-testid={`skill-market-update-${preset.id}`}
                >
                  {t('skillMarket.update')}
                </Button>
              {:else}
                <Button
                  size="sm"
                  variant="outline"
                  class="shrink-0 text-xs"
                  onclick={() => void install(preset)}
                  data-testid={`skill-market-add-${preset.id}`}
                >
                  {t('skillMarket.add')}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/each}
    {/if}
  </div>
</div>
