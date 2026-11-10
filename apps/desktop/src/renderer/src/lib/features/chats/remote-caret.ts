import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { RemoteCaret } from './remote-caret-model';

export type { RemoteCaret } from './remote-caret-model';

/**
 * 远端光标（D121，docs/design/57-multi-client-collaboration.md §5）。
 *
 * 只有共享草稿的租约持有者上报 selection（ProseMirror 文档位置 + docVersion）；
 * 读端在版本一致时用 Decoration 绘制彩色光标与名字标签。位置经事务重新映射，
 * 文档替换（setContent）后由调用方清空 / 重设。
 */

export const remoteCaretPluginKey = new PluginKey<RemoteCaret | null>('kepcupRemoteCaret');

function clamp(pos: number, size: number): number {
  return Math.min(Math.max(pos, 1), Math.max(size, 1));
}

function caretElement(caret: RemoteCaret): HTMLElement {
  const root = document.createElement('span');
  root.className = 'kepcup-remote-caret';
  root.style.display = 'inline-block';
  root.style.position = 'relative';
  root.style.width = '0';
  root.style.height = '1.1em';
  root.style.borderLeft = `2px solid ${caret.color}`;
  root.style.marginLeft = '-1px';
  root.style.verticalAlign = 'text-bottom';
  root.style.pointerEvents = 'none';

  const label = document.createElement('span');
  label.className = 'kepcup-remote-caret-label';
  label.textContent = caret.name;
  label.style.position = 'absolute';
  label.style.left = '-2px';
  label.style.bottom = '100%';
  label.style.padding = '0 4px';
  label.style.borderRadius = '3px';
  label.style.backgroundColor = caret.color;
  label.style.color = '#fff';
  label.style.fontSize = '10px';
  label.style.lineHeight = '14px';
  label.style.whiteSpace = 'nowrap';
  label.style.pointerEvents = 'none';
  root.appendChild(label);
  return root;
}

export const RemoteCaretExtension = Extension.create({
  name: 'kepcupRemoteCaret',
  addProseMirrorPlugins() {
    return [
      new Plugin<RemoteCaret | null>({
        key: remoteCaretPluginKey,
        state: {
          init: () => null,
          apply: (transaction, value) => {
            const meta = transaction.getMeta(remoteCaretPluginKey) as
              RemoteCaret | null | undefined;
            if (meta !== undefined) return meta;
            if (value === null || !transaction.docChanged) return value;
            return {
              ...value,
              anchor: transaction.mapping.map(value.anchor),
              head: transaction.mapping.map(value.head),
            };
          },
        },
        props: {
          decorations(state) {
            const caret = remoteCaretPluginKey.getState(state);
            if (caret === null || caret === undefined) return null;
            const size = state.doc.content.size;
            const anchor = clamp(caret.anchor, size);
            const head = clamp(caret.head, size);
            const decorations: Decoration[] = [];
            if (anchor !== head) {
              decorations.push(
                Decoration.inline(Math.min(anchor, head), Math.max(anchor, head), {
                  style: `background-color: ${caret.color}22`,
                }),
              );
            }
            decorations.push(Decoration.widget(head, () => caretElement(caret), { side: 1 }));
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export function setRemoteCaret(editor: Editor, caret: RemoteCaret | null): void {
  editor.view.dispatch(editor.state.tr.setMeta(remoteCaretPluginKey, caret));
}
