import { chat } from '$lib/stores/chat.svelte';
import { shell } from '$lib/stores/shell.svelte';
import { narrowLayout } from '$lib/features/shell/narrow-layout.svelte';

/**
 * web（PWA）+ 窄屏的横滑返回（D96 WP5，design 46 §5.5）：把「层」（会话详情 /
 * 窄屏设置覆盖层 / Bot 详情覆盖层 / 全局搜索层）的打开映射成一条 history 记录，
 * 手势 / 系统返回触发 popstate 时执行与 UI 返回按钮相同的动作。集中在这里处理，
 * 不改窄屏组件本身。
 *
 * 覆盖范围（P0 按层全开，动作都取自各层已有的收口函数）：
 *  - 全局搜索层（shell.closeSearch）
 *  - Bot 详情覆盖层（narrowLayout.closeBotDetail）
 *  - 窄屏设置覆盖层（shell.narrowSettingsOpen = false）
 *  - 会话详情层（chat.leaveCurrent，含「新建项目」占位层）
 *
 * 实现注记：只维护一条「有层打开」的历史记录（不逐层入栈）——返回一次关掉最上
 * 层后，若仍有层开着，effect 会补推一条新记录，手势连续返回因此逐层生效。
 */
export function bindWebBackNavigation(): () => void {
  let pushed = false;
  /** 正在由 UI 收层驱动 history.back()：忽略随之而来的那次 popstate。 */
  let syncing = false;

  const anyLayerOpen = (): boolean =>
    narrowLayout.narrow &&
    (shell.searchOpen ||
      narrowLayout.botDetailOpen ||
      shell.narrowSettingsOpen ||
      chat.currentId !== null ||
      chat.composingProject);

  const disposeRoot = $effect.root(() => {
    $effect(() => {
      if (anyLayerOpen()) {
        if (!pushed && !syncing) {
          history.pushState({ kepcupWebLayer: true }, '');
          pushed = true;
        }
      } else if (pushed && !syncing) {
        // 用户点了 UI 返回按钮关掉层：同步弹出我们的历史记录，栈保持干净。
        syncing = true;
        history.back();
      }
    });
  });

  const onPopstate = (): void => {
    if (syncing) {
      syncing = false;
      pushed = false;
      return;
    }
    if (!pushed) return;
    pushed = false;
    closeTopLayer();
  };
  window.addEventListener('popstate', onPopstate);
  return () => {
    window.removeEventListener('popstate', onPopstate);
    disposeRoot();
  };
}

/** 关掉最上层的覆盖层（与各层 UI 返回按钮同一动作）。 */
function closeTopLayer(): void {
  if (shell.searchOpen) {
    shell.closeSearch();
    return;
  }
  if (narrowLayout.botDetailOpen) {
    narrowLayout.closeBotDetail();
    return;
  }
  if (shell.narrowSettingsOpen) {
    shell.narrowSettingsOpen = false;
    return;
  }
  if (chat.currentId !== null || chat.composingProject) chat.leaveCurrent();
}
