<script lang="ts">
  import type { SetupRequirement } from '@kepcup/shared';
  import { X } from '@lucide/svelte';
  import { t } from '$lib/i18n';
  import { chat } from '$lib/stores/chat.svelte';
  import { Button } from '$lib/components/ui/button';
  import SettingSetupBody from '$lib/features/settings-card/SettingSetupBody.svelte';

  /**
   * 消息列表内的「缺设置」引导卡片（docs/design/18-inline-setup.md）：数据源
   * 是 chat.setupRequirement（发送门禁置起，或失败 run 携带的结构化 setup）。
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
   *   apps.localConnectors.confirm / reject，保持独立 kind 与独立 body。
   * 确认 / 保存后 chat.continueAfterSetup() 自动续跑（重试原 run 或冲掉保留的草稿）。
   */
  let { requirement }: { requirement: SetupRequirement } = $props();
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
    onclick={() => chat.dismissSetupCard()}
    data-testid="setup-card-dismiss"
  >
    <X class="size-3.5" aria-hidden="true" />
  </Button>

  <SettingSetupBody {requirement} />
</div>
