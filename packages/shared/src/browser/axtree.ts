/**
 * Accessibility.getFullAXTree → snapshot summary (docs/dev/phases/
 * P11-browser.md 任务 3): interactive elements get short refs (`e12`) valid
 * until the next snapshot, plus the page title/URL (fetched separately) and
 * the main text, all bounded. Pure function — the caller keeps the
 * ref → backendNodeId mapping for click/type.
 */

/** Subset of a CDP AXNode we consume (extra fields are ignored). */
export interface AxtreeNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  /** AX properties (checked, expanded, selected, pressed, …). */
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  backendDOMNodeId?: number;
}

export interface SnapshotElement {
  ref: string;
  role: string;
  /** Accessible name, trimmed; long names are cut (element list budget). */
  name: string;
}

export interface SnapshotOptions {
  maxElements: number;
  maxTextChars: number;
  /** Max characters of one element's accessible name. */
  maxNameChars?: number;
}

export interface SnapshotSummary {
  elements: SnapshotElement[];
  /** True when the element list hit the cap (a note is appended by the caller). */
  elementsTruncated: boolean;
  /** Interactive elements beyond the cap (W1 截断提示「还有 N 个元素未列出」). */
  elementsOmitted: number;
  text: string;
  textTruncated: boolean;
  /** ref → backendDOMNodeId for every emitted element. */
  refs: Map<string, number>;
}

/** Roles the model can act on (click / type / select). */
const INTERACTIVE_ROLES = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'slider',
  'spinbutton',
  'listbox',
  'option',
  'switch',
]);

const TEXT_ROLES = new Set(['text', 'StaticText', 'statictext', 'heading', 'paragraph', 'cell', 'listitem']);

const FALLBACK_NAME_CHARS = 80;

/**
 * Builds the snapshot summary from a full AX tree. Elements are emitted in
 * document order, skipping ignored nodes and duplicate backend nodes; refs
 * restart at `e1` on every snapshot (valid until the next one, enforced by
 * the host clearing the ref table).
 */
export function buildSnapshotSummary(nodes: AxtreeNode[], options: SnapshotOptions): SnapshotSummary {
  const maxNameChars = options.maxNameChars ?? FALLBACK_NAME_CHARS;
  const elements: SnapshotElement[] = [];
  const refs = new Map<string, number>();
  const textParts: string[] = [];
  let textChars = 0;
  let textTruncated = false;
  let elementsOmitted = 0;
  let seenNodeIds: Set<string> | null = null;

  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = node.role?.value ?? '';
    if (role.length === 0) continue;
    const name = (node.name?.value ?? '');
    const nameText = typeof name === 'string' ? name.trim() : '';

    if (INTERACTIVE_ROLES.has(role) && typeof node.backendDOMNodeId === 'number') {
      if (elements.length < options.maxElements) {
        if (seenNodeIds === null) seenNodeIds = new Set();
        if (!seenNodeIds.has(node.nodeId)) {
          seenNodeIds.add(node.nodeId);
          const ref = `e${elements.length + 1}`;
          elements.push({
            ref,
            role,
            name: nameText.length > maxNameChars ? `${nameText.slice(0, maxNameChars)}…` : nameText,
          });
          refs.set(ref, node.backendDOMNodeId);
        }
      } else if (seenNodeIds === null || !seenNodeIds.has(node.nodeId)) {
        if (seenNodeIds === null) seenNodeIds = new Set();
        seenNodeIds.add(node.nodeId);
        elementsOmitted += 1;
      }
      continue;
    }

    // Page text: static content only, bounded as we go.
    if (TEXT_ROLES.has(role) && nameText.length > 0 && !textTruncated) {
      const remaining = options.maxTextChars - textChars;
      if (remaining <= 0) {
        textTruncated = true;
        continue;
      }
      const piece = nameText.length > remaining ? nameText.slice(0, remaining) : nameText;
      if (piece.length < nameText.length) textTruncated = true;
      textChars += piece.length;
      textParts.push(piece);
    }
  }

  return {
    elements,
    elementsTruncated: elements.length >= options.maxElements,
    elementsOmitted,
    text: textParts.join('\n'),
    textTruncated,
    refs,
  };
}

/**
 * Renders the snapshot summary for the model (the caller wraps it with the
 * `<untrusted>` boundary). Refs are documented as short-lived so the model
 * re-snapshots instead of guessing.
 */
export function formatSnapshot(
  summary: Pick<SnapshotSummary, 'elements' | 'elementsTruncated' | 'text' | 'textTruncated'> & {
    elementsOmitted?: number | undefined;
  },
  meta: { title: string; url: string },
): string {
  const lines: string[] = [];
  lines.push(`页面：${meta.title || '（无标题）'}`);
  lines.push(`URL：${meta.url}`);
  if (summary.elements.length > 0) {
    lines.push('可交互元素（引用在下次快照前有效）：');
    for (const el of summary.elements) {
      lines.push(`- [${el.ref}] ${el.role}${el.name ? ` “${el.name}”` : ''}`);
    }
  } else {
    lines.push('可交互元素：无');
  }
  if (summary.elementsTruncated) {
    const omitted = summary.elementsOmitted ?? 0;
    lines.push(
      omitted > 0
        ? `（元素列表已达上限 ${summary.elements.length} 个：还有 ${omitted} 个元素未列出，可 browser_scroll 或缩小范围（关闭弹层、进入子页面）后再快照）`
        : `（元素列表已达上限 ${summary.elements.length} 个，可能还有元素未列出，可 browser_scroll 或缩小范围（关闭弹层、进入子页面）后再快照）`,
    );
  }
  lines.push('页面文本：');
  lines.push(summary.text || '（无文本）');
  if (summary.textTruncated) lines.push('（页面文本已截断）');
  return lines.join('\n');
}
