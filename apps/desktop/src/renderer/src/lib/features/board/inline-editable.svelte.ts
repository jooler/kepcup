/**
 * Debounced save for contenteditable text (design 50 §9.7).
 *
 * Modeled on AutoSaveField: pause, then save; IME composition suspends the
 * timer; a failed save rolls back only when the draft is still the text that
 * failed; a new edit during an in-flight save gets another round. Unlike
 * AutoSaveField this is not a single-line form field — the caller normalizes
 * newlines and non-breaking spaces at save time, and the component owns the DOM.
 */

export interface InlineEditSchedulerOptions {
  /** Quiet period before an automatic save. */
  readonly delayMs: number;
  /**
   * When false, typing does not schedule a save. Flush, blur, and dispose
   * still commit. The new-card composer uses this so a pause does not create
   * a card.
   */
  readonly autosave?: boolean;
  /** Applied only when deciding to save, not on each keystroke. */
  readonly normalize?: (text: string) => string;
  /** Persist one value. False keeps the draft (the caller toasts). */
  readonly save: (text: string) => Promise<boolean>;
  /** A commit finished. `clearOnSave` uses this to empty the composer. */
  readonly onSettled?: (ok: boolean) => void;
}

export class InlineEditScheduler {
  /** Text the field is showing. The component mirrors this into the DOM. */
  draft = $state('');

  private synced = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private composing = false;
  /** Blur arrived during IME; flush once compositionend delivers the text. */
  private pendingFlush = false;
  /** Escape restored the saved text. The blur that follows must not save it. */
  private cancelled = false;
  private queued: 'flush' | 'schedule' | null = null;
  private readonly normalize: (text: string) => string;

  constructor(private readonly options: InlineEditSchedulerOptions) {
    this.normalize = options.normalize ?? ((text: string) => text);
  }

  private get autosave(): boolean {
    return this.options.autosave !== false;
  }

  isComposing(): boolean {
    return this.composing;
  }

  isSaving(): boolean {
    return this.saving;
  }

  saved(): string {
    return this.synced;
  }

  /** Draft differs from the last saved value (before trim). */
  hasUnsaved(): boolean {
    return this.normalize(this.draft) !== this.synced;
  }

  /**
   * External value changed. A focused field or an unsaved draft is left
   * alone; the caller also skips this while the element is focused.
   */
  sync(value: string): void {
    if (value === this.synced) return;
    const clean = !this.hasUnsaved() && !this.composing && !this.saving;
    this.synced = value;
    if (clean) this.draft = value;
  }

  /** Input event. Composition and `isComposing` do not schedule. */
  onInput(event?: Event): void {
    this.cancelled = false;
    if (this.composing || (event as InputEvent | undefined)?.isComposing === true) return;
    if (!this.autosave) return;
    if (this.saving) {
      this.queued = this.queued === 'flush' ? 'flush' : 'schedule';
      return;
    }
    this.schedule();
  }

  onCompositionStart(): void {
    this.composing = true;
    this.clearTimer();
  }

  onCompositionEnd(): void {
    this.composing = false;
    if (this.cancelled) return;
    if (this.pendingFlush) {
      this.pendingFlush = false;
      void this.flush();
      return;
    }
    if (this.autosave) this.schedule();
  }

  /** Commit now. A blur during composition waits for compositionend. */
  async flush(): Promise<boolean> {
    if (this.cancelled) {
      this.clearTimer();
      this.pendingFlush = false;
      this.draft = this.synced;
      return false;
    }
    if (this.composing) {
      this.pendingFlush = true;
      return false;
    }
    this.pendingFlush = false;
    this.clearTimer();
    return this.saveNow(true);
  }

  /** Drop the pending save and restore the last saved text (Escape). */
  cancel(): void {
    this.clearTimer();
    this.pendingFlush = false;
    this.queued = null;
    this.cancelled = true;
    this.draft = this.synced;
  }

  /** Replace both the draft and the saved value. Used after a composer submits. */
  reset(value: string): void {
    this.clearTimer();
    this.pendingFlush = false;
    this.queued = null;
    this.cancelled = false;
    this.synced = value;
    this.draft = value;
  }

  /** Unmount: commit a pending edit. A half-composed IME string is discarded. */
  dispose(): void {
    if (this.composing) {
      this.clearTimer();
      this.pendingFlush = false;
      return;
    }
    void this.flush();
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

  private payload(): string {
    return this.normalize(this.draft).trim();
  }

  private async saveNow(fromFlush: boolean): Promise<boolean> {
    if (this.saving) {
      this.queued = fromFlush || this.queued === 'flush' ? 'flush' : 'schedule';
      return false;
    }
    const raw = this.draft;
    const text = this.payload();
    if (text.length === 0) {
      if (fromFlush) this.draft = this.synced;
      return false;
    }
    if (text === this.synced) {
      if (fromFlush) this.draft = this.synced;
      return false;
    }
    this.saving = true;
    const ok = await this.options.save(text).finally(() => {
      this.saving = false;
    });
    if (!ok) {
      if (this.draft === raw) {
        this.draft = this.synced;
        this.queued = null;
        this.options.onSettled?.(false);
        return false;
      }
    } else {
      this.synced = text;
      if (this.payload() === text) this.draft = text;
    }
    this.options.onSettled?.(ok);
    const queued = this.queued;
    this.queued = null;
    const again = this.payload();
    const dirty = again.length > 0 && again !== this.synced;
    if (!dirty) return ok;
    if (queued === 'flush') {
      void this.saveNow(true);
      return ok;
    }
    if (this.autosave || queued === 'schedule') this.schedule();
    return ok;
  }
}

/** Code-point length, so a max does not split a surrogate pair. */
export function truncateCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max).join('');
}

/** Newlines and non-breaking spaces, applied when a multiline value is saved. */
export function normalizeMultiline(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
}

/** Single-line titles: newlines are spaces, then the same cleanup. */
export function normalizeSingleLine(text: string): string {
  return normalizeMultiline(text).replace(/\n/g, ' ');
}
