<script lang="ts">
  import type { SetupRequirement } from '@kepcup/shared';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { getChatSession } from './chat-session-context';
  import { Button } from '$lib/components/ui/button';
  import SettingSetupBody from '$lib/features/settings-card/SettingSetupBody.svelte';

  /**
   * 消息列表内的「缺设置」引导卡片（docs/design/18-inline-setup.md）：数据源
   * 是当前会话的 setupRequirement（发送门禁置起，或失败 run 携带的结构化 setup）。
   * P2 收拢后这里只是外壳（关闭按钮 + 分发）；body 的选择与旧 kind 的别名转换
   * 统一在 `SettingSetupBody`（设计篇 38 §5.3）：
   * - setting（通用设置项，todo/conversational-app-setup.md §6.2）：与消息流
   *   设置卡同一套分发（SettingCardEmbed，预填取 requirement.prefill）；
   * - capability-model / web-search / mail-account：转成 kind:'setting' 走同一
   *   分发（旧 kind 在契约里保留为兼容别名）；
   * - agent / connect-app：分发到各自的别名 body（载荷里的额外字段与随附行为
   *   由 body 消费）；
   * - main-model：两段式（供应商表单 → 选默认主模型，可顺带写当前 Bot 的模型），
   *   不是单条目录条目，保留独立 kind（MainModelSetupBody）；
   * - confirm-local-connector：本机连接确认卡，不是设置目录条目——用户点的是
   *   apps.localConnectors.confirm / reject，保持独立 kind 与独立 body；
   * - confirm-plugin-install：Bot 提议安装官方插件的确认卡（D104 P1-3），body 自己
   *   plugins.inspect 后渲染同意面板，用户点 plugins.install / 不装了。
   * 确认 / 保存后 session.continueAfterSetup() 自动续跑（重试原 run 或冲掉保留的草稿）。
   */
  let {
    requirement,
    onDismiss,
    onProceed,
  }: {
    requirement: SetupRequirement;
    /** 任务详情页等无会话上下文的宿主：自带关闭承接（缺省走当前会话）。 */
    onDismiss?: () => void;
    /** 保存 / 继续的承接（缺省走当前会话的 continueAfterSetup）。 */
    onProceed?: () => void;
  } = $props();

  // getChatSession 必须在组件初始化时调用（Svelte context 规则）：点
  // 击回调里再取会抛 lifecycle_outside_component，关闭按钮无效果，
  // runs.setupDismissed 也不会发出（v0.5.12 把取值挪到 onclick 后
  // 本机连接 e2e 的「暂不设置」因此失活）。有 onDismiss 时仍在初始化
  // 取一次（回落主会话），只是不用它。
  const session = getChatSession();

  function dismiss(): void {
    if (onDismiss !== undefined) {
      onDismiss();
      return;
    }
    session.dismissSetupCard();
  }
</script>

<div
  class="relative mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-xl border border-primary/25 bg-background px-4 py-3.5 shadow-sm"
  data-testid="setup-card"
>
  <Button
    variant="ghost"
    size="icon"
    class="absolute top-1.5 right-1.5 size-6 text-muted-foreground"
    aria-label={t('setupCard.dismiss')}
    title={t('setupCard.dismiss')}
    onclick={dismiss}
    data-testid="setup-card-dismiss"
  >
    <X class="size-3.5" aria-hidden="true" />
  </Button>

  <SettingSetupBody {requirement} {onProceed} />
</div>
