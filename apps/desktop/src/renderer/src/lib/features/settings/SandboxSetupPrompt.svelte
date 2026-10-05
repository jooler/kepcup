<script lang="ts">
  import type { SandboxWslStatusOutput } from '@kepcup/shared';
  import { t } from '$lib/i18n';
  import { core } from '$lib/rpc/client.svelte';
  import { sandboxWizard } from '$lib/stores/sandbox-wizard.svelte';
  import { Button } from '$lib/components/ui/button';
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from '$lib/components/ui/dialog';

  /**
   * P12-B 首次启动入口（任务 7）：Windows 沙箱尚未准备且用户未跳过时提示。
   * 只在适用的机器上出现（wslStatus.applicable）；「稍后」仅关闭本次会话，
   * 「跳过」经核心侧持久化（此后不再提示，命令保持逐条确认模式，设置页仍可
   * 随时开始准备）。
   */

  let visible = $state(false);
  let skipping = $state(false);
  let checked = false;

  $effect(() => {
    if (checked) return;
    checked = true;
    void check();
  });

  async function check(): Promise<void> {
    try {
      const status = (await core.call('sandbox.wslStatus')) as SandboxWslStatusOutput;
      visible =
        status.applicable &&
        !status.skipped &&
        status.phase !== 'ready' &&
        status.phase !== 'policy_disabled';
    } catch {
      visible = false;
    }
  }

  async function skip(): Promise<void> {
    skipping = true;
    try {
      await core.call('sandbox.wslSkip');
      visible = false;
    } finally {
      skipping = false;
    }
  }

  function prepare(): void {
    visible = false;
    sandboxWizard.show();
  }
</script>

<Dialog open={visible} onOpenChange={(value) => (visible = value)}>
  <DialogContent class="max-w-md" data-testid="sandbox-prompt">
    <DialogHeader>
      <DialogTitle>{t('prompt.title')}</DialogTitle>
      <DialogDescription>{t('prompt.body')}</DialogDescription>
    </DialogHeader>
    <DialogFooter class="gap-2 sm:justify-start">
      <Button size="sm" onclick={prepare} data-testid="sandbox-prompt-prepare">
        {t('prompt.prepare')}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={skipping}
        onclick={() => void skip()}
        data-testid="sandbox-prompt-skip"
      >
        {t('prompt.skip')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onclick={() => (visible = false)}
        data-testid="sandbox-prompt-later"
      >
        {t('prompt.later')}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
