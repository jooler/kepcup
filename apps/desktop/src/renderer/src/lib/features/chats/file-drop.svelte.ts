/**
 * 父视图级文件拖拽附加：Composer 输入坞只占屏幕一角，拖文件进对话要求精确
 * 瞄准输入框。这里把「拖文件到视图任意位置 = 附加附件」收敛成一个可复用的
 * 事件处理器组（ChatView / ProjectView / TaskRunView 的根元素接线），上传链路
 * 与输入坞药丸自身拖入一致——都落到 composerDrafts.uploadFiles，待发送 chips
 * 仍由输入坞渲染；调用方只负责门禁（enabled）与目标键（onFiles）。
 *
 * 事件约定：
 * - 是否文件拖拽看 `dataTransfer.types` 是否含 'Files'——看板卡片等页面内部
 *   拖拽没有 Files，不受影响；dragover 必须 preventDefault 才能触发 drop，
 *   顺带拦掉浏览器 / Electron 对拖入文件的默认处理。
 * - drop 让位已处理的嵌套 drop 区（输入坞药丸先于父视图收到事件，已
 *   preventDefault 时父视图不再处理）：拖到药丸上附件归当前会话 / 卡片会话，
 *   拖到视图其它区域附件归父视图目标。
 * - dragActive 用 dragover 心跳维持（提示浮层据此显隐），dragleave 只在
 *   relatedTarget 离开根元素时收尾；拖拽被取消 / 光标移进 portal 浮层时由
 *   心跳超时兜底复位（无 DOM 场景单测可用普通对象冒充事件）。
 */

/** 拖拽数据是否携带文件（OS 文件拖拽 types 含 'Files'；内部卡片拖拽没有）。 */
export function dragCarriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}

/** 心跳超时：dragover 停止多久后收起提示（Chromium 拖拽中约 350ms 一拍）。 */
const DRAG_HEARTBEAT_MS = 600;

/** createFileDropZone 的事件处理器组：直接绑到视图根元素上。 */
export interface FileDropZone {
  /** 文件正拖在视图上方（提示浮层据此显隐）。 */
  readonly dragActive: boolean;
  onDragOver(event: DragEvent): void;
  onDragLeave(event: DragEvent): void;
  onDrop(event: DragEvent): void;
}

export function createFileDropZone(input: {
  /**
   * 当前能否收附件（getter，视图的响应式门禁在这里重算）：false 时不提示也
   * 不上传，但对文件拖拽仍拦默认行为（不让 Electron 拿文件做任何事）。
   */
  enabled: () => boolean;
  /** 命中上传：FileList 与输入坞药丸 drop / 粘贴同源，由调用方选目标键。 */
  onFiles: (files: FileList) => void;
}): FileDropZone {
  let dragActive = $state(false);
  let heartbeat: ReturnType<typeof setTimeout> | null = null;

  const hide = (): void => {
    if (heartbeat !== null) {
      clearTimeout(heartbeat);
      heartbeat = null;
    }
    dragActive = false;
  };

  // 组件卸载清掉心跳定时器（fire 也无害，收干净）。
  $effect(() => () => hide());

  return {
    get dragActive() {
      return dragActive;
    },
    onDragOver(event) {
      if (!dragCarriesFiles(event)) return;
      // drop 能触发的前提；即便本区域不收附件也不让默认行为发生。
      event.preventDefault();
      if (!input.enabled()) return;
      dragActive = true;
      if (heartbeat !== null) clearTimeout(heartbeat);
      heartbeat = setTimeout(hide, DRAG_HEARTBEAT_MS);
    },
    onDragLeave(event) {
      if (!dragActive) return;
      const root = event.currentTarget;
      const related = event.relatedTarget;
      // 根元素内部子元素间移动也会触发 dragleave：relatedTarget 仍在根内不算
      // 离开（contains 用鸭子类型探测，测试环境没有 DOM 全局）。
      if (
        root !== null &&
        related !== null &&
        typeof (root as Element).contains === 'function' &&
        (root as Element).contains(related as Node)
      ) {
        return;
      }
      hide();
    },
    onDrop(event) {
      hide();
      if (!dragCarriesFiles(event)) return;
      // 输入坞（或其它嵌套 drop 区）已处理：target 先于冒泡，这里让位——但
      // 默认行为仍拦掉（保持与嵌套区一致）。
      const alreadyHandled = event.defaultPrevented;
      event.preventDefault();
      if (alreadyHandled || !input.enabled()) return;
      const files = event.dataTransfer?.files;
      if (files !== undefined && files.length > 0) input.onFiles(files);
    },
  };
}
