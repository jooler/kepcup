/**
 * P13 任务 4 首启引导的界面状态。可见性由 App.svelte 决定（core 就绪 +
 * settings 已加载 + 平台开关允许 + settings.onboarding.completed=false 时
 * 打开一次）；向导内部是双向步进状态机——每一步都可返回。
 */
class OnboardingState {
  open = $state(false);

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const onboarding = new OnboardingState();
