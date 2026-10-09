import { AppError, BROWSER_USER_CONTROL_IDLE_MS } from '@kepcup/shared';

/**
 * Electron-free parts of W8（todo/borrowings-from-personal-agents.md W8）, unit
 * tested in place:
 * - the per-page control lease (自动接管): a click or key press of the user in
 *   the visible viewer window hands the page to the user; the bot's actions
 *   are refused (BROWSER_USER_CONTROL, phase 'pre') until the user hands it
 *   back — toolbar button, closing the viewer, or BROWSER_USER_CONTROL_IDLE_MS
 *   without any input;
 * - profile key → Electron partition (共享浏览器资料) and its directory name;
 * - the viewer toolbar page (strings come from the renderer's i18n).
 */

export type PageControl = 'agent' | 'user';
export type HandbackReason = 'button' | 'viewer_closed' | 'idle';

export interface LeaseTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: LeaseTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One page's control lease. `userInput` is fed by the page's input events
 * (only while the viewer is open — the host checks); `onChange` reports every
 * transition, with the reason on a handback.
 */
export class ControlLease {
  #control: PageControl = 'agent';
  #lastInput = 0;
  #timer: unknown = null;
  #botInputs = 0;
  #disposed = false;
  readonly #idleMs: number;
  readonly #timers: LeaseTimers;
  readonly #onChange: (control: PageControl, reason: HandbackReason | null) => void;

  constructor(options: {
    onChange: (control: PageControl, reason: HandbackReason | null) => void;
    idleMs?: number;
    timers?: LeaseTimers;
  }) {
    this.#onChange = options.onChange;
    this.#idleMs = options.idleMs ?? BROWSER_USER_CONTROL_IDLE_MS;
    this.#timers = options.timers ?? realTimers;
  }

  get control(): PageControl {
    return this.#control;
  }

  /**
   * Input the bot itself synthesizes over CDP (browser_press key events, the
   * scroll wheel) may surface as page input events: while one is in flight,
   * input is not attributed to the user.
   */
  async withBotInput<T>(run: () => Promise<T>): Promise<T> {
    this.#botInputs += 1;
    try {
      return await run();
    } finally {
      this.#botInputs -= 1;
    }
  }

  /**
   * A user input event in the viewer: `takeover` (mouse down / key down)
   * hands the page to the user; `activity` (move, wheel, key up) only keeps
   * an existing user lease alive. Returns true when this input took over.
   */
  userInput(kind: 'takeover' | 'activity'): boolean {
    if (this.#disposed || this.#botInputs > 0) return false;
    if (kind === 'activity') {
      if (this.#control === 'user') this.#lastInput = this.#timers.now();
      return false;
    }
    this.#lastInput = this.#timers.now();
    if (this.#control === 'user') return false;
    this.#control = 'user';
    this.#arm(this.#idleMs);
    this.#onChange('user', null);
    return true;
  }

  /** Back to the bot (button / viewer closed / idle). False when the bot already had it. */
  handBack(reason: HandbackReason): boolean {
    if (this.#disposed || this.#control !== 'user') return false;
    this.#clear();
    this.#control = 'agent';
    this.#onChange('agent', reason);
    return true;
  }

  /** The page is gone: no timer, no further callbacks. */
  dispose(): void {
    this.#disposed = true;
    this.#clear();
    this.#control = 'agent';
  }

  /** Throws BROWSER_USER_CONTROL (phase 'pre': nothing was dispatched) while the user has the page. */
  assertAgent(): void {
    if (this.#control === 'user') throw userControlError();
  }

  #arm(delay: number): void {
    this.#clear();
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = null;
      if (this.#disposed || this.#control !== 'user') return;
      const idle = this.#timers.now() - this.#lastInput;
      if (idle >= this.#idleMs) this.handBack('idle');
      else this.#arm(this.#idleMs - idle);
    }, delay);
  }

  #clear(): void {
    if (this.#timer !== null) this.#timers.clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export function userControlError(): AppError {
  return new AppError(
    'BROWSER_USER_CONTROL',
    '用户正在浏览器窗口里操作这个页面，Bot 的动作暂停，等用户交还',
    { phase: 'pre' },
  );
}

const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'Fn',
  'OS',
]);

/** Reading / scrolling keys: without modifiers they only look, never act. */
const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/**
 * `before-input-event` → takeover / activity / ignored. A key press (key
 * down) takes over, except: a lone modifier, an unmodified navigation key
 * (arrows, PageUp/PageDown, Home/End) and copy (Ctrl/Cmd+C) — those, like
 * key up, only count as activity.
 */
export function classifyKeyInput(input: {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}): 'takeover' | 'activity' | null {
  if (input.type === 'keyDown' || input.type === 'rawKeyDown') {
    if (MODIFIER_KEYS.has(input.key)) return 'activity';
    const modified =
      input.control === true || input.meta === true || input.alt === true || input.shift === true;
    if (!modified && NAVIGATION_KEYS.has(input.key)) return 'activity';
    const copy =
      (input.control === true || input.meta === true) &&
      input.alt !== true &&
      input.key.toLowerCase() === 'c';
    return copy ? 'activity' : 'takeover';
  }
  if (input.type === 'keyUp' || input.type === 'char') return 'activity';
  return null;
}

/**
 * `before-mouse-event` → takeover / activity / ignored. Only a button press
 * takes over; moving, scrolling or resizing never does (W8 风险：只是看看).
 */
export function classifyMouseInput(mouse: { type: string }): 'takeover' | 'activity' | null {
  switch (mouse.type) {
    case 'mouseDown':
    case 'contextMenu':
      return 'takeover';
    case 'mouseUp':
    case 'mouseMove':
    case 'mouseWheel':
      return 'activity';
    default:
      return null;
  }
}

// --- profiles → partitions (W8 B) ----------------------------------------------

const PROFILE_KEY = /^(bot|shared):([A-Za-z0-9_-]{1,64})$/;

export interface ParsedProfileKey {
  kind: 'bot' | 'shared';
  id: string;
  /** Electron session partition (`persist:` = on disk). */
  partition: string;
}

/** `bot:{botId}` → `persist:bot-{botId}`; `shared:{id}` → `persist:shared-{id}`. */
export function parseProfileKey(profileKey: string): ParsedProfileKey {
  const match = PROFILE_KEY.exec(profileKey);
  if (match === null) throw new AppError('INVALID_INPUT', `无效的浏览器资料：${profileKey}`);
  const kind = match[1] as 'bot' | 'shared';
  const id = match[2] as string;
  return { kind, id, partition: `persist:${kind}-${id}` };
}

/**
 * Directory of a persistent partition under `{sessionData}/Partitions/`:
 * Electron lower-cases (and query-escapes) the partition name — ids are
 * `[A-Za-z0-9_-]`, which escaping leaves alone.
 */
export function partitionDirName(partition: string): string {
  return partition.replace(/^persist:/, '').toLowerCase();
}

// --- viewer toolbar ---------------------------------------------------------------

/** Toolbar copy, localized in the renderer and passed through browser:show. */
export interface ViewerLabels {
  /** Shown while the bot has the page (how to take over). */
  agent: string;
  /** Shown while the user has the page. */
  user: string;
  /** The handback button. */
  handback: string;
}

export const DEFAULT_VIEWER_LABELS: ViewerLabels = {
  agent: 'Bot 正在使用此页面 · 在页面里点击或键入即可接管',
  user: '你正在操作',
  handback: '交还给 Bot',
};

/** Validates labels from the renderer (strings, bounded); falls back per field. */
export function parseViewerLabels(value: unknown): ViewerLabels {
  const source =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const pick = (key: keyof ViewerLabels): string => {
    const raw = source[key];
    return typeof raw === 'string' && raw.trim().length > 0 && raw.length <= 200
      ? raw
      : DEFAULT_VIEWER_LABELS[key];
  };
  return { agent: pick('agent'), user: pick('user'), handback: pick('handback') };
}

/** Title prefix the toolbar page sets when its handback button is clicked. */
export const HANDBACK_TITLE_PREFIX = 'kepcup:handback:';

/** Height of the toolbar strip above the page in the viewer window. */
export const VIEWER_TOOLBAR_HEIGHT = 36;

/**
 * The toolbar page (loaded as a data: URL into its own view). No IPC: the
 * button announces itself by setting `document.title`, which the host sees
 * as `page-title-updated`. Labels go in as JSON (`<` escaped) and are set via
 * textContent — never parsed as HTML.
 */
export function viewerToolbarHtml(labels: ViewerLabels, control: PageControl): string {
  const data = JSON.stringify({ labels, control, prefix: HANDBACK_TITLE_PREFIX }).replace(
    /</g,
    '\\u003c',
  );
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%}
body{display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box;font:13px system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4f4f5;color:#3f3f46;border-bottom:1px solid #d4d4d8;user-select:none}
body.user{background:#fef3c7;color:#78350f;border-bottom-color:#f59e0b;font-weight:600}
#label{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
button{font:inherit;font-weight:600;padding:4px 12px;border-radius:6px;border:1px solid #b45309;background:#fff;color:#92400e;cursor:pointer}
button[hidden]{display:none}
@media (prefers-color-scheme: dark){body{background:#27272a;color:#d4d4d8;border-bottom-color:#3f3f46}body.user{background:#451a03;color:#fde68a;border-bottom-color:#b45309}button{background:#78350f;color:#fef3c7;border-color:#f59e0b}}
</style></head><body data-control="">
<span id="label"></span><button id="handback" type="button" hidden></button>
<script>
var d=${data};
document.body.className=d.control;document.body.setAttribute('data-control',d.control);
document.getElementById('label').textContent=d.control==='user'?d.labels.user:d.labels.agent;
var b=document.getElementById('handback');b.textContent=d.labels.handback;b.hidden=d.control!=='user';
b.addEventListener('click',function(){document.title=d.prefix+Date.now();});
</script></body></html>`;
}

export function viewerToolbarUrl(labels: ViewerLabels, control: PageControl): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(viewerToolbarHtml(labels, control))}`;
}
