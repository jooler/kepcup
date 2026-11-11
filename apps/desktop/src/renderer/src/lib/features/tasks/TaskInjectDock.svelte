<script lang="ts">
  /**
   * D115 任务直注注入坞（docs/design/56 §1，设计 42「注入坞」小节）：任务详情页
   * 最底部的自由文本入口，经 `tasks.inject` 直达 `TaskHost.injectById`——与对话
   * 轮的 `inject_task` 同一机制，语义零改动。仅非终态任务渲染（调用方守卫）；
   * delivered / queued / 失败都以 toast 反馈，运行中的指令随即以「追加指令」
   * steer 气泡出现在时间线里。任务在等提问时注入即回答（core 内部转
   * #resolveQuestion），给出提示行与上方提问卡并存：结构化选项走卡，自由文本
   * 走这里。
   *
   * 实现上直接复用对话的 `Composer`（用户要求「直接复用对话组件中的输入组件」），
   * 由 `injectTaskId` 切成注入模式：+ 附件键与语音输入键保留，语音对话模式、
   * @ 提及、协作 presence / 共享草稿、引用回复一律不出现；草稿走 `task:<id>`
   * 独立键，发送走 `tasks.inject`。判定与发送语义见 composer-inject.ts。
   */
  import Composer from '$lib/features/chats/Composer.svelte';
  import { t } from '$lib/i18n';

  let { taskId, awaitingInput = false }: { taskId: string; awaitingInput?: boolean } = $props();
</script>

<div class="shrink-0 border-t" data-testid="task-run-inject">
  {#if awaitingInput}
    <div class="mx-auto w-full max-w-3xl px-4 pt-2">
      <p class="text-xs text-amber-700 dark:text-amber-400" data-testid="task-run-inject-hint">
        {t('task.run.injectHintAwaiting')}
      </p>
    </div>
  {/if}
  <!-- 按任务重挂载：编辑器扩展集（@ 提及 / 指令上限）在挂载时确定，任务切换
       必须重建，同时把上一个任务的草稿缓存留在 `task:<旧 id>` 里。 -->
  {#key taskId}
    <Composer injectTaskId={taskId} placeholderText={t('task.run.injectPlaceholder')} />
  {/key}
</div>
