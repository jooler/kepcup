<script lang="ts">
  import { t } from '$lib/i18n';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import { connections, serverHashOf, teamSourceId, type SourceId } from '$lib/rpc/connections.svelte';
  import { teamSettings } from './team-settings.svelte';
  import { awayState } from './away-state.svelte';
  import { profilePush } from './profile-push.svelte';
  import { teamContext } from './team-context.svelte';
  import { teamCacheSync } from './cache-sync.svelte';
  import { getDesktopTeamCacheExtras } from './team-cache-store';
  import { contacts } from '$lib/stores/contacts.svelte';
  import { ENDPOINT_KIND } from '$lib/features/web-shell/endpoint';

  /**
   * 「团队」设置分区（T7 步骤 5，渲染层共用）：离开态（设置离开 / 回来 +
   * 备注；分身开关 T10 前置灰）、成员域免打扰（team.settings 的 quietHours
   * 表单）、个人用量（team.usage.mine 的 byDay 表）、画像上行手动入口
   *（仅桌面——web 无本机画像）。
   *
   * 来源：桌面融合视图逐服务器（每个已融合来源一张卡）；web 团队端点
   *（T5）一张卡，来源是同源 core。
   */

  interface SectionSource {
    key: string;
    source: SourceId;
    title: string;
    connected: boolean;
  }

  const sources = $derived.by(() => {
    const list: SectionSource[] = [];
    // web 团队端点：teamContext 激活（同源 core）。
    if (teamContext.active) {
      list.push({
        key: 'local',
        source: 'local',
        title: teamContext.serverName || t('settings.navTeam'),
        connected: true,
      });
    }
    // 桌面融合视图：各已融合服务器。
    for (const server of connections.servers) {
      const hash = server.serverHash;
      const status = connections.get(teamSourceId(hash)).status;
      const slice = contacts.teamSources[hash];
      list.push({
        key: hash,
        source: teamSourceId(hash),
        title: slice?.serverName || server.url,
        connected: status === 'connected',
      });
    }
    return list;
  });

  const desktop = ENDPOINT_KIND === 'desktop';

  // --- quiet hours 表单（每来源独立草稿，打开时从已加载设置初始化） ---------

  let quietDrafts = $state<Record<string, { enabled: boolean; start: string; end: string }>>({});
  let savingQuiet = $state<string | null>(null);
  let usageOpen = $state<Record<string, boolean>>({});

  function minutesToLabel(minute: number): string {
    const h = Math.floor(minute / 60);
    const m = minute % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function labelToMinutes(label: string): number | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(label.trim());
    if (match === null) return null;
    const h = Number(match[1]);
    const m = Number(match[2]);
    if (h > 23 || m > 59) return null;
    return h * 60 + m;
  }

  function quietDraft(entry: SectionSource) {
    const existing = quietDrafts[entry.key];
    if (existing !== undefined) return existing;
    const settings = teamSettings.settingsOf(entry.source);
    const quiet = settings?.quietHours;
    const draft = {
      enabled: quiet?.enabled ?? false,
      start: minutesToLabel(quiet?.startMinute ?? 22 * 60),
      end: minutesToLabel(quiet?.endMinute ?? 8 * 60),
    };
    quietDrafts = { ...quietDrafts, [entry.key]: draft };
    return draft;
  }

  async function saveQuietHours(entry: SectionSource): Promise<void> {
    const draft = quietDrafts[entry.key];
    if (draft === undefined) return;
    const start = labelToMinutes(draft.start);
    const end = labelToMinutes(draft.end);
    if (start === null || end === null) {
      toast.error(t('team.quietHoursInvalid'));
      return;
    }
    savingQuiet = entry.key;
    try {
      const ok = await teamSettings.update(entry.source, {
        quietHours: { enabled: draft.enabled, startMinute: start, endMinute: end },
      });
      if (ok) toast.success(t('team.quietHoursSaved'));
      else toast.error(t('team.quietHoursSaveFailed'));
    } finally {
      savingQuiet = null;
    }
  }

  async function loadUsage(entry: SectionSource): Promise<void> {
    usageOpen = { ...usageOpen, [entry.key]: true };
    await teamSettings.loadUsage(entry.source);
  }

  // --- 离开态 ------------------------------------------------------------------

  let awayNote = $state('');

  async function toggleAway(entry: SectionSource, away: boolean): Promise<void> {
    const ok = await awayState.setAway(entry.source, away, awayNote);
    if (ok) {
      toast.success(away ? t('team.awaySetToast') : t('team.awayCleared'));
      awayNote = '';
    } else {
      toast.error(t('team.awayFailed'));
    }
  }

  function usageRows(entry: SectionSource): Array<{ day: string; total: string }> {
    const summary = teamSettings.usageBySource[entry.key];
    return (summary?.byDay ?? []).map((row) => ({
      day: new Date(row.dayStart).toLocaleDateString(),
      total: row.total.toFixed(2),
    }));
  }

  // --- 本地缓存（T8 步骤 5，仅桌面融合视图；web 无分区概念） -------------------

  let cacheUsage = $state<Record<string, string>>({});
  let cacheLimit = $state<Record<string, number>>({});
  let cacheBusy = $state<string | null>(null);
  // 普通 Set：已加载过占用读数的卡片 key（防 $effect 自触发的记账，非 UI 状态）。
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const cacheInfoLoaded = new Set<string>();

  const CACHE_LIMIT_CHOICES: Array<{ label: string; bytes: number }> = [
    { label: '256 MB', bytes: 256 * 1024 * 1024 },
    { label: '1 GB', bytes: 1024 * 1024 * 1024 },
    { label: '2 GB', bytes: 2 * 1024 * 1024 * 1024 },
    { label: '5 GB', bytes: 5 * 1024 * 1024 * 1024 },
    { label: '10 GB', bytes: 10 * 1024 * 1024 * 1024 },
  ];

  function formatCacheBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /** 占用读数（每卡一次；$effect 触发，失败静默显示「暂无」）。 */
  $effect(() => {
    if (!desktop) return;
    for (const entry of sources) {
      if (serverHashOf(entry.source) === null) continue;
      if (cacheInfoLoaded.has(entry.key)) continue;
      cacheInfoLoaded.add(entry.key);
      void loadCacheInfo(entry);
    }
  });

  async function loadCacheInfo(entry: SectionSource): Promise<void> {
    const extras = getDesktopTeamCacheExtras();
    if (extras === null) {
      cacheUsage = { ...cacheUsage, [entry.key]: t('team.cacheUnavailable') };
      return;
    }
    const hash = serverHashOf(entry.source);
    const memberId = hash === null ? null : connections.get(entry.source).memberId;
    if (hash === null || memberId === null) return;
    try {
      const usage = await extras.usage({ serverHash: hash, memberId });
      cacheUsage = {
        ...cacheUsage,
        [entry.key]:
          usage.cacheBytes === null
            ? t('team.cacheEmpty')
            : t('team.cacheUsage', { size: formatCacheBytes(usage.cacheBytes) }),
      };
      cacheLimit = { ...cacheLimit, [entry.key]: usage.attachmentLimitBytes };
    } catch {
      cacheUsage = { ...cacheUsage, [entry.key]: t('team.cacheEmpty') };
    }
  }

  async function changeCacheLimit(entry: SectionSource, limitBytes: number): Promise<void> {
    const extras = getDesktopTeamCacheExtras();
    if (extras === null) return;
    try {
      await extras.setAttachmentLimit(limitBytes);
      cacheLimit = { ...cacheLimit, [entry.key]: limitBytes };
      toast.success(t('team.cacheLimitSaved'));
      await loadCacheInfo(entry);
    } catch {
      toast.error(t('team.cacheClearFailed'));
    }
  }

  async function clearCache(entry: SectionSource): Promise<void> {
    cacheBusy = entry.key;
    try {
      await teamCacheSync.clearCurrentPartition(entry.source);
      toast.success(t('team.cacheCleared'));
      await loadCacheInfo(entry);
    } catch {
      toast.error(t('team.cacheClearFailed'));
    } finally {
      cacheBusy = null;
    }
  }
</script>

<div class="space-y-6" data-testid="team-settings-section">
  <div>
    <h3 class="text-base font-medium">{t('settings.navTeam')}</h3>
    <p class="mt-1 text-sm text-muted-foreground">{t('team.settingsHint')}</p>
  </div>

  {#each sources as entry (entry.key)}
    {@const draft = quietDraft(entry)}
    <div class="space-y-4 rounded-xl border p-4" data-testid={`team-settings-card-${entry.key}`}>
      <div class="flex items-center gap-2">
        <span
          class="size-2 shrink-0 rounded-full {entry.connected ? 'bg-emerald-500' : 'bg-zinc-400'}"
        ></span>
        <h4 class="min-w-0 flex-1 truncate text-sm font-medium">{entry.title}</h4>
        {#if !entry.connected}
          <span class="shrink-0 text-xs text-muted-foreground">{t('team.serverOffline')}</span>
        {/if}
      </div>

      <!-- 离开态 -->
      <div class="space-y-2" data-testid={`team-away-${entry.key}`}>
        <p class="text-xs font-medium">{t('team.awayTitle')}</p>
        {#if awayState.isAway(entry.source)}
          <p class="text-xs text-muted-foreground" data-testid={`team-away-active-${entry.key}`}>
            {awayState.avatarBotNameOf(entry.source) !== null
              ? t('team.awayAvatarHandling', { bot: awayState.avatarBotNameOf(entry.source) ?? '' })
              : t('team.awayActiveHint')}
          </p>
          <Button size="sm" onclick={() => void toggleAway(entry, false)} data-testid={`team-away-clear-${entry.key}`}>
            {t('team.awayClear')}
          </Button>
        {:else}
          <input
            class="h-8 w-full max-w-xs rounded-md border border-input bg-background px-2 text-sm"
            type="text"
            maxlength="200"
            placeholder={t('team.awayNotePlaceholder')}
            bind:value={awayNote}
            data-testid={`team-away-note-${entry.key}`}
          />
          <div class="flex items-center gap-2">
            <Button
              size="sm"
              disabled={awayState.submitting}
              onclick={() => void toggleAway(entry, true)}
              data-testid={`team-away-set-${entry.key}`}
            >
              {t('team.awaySet')}
            </Button>
            <!-- 分身开关 T10 前不可用（置灰 + tooltip 说明）。 -->
            <span class="relative inline-flex" title={t('team.avatarDisabledHint')}>
              <label
                class="pointer-events-none flex cursor-not-allowed items-center gap-1.5 text-xs text-muted-foreground opacity-50"
                data-testid={`team-avatar-toggle-${entry.key}`}
              >
                <input type="checkbox" disabled checked={false} />
                {t('team.avatarToggle')}
              </label>
            </span>
          </div>
        {/if}
      </div>

      <!-- 成员域免打扰 -->
      <div class="space-y-2" data-testid={`team-quiet-hours-${entry.key}`}>
        <p class="text-xs font-medium">{t('team.quietHoursTitle')}</p>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={draft.enabled}
            onchange={(event) => {
              quietDrafts = {
                ...quietDrafts,
                [entry.key]: { ...draft, enabled: (event.currentTarget as HTMLInputElement).checked },
              };
            }}
            data-testid={`team-quiet-enabled-${entry.key}`}
          />
          {t('team.quietHoursEnabled')}
        </label>
        <div class="flex items-center gap-2 text-sm">
          <input
            class="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm"
            type="time"
            bind:value={draft.start}
            data-testid={`team-quiet-start-${entry.key}`}
          />
          <span class="text-xs text-muted-foreground">→</span>
          <input
            class="h-8 w-20 rounded-md border border-input bg-background px-2 text-sm"
            type="time"
            bind:value={draft.end}
            data-testid={`team-quiet-end-${entry.key}`}
          />
          <span class="text-xs text-muted-foreground">{t('team.quietHoursLocal')}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={savingQuiet === entry.key}
            onclick={() => void saveQuietHours(entry)}
            data-testid={`team-quiet-save-${entry.key}`}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>

      <!-- 个人用量 -->
      <div class="space-y-2" data-testid={`team-usage-${entry.key}`}>
        <div class="flex items-center gap-2">
          <p class="text-xs font-medium">{t('team.usageTitle')}</p>
          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2 text-xs"
            onclick={() => void loadUsage(entry)}
            data-testid={`team-usage-refresh-${entry.key}`}
          >
            {t('team.usageRefresh')}
          </Button>
        </div>
        {#if usageOpen[entry.key] !== true}
          <p class="text-xs text-muted-foreground">{t('team.usageHint')}</p>
        {:else if usageRows(entry).length === 0}
          <p class="text-xs text-muted-foreground" data-testid={`team-usage-empty-${entry.key}`}>
            {t('team.usageEmpty')}
          </p>
        {:else}
          <table class="w-full max-w-sm text-sm" data-testid={`team-usage-table-${entry.key}`}>
            <thead>
              <tr class="text-left text-xs text-muted-foreground">
                <th class="py-1 pr-2 font-medium">{t('team.usageDay')}</th>
                <th class="py-1 font-medium">{t('team.usageTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {#each usageRows(entry) as row (row.day)}
                <tr class="border-t">
                  <td class="py-1 pr-2">{row.day}</td>
                  <td class="py-1 tabular-nums">{row.total}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- 画像上行（仅桌面融合视图；web 无本机画像不显示入口）。 -->
      {#if desktop && serverHashOf(entry.source) !== null}
        <div class="space-y-1.5" data-testid={`team-profile-push-${entry.key}`}>
          <p class="text-xs font-medium">{t('team.profilePushTitleShort')}</p>
          <p class="text-xs text-muted-foreground">{t('team.profilePushHint')}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={!entry.connected}
            onclick={() => void profilePush.openManual(entry.source)}
            data-testid={`team-profile-push-button-${entry.key}`}
          >
            {t('team.profilePushRefresh')}
          </Button>
        </div>
      {/if}

      <!-- 本地缓存（T8 步骤 5，仅桌面）：占用显示 + 附件上限 + 清除当前分区。 -->
      {#if desktop && serverHashOf(entry.source) !== null}
        <div class="space-y-2" data-testid={`team-cache-${entry.key}`}>
          <p class="text-xs font-medium">{t('team.cacheTitle')}</p>
          <p class="text-xs text-muted-foreground" data-testid={`team-cache-usage-${entry.key}`}>
            {cacheUsage[entry.key] ?? t('team.cacheEmpty')}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <label class="text-xs text-muted-foreground" for={`team-cache-limit-${entry.key}`}>
              {t('team.cacheAttachmentLimit')}
            </label>
            <select
              id={`team-cache-limit-${entry.key}`}
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
              value={cacheLimit[entry.key] ?? 1024 * 1024 * 1024}
              onchange={(event) =>
                void changeCacheLimit(
                  entry,
                  Number((event.currentTarget as HTMLSelectElement).value),
                )}
              data-testid={`team-cache-limit-${entry.key}`}
            >
              {#each CACHE_LIMIT_CHOICES as choice (choice.bytes)}
                <option value={choice.bytes}>{choice.label}</option>
              {/each}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={cacheBusy === entry.key}
              onclick={() => void clearCache(entry)}
              data-testid={`team-cache-clear-${entry.key}`}
            >
              {t('team.cacheClear')}
            </Button>
          </div>
        </div>
      {/if}
    </div>
  {/each}
</div>
