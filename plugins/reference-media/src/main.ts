import { definePlugin, host, runPluginRuntime } from '@kepcup/plugin-sdk';

/**
 * 参考媒体插件（D125 P1，todo P1 步骤 3）：media 契约的**假实现**——用于 P2 端到端、
 * 演示与开发者上手；不模拟网络、不调用厂商 API、不消耗任何外部资源。
 *
 * 打包：`node plugins/reference-media/build.mjs` → `dist/main.js`（esbuild 单文件 ESM，
 * 约定见 packages/plugin-sdk/README.md）。
 */

/** 内置 1×1 PNG（RGBA）的 data URL——generateImage 恒返回这一张。 */
const ONE_BY_ONE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 假视频任务：提交时刻起 3 秒后 succeeded。 */
const VIDEO_TASK_DURATION_MS = 3000;
const videoTasks = new Map<string, { startedAt: number; cancelled: boolean }>();
let videoTaskSeq = 0;

const plugin = definePlugin({
  contracts: {
    media: {
      // 与图片条目（reference-image）对应：两个进度事件（已排队 → 生成中），间隔
      // 1.1s 保证都能穿过 SDK 的 1 次/秒限速窗口，然后返回内置 1×1 PNG。
      async generateImage() {
        host.progress({ phase: 'queued', percent: 5, message: '任务已排队' });
        await delay(1100);
        host.progress({ phase: 'generating', percent: 60, message: '生成中' });
        await delay(1100);
        return { images: [{ url: ONE_BY_ONE_PNG_DATA_URL, mimeType: 'image/png' }] };
      },

      // 视频异步三方法（假任务）：submit → 3 秒后 succeeded；取消即刻 failed。
      async submitVideo() {
        const taskId = `ref-video-${++videoTaskSeq}`;
        videoTasks.set(taskId, { startedAt: Date.now(), cancelled: false });
        return { taskId };
      },
      async videoStatus(_ctx, handle) {
        const task = videoTasks.get(handle.taskId);
        if (task === undefined) {
          return { status: 'failed', error: `未知任务：${handle.taskId}` };
        }
        if (task.cancelled) {
          return { status: 'failed', error: '已被取消（参考假任务不产生视频）' };
        }
        if (Date.now() - task.startedAt < VIDEO_TASK_DURATION_MS) {
          return { status: 'running' };
        }
        return {
          status: 'succeeded',
          // 占位 URL：域名与 manifest runtime.network.allow 一致（example.invalid），
          // 明确不可达——产物下载与落附件在 core 侧（P2 端到端只断言状态迁移）。
          videoUrl: 'https://example.invalid/reference-video.mp4',
        };
      },
      async cancelVideo(_ctx, handle) {
        const task = videoTasks.get(handle.taskId);
        if (task !== undefined) task.cancelled = true;
      },
    },
  },
});

runPluginRuntime(plugin);
