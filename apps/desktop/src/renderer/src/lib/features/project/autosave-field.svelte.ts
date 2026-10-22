/**
 * 项目详情页「名称 / 目标」字段的自动保存调度（D92 41 §11.3 审查修复）：
 * 停顿 `delayMs` 提交、Enter/blur 立即提交、IME 组合期间挂起（不把未上屏的
 * 拼音串提交成项目名）、保存失败只在草稿未再变化时回滚、卸载时清理挂起的
 * 计时器并补一次提交。纯判定在 `project-settings-model.ts`，提交与已保存值
 * 由组件注入，这样这里可以用真实的 Svelte 响应式（`$state`）单测。
 */

/** 一次字段保存的判定结果（`planTitleSave` / `planGoalSave` 的公共形状）。 */
export type FieldSavePlan =
  /** 与已保存值相同（或目标本就为空再清空）——不提交。 */
  | { readonly kind: 'skip' }
  /** 字段被清空且不该提交空值（名称）：flush 时还原已保存值。 */
  | { readonly kind: 'restore' }
  /** 提交该值（`null` = 清除目标）。 */
  | { readonly kind: 'save'; readonly value: string | null };

export interface AutoSaveFieldOptions {
  /** 输入停顿多少毫秒后提交（ProjectSettingsOverview 用 400）。 */
  readonly delayMs: number;
  /** 纯保存判定：把草稿与已保存值映射成 {@link FieldSavePlan}。 */
  readonly plan: (draft: string, current: string | null) => FieldSavePlan;
  /**
   * 提交一个值（`chat.renameProject` / `chat.updateProjectGoal`）。失败提示
   * 由提交方负责（toast），这里只看返回的布尔值。
   */
  readonly save: (value: string | null) => Promise<boolean>;
  /** 当前的已保存值（每次判定时读取，不做响应式依赖）。 */
  readonly current: () => string | null;
}

export class AutoSaveField {
  /** 输入框草稿；组件 `bind:value` 直连这里。 */
  draft = $state('');
  /** 上一次同步进来的已保存值（仅用于比较，不参与渲染）。 */
  private synced: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 提交飞行中：后续 flush 直接返回，落定后按需再补一轮。 */
  private saving = false;
  /** IME 组合中：挂起一切保存调度，组合结束再调度（见 onCompositionStart）。 */
  private composing = false;

  constructor(private readonly options: AutoSaveFieldOptions) {}

  /**
   * 已保存值变化（会话对象刷新）时同步进草稿；用户未保存的编辑（草稿 !=
   * 上次同步值）保留，不被服务端值覆盖。
   */
  sync(current: string | null): void {
    if (current === this.synced) return;
    const clean = this.draft === (this.synced ?? '');
    this.synced = current;
    if (clean) this.draft = current ?? '';
  }

  /** input 事件：组合期间（事件带 `isComposing` 或已收到 compositionstart）不调度。 */
  onInput(event: Event | undefined = undefined): void {
    if (this.composing || (event as InputEvent | undefined)?.isComposing === true) return;
    this.schedule();
  }

  /**
   * compositionstart：进入组合。把挂起的防抖一并撤掉——计时器若在组合中途
   * 触发会把含拼音串的草稿提交出去；组合前的输入不会丢，组合结束后的调度
   * 提交的是完整草稿。
   */
  onCompositionStart(): void {
    this.composing = true;
    this.clearTimer();
  }

  /**
   * compositionend：组合文本上屏，此时才调度保存。Chromium 的最后一次组合
   * input 带 `isComposing: true`（被 onInput 跳过），靠这里兜底；Safari 的
   * 顺序是 compositionend → input，两条路都通。
   */
  onCompositionEnd(): void {
    this.composing = false;
    this.schedule();
  }

  /** 立即提交（Enter / blur）。`restoreEmpty`：清空的名称 flush 时还原已保存值。 */
  flush(restoreEmpty = false): void {
    // 组合中的 blur 不提交半成品（浏览器随后会上屏并触发 compositionend，
    // 那里的调度会提交完整文本）。
    if (this.composing) return;
    this.clearTimer();
    void this.saveNow(restoreEmpty);
  }

  /** Escape（名称专用）：撤掉挂起的提交并还原已保存值。 */
  cancelAndRestore(): void {
    this.clearTimer();
    this.draft = this.options.current() ?? '';
  }

  /**
   * 卸载清理（切分区 / 切走会话 / 关闭页面）：补提交挂起的编辑。通常用户点
   * 导航时输入框先 blur（mousedown 转移焦点）→ flush 先行，这里的提交经
   * 判定 `skip` 或飞行锁自然幂等；程序化切换（深链）没有 blur，靠这里兜底。
   * 组合中卸载则直接丢弃（半成品不上屏，不提交）。
   */
  dispose(): void {
    if (this.composing) {
      this.clearTimer();
      return;
    }
    this.flush(true);
  }

  private schedule(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.saveNow(false);
    }, this.options.delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async saveNow(restoreEmpty: boolean): Promise<void> {
    if (this.saving) return;
    const raw = this.draft;
    const plan = this.options.plan(raw, this.options.current());
    if (plan.kind === 'restore') {
      // 清空只是输入的中间状态；只有 flush（blur / 卸载）把已保存值放回去。
      if (restoreEmpty) this.draft = this.options.current() ?? '';
      return;
    }
    if (plan.kind === 'skip') return;
    this.saving = true;
    let ok: boolean;
    try {
      ok = await this.options.save(plan.value);
    } finally {
      this.saving = false;
    }
    if (!ok) {
      // 失败（提交方已 toast）只在草稿仍是本次提交值时回滚；飞行期间的新
      // 输入保留，落到下面“再来一轮”重试（持续失败在下一轮回滚收敛）。
      if (this.draft === raw) {
        this.draft = this.options.current() ?? '';
        return;
      }
    } else if (this.options.plan(this.draft, this.options.current()).kind !== 'save') {
      return;
    }
    // 飞行期间的编辑（成功后仍与已保存值不同，或失败后保留下来的新草稿）
    // 需要再来一轮。
    this.schedule();
  }
}
