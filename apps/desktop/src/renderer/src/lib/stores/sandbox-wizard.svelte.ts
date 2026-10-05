/**
 * P12-B: open state of the sandbox preparation wizard. A module-level store
 * so both entry points (设置页按钮与首次启动提示) can open the single wizard
 * dialog mounted in App.svelte.
 */
class SandboxWizardState {
  open = $state(false);

  show(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const sandboxWizard = new SandboxWizardState();
