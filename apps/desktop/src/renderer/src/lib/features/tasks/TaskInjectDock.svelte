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
   * 由 `injectTaskId` 切成注入模式：语音对话模式、@ 提及、协作 presence / 共享
   * 草稿、引用回复一律不出现；草稿走 `task:<id>` 独立键，发送走 `tasks.inject`。
   * D115 附件直注：+ 键与对话同一入口，附件随注入直发（图片进视觉通道）；执行
   * 模型不支持视觉且未配看图模型时点 + 在坞内弹「看图模型」配置卡（D58 内联
   * 设置的同款卡，`onDismiss` 本地关闭）。
   *
   * 判定与发送语义见 composer-inject.ts。
   */
  import Composer from '$lib/features/chats/Composer.svelte';
  import SetupRequiredCard from '$lib/features/chats/SetupRequiredCard.svelte';
  import type { SetupRequirement } from '@kepcup/shared';
  import { t } from '$lib/i18n';

  let {
    taskId,
    conversationId = null,
    modelRef = null,
    awaitingInput = false,
  }: {
    taskId: string;
    /** 任务所在会话：附件上传 / 状态校验的归属。null = 附件不可用。 */
    conversationId: string | null;
    /**
     * 任务执行器模型 ref。外部 Agent 任务形如 `agent:{id}/…`（或 bot 未配模型
     * 时为 null）——两种情况都解析不到已配置厂商，附件预检放行（附件靠注入
     * 文本里的物化路径到达，配置看图模型帮不上忙）。
     */
    modelRef: string | null;
    awaitingInput?: boolean;
  } = $props();

  /** D115 附件直注：预检未过时在坞内弹「看图模型」配置卡（compose 上方）。 */
  let attachSetup = $state<SetupRequirement | null>(null);

  // 换任务即收卡：预检结论属于上一个任务（外部 Agent 任务本不该拦），
  // CardChat 里 TaskRunView 不按任务重挂，这里得自己复位。
  $effect(() => {
    void taskId;
    attachSetup = null;
  });
</script>

<div class="shrink-0" data-testid="task-run-inject">
  {#if awaitingInput}
    <div class="mx-auto w-full max-w-3xl px-4 pt-2">
      <p class="text-xs text-amber-700 dark:text-amber-400" data-testid="task-run-inject-hint">
        {t('task.run.injectHintAwaiting')}
      </p>
    </div>
  {/if}
  {#if attachSetup !== null}
    <div class="mx-auto w-full max-w-3xl px-4 pt-2" data-testid="task-run-inject-setup">
      <SetupRequiredCard
        requirement={attachSetup}
        onDismiss={() => (attachSetup = null)}
        onProceed={() => (attachSetup = null)}
      />
    </div>
  {/if}
  <!-- 按任务重挂载：编辑器扩展集（@ 提及 / 指令上限）在挂载时确定，任务切换
       必须重建，同时把上一个任务的草稿缓存留在 `task:<旧 id>` 里。 -->
  {#key taskId}
    <Composer
      injectTaskId={taskId}
      injectConversationId={conversationId}
      injectModelRef={modelRef}
      placeholderText={t('task.run.injectPlaceholder')}
      onRequestAttachSetup={() => (attachSetup = { kind: 'capability-model', capability: 'multimodal' })}
    />
  {/key}
</div>
