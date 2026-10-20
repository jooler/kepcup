<script lang="ts">
  import { t } from '$lib/i18n';
  import { Button } from '$lib/components/ui/button';
  import MemoPane from './MemoPane.svelte';
  import TodoDrawer from './TodoDrawer.svelte';
  import TodoPane from './TodoPane.svelte';
  import { useWorkbenchData, workbench } from './workbench.svelte';

  /**
   * 工作台（D90，docs/design/39-workbench.md §4）：宽屏主区的第二个视图，不进任何对话也能
   * 统筹全局。双栏——左备忘（更宽）、右事项（按成员分道）；窄于阈值时折成「事项 / 备忘」两个 tab。
   * 事项详情以居中弹框打开。数据由 `workbench` store 拉取并订阅
   * todos / memos / schedules 的 changed 事件，只在本视图挂载期间有效。
   */
  /** 本视图宽度低于此值时折成 tab（双栏各留 ≥ 320px 才不挤）。 */
  const TABS_BELOW = 760;

  let width = $state(1200);
  let tab = $state<'todos' | 'memos'>('todos');
  // E2E seam（同 KEPCUP_* 家族，仅 TEST_HOOKS 产物生效）：CI runner 的显示
  // 空间可能小于默认窗口（mac runner 只有 1024×677），双栏里 memo 侧收不进
  // 而走 tab。工作台挂载时刻读一次并贯穿生命周期，断言与显示空间解耦；
  // 真实产品行为（按宽度取舍）仍由 narrow-layout / workbench 布局用例覆盖。
  // 布局用例要验证 tab 形态：它先撤 seam、把窗口缩到阈值下、再「退回对话 →
  // 重新打开工作台」（本质一次 remount），挂载逻辑会按新状态重新起形态。
  const forcedWide =
    __KEPCUP_TEST_HOOKS__ === true &&
    window.localStorage.getItem('kepcup.e2e.workbenchWide') === '1';
  const tabbed = $derived(!forcedWide && width < TABS_BELOW);

  useWorkbenchData();
</script>

<div
  class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-background"
  bind:clientWidth={width}
  data-testid="workbench-view"
>
  <!-- 详情弹框是模态：打开时弹框之外的工作台内容不可聚焦（inert）。 -->
  <div class="flex min-h-0 flex-1 flex-col" inert={workbench.drawer !== null}>
    <!-- 顶部带：窗口拖拽区（与聊天区顶部一致），标题与 tab 自身 no-drag。 -->
    <header class="app-drag wco-inset-end flex h-14 shrink-0 items-center gap-3 px-5">
      <h1 class="text-base font-semibold">{t('workbench.title')}</h1>
      {#if tabbed}
        <div
          class="app-no-drag ml-auto inline-flex rounded-lg border bg-muted/40 p-0.5"
          role="tablist"
        >
          {#each ['todos', 'memos'] as const as id (id)}
            <button
              type="button"
              role="tab"
              aria-selected={tab === id}
              class="cursor-pointer rounded-md px-3 py-1 text-xs transition-colors {tab === id
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground'}"
              onclick={() => (tab = id)}
              data-testid={`workbench-tab-${id}`}
            >
              {id === 'todos' ? t('workbench.tabTodos') : t('workbench.tabMemos')}
            </button>
          {/each}
        </div>
      {/if}
    </header>

    {#if workbench.loadState === 'error'}
      <div
        class="mx-5 mb-3 flex items-center gap-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400"
        role="alert"
        data-testid="workbench-error"
      >
        <span class="flex-1">{t('workbench.loadFailed')}</span>
        <Button size="xs" variant="outline" onclick={() => void workbench.refreshAll()}>
          {t('workbench.retry')}
        </Button>
      </div>
    {/if}

    <div class="flex min-h-0 flex-1 gap-8 px-5 pb-4">
      {#if !tabbed || tab === 'memos'}
        <section
          class="flex min-h-0 min-w-0 flex-[3] flex-col gap-3"
          aria-label={t('workbench.memo.title')}
        >
          {#if !tabbed}
            <h2
              class="w-full shrink-0 border-b border-border pb-2 text-sm font-medium text-muted-foreground"
            >
              {t('workbench.memo.title')}
            </h2>
          {/if}
          <MemoPane />
        </section>
      {/if}
      {#if !tabbed || tab === 'todos'}
        <section
          class="flex min-h-0 min-w-0 flex-[2] flex-col gap-3"
          aria-label={t('workbench.todos.title')}
        >
          {#if !tabbed}
            <h2
              class="w-full shrink-0 border-b border-border pb-2 text-sm font-medium text-muted-foreground"
            >
              {t('workbench.todos.title')}
            </h2>
          {/if}
          <TodoPane />
        </section>
      {/if}
    </div>
  </div>

  <TodoDrawer />
</div>
