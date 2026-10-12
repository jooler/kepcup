import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { WidgetPreviewRunInput, WidgetPreviewRunOutput } from '@kepcup/shared';

import {
  WIDGET_PREVIEW_UNAVAILABLE_REASON,
  runWidgetCheck,
} from '../../src/widgets/check/index.js';
import { createWidgetPreviewRpc, createWidgetPreviewRunner } from '../../src/widgets/preview.js';
import { WIDGET_SDK_MARKER } from '../../src/widgets/sdk-injection.js';
import { WIDGET_TEMPLATES } from '../../src/widgets/templates/index.js';

/**
 * S2 的 core 侧（D87 P3b）：延迟绑定的预览宿主句柄（未绑定 = skipped → unverified）、按视口
 * 注入垫片（该视口主题）与探针、宿主结果按规则注册表转成检查问题（级别 / 阻断 / 视口 / 触发）。
 */

const GOOD = WIDGET_TEMPLATES[0]!.html;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function draft(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'widget-preview-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

function viewport(
  width: number,
  theme: 'light' | 'dark',
  patch: Partial<WidgetPreviewRunOutput['viewports'][number]> = {},
): WidgetPreviewRunOutput['viewports'][number] {
  return {
    width,
    theme,
    status: 'ok',
    detail: '',
    findings: [],
    acceptance: [],
    outline: '',
    openedLinks: [],
    ...patch,
  };
}

describe('widget preview (core side)', () => {
  it('未绑定预览宿主 → S2 skipped（原因 = 未经运行验证）', async () => {
    const runner = createWidgetPreviewRunner({ rpc: createWidgetPreviewRpc() });
    const report = await runWidgetCheck({
      draftDir: draft({ 'index.html': GOOD }),
      validateQueries: () => null,
      preview: runner,
      now: 1,
    });
    expect(report.stages.S2).toEqual({
      status: 'skipped',
      reason: WIDGET_PREVIEW_UNAVAILABLE_REASON,
    });
  });

  it('按视口注入垫片（各自的主题）与探针；结果转成带视口与触发的检查问题', async () => {
    const rpc = createWidgetPreviewRpc();
    const requests: WidgetPreviewRunInput[] = [];
    rpc.bindFacade({
      run: async (input) => {
        requests.push(input);
        return {
          viewports: [
            viewport(360, 'light', {
              findings: [
                { rule: 'render.overflow-x', message: '内容比 360px 宽' },
                {
                  rule: 'runtime.error',
                  message: 'TypeError: x is null',
                  line: 40,
                  col: 3,
                  trigger: 'button#add 「添加」',
                },
              ],
              acceptance: [
                { id: 'click', must: true, passed: false, detail: '#status 文本是「已点击 0 次」' },
              ],
              outline: 'h3 标题\nbutton 操作',
              screenshot: 'iVBORw0KGgo=',
            }),
            viewport(720, 'dark', { findings: [{ rule: 'console.warn', message: 'careful' }] }),
          ],
        };
      },
    });
    const runner = createWidgetPreviewRunner({ rpc, screenshots: true });
    const report = await runWidgetCheck({
      draftDir: draft({ 'index.html': GOOD }),
      validateQueries: () => null,
      preview: runner,
      now: 1,
    });

    expect(requests).toHaveLength(1);
    const [light, dark] = requests[0]!.viewports;
    expect(light).toMatchObject({ width: 360, theme: 'light' });
    expect(dark).toMatchObject({ width: 720, theme: 'dark' });
    expect(light!.html).toContain(WIDGET_SDK_MARKER);
    expect(light!.html).toContain("currentTheme = 'light'");
    expect(dark!.html).toContain("currentTheme = 'dark'");
    // 注入不改行号：预览 HTML 与原文行数相同。
    expect(light!.html.split('\n')).toHaveLength(GOOD.split('\n').length);
    expect(requests[0]!.screenshots).toBe(true);
    expect(requests[0]!.budgetMs).toBeGreaterThan(0);

    expect(report.stages.S2.status).toBe('ran');
    const runtime = report.issues.find((issue) => issue.rule === 'runtime.error')!;
    expect(runtime).toMatchObject({
      level: 'error',
      blocking: true,
      stage: 'S2',
      line: 40,
      col: 3,
      trigger: 'button#add 「添加」',
      viewport: '360/light',
    });
    expect(report.issues.find((issue) => issue.rule === 'render.overflow-x')).toMatchObject({
      level: 'warning',
      blocking: false,
    });
    expect(report.issues.find((issue) => issue.rule === 'console.warn')?.viewport).toBe('720/dark');
    expect(report.acceptance).toEqual([
      expect.objectContaining({ id: 'click', passed: false, viewport: '360/light' }),
    ]);
    expect(report.verdict).toBe('blocked');
    expect(report.outline).toContain('button 操作');
    expect(runner.screenshots()).toEqual([{ mimeType: 'image/png', base64: 'iVBORw0KGgo=' }]);
  });

  it('组件进程崩溃记运行时错误；全部视口宿主自身出错 → S2 skipped（预览失败）', async () => {
    const rpc = createWidgetPreviewRpc();
    let output: WidgetPreviewRunOutput = {
      viewports: [viewport(360, 'light', { status: 'crashed' }), viewport(720, 'dark')],
    };
    rpc.bindFacade({ run: async () => output });
    const runner = createWidgetPreviewRunner({ rpc });
    const dir = draft({ 'index.html': GOOD });
    const crashed = await runWidgetCheck({
      draftDir: dir,
      validateQueries: () => null,
      preview: runner,
      now: 1,
    });
    expect(crashed.issues.find((issue) => issue.rule === 'runtime.error')?.message).toContain(
      '崩溃',
    );

    output = { viewports: [viewport(360, 'light', { status: 'failed', detail: 'shell gone' })] };
    const failed = await runWidgetCheck({
      draftDir: dir,
      validateQueries: () => null,
      preview: runner,
      now: 1,
    });
    expect(failed.stages.S2).toEqual({ status: 'skipped', reason: '预览失败：shell gone' });

    // 宿主自身出错的视口带回了阻断问题（例如主进程 console-message 兜到的未捕获异常）：照算，不放行。
    output = {
      viewports: [
        viewport(360, 'light', {
          status: 'failed',
          detail: 'probe never reported',
          findings: [{ rule: 'runtime.error', message: 'Uncaught TypeError', line: 9 }],
        }),
      ],
    };
    const check = () =>
      runWidgetCheck({ draftDir: dir, validateQueries: () => null, preview: runner, now: 1 });
    const failedWithFindings = await check();
    expect(failedWithFindings.verdict).toBe('blocked');
    expect(failedWithFindings.issues.find((i) => i.rule === 'runtime.error')?.line).toBe(9);

    // 只带回警告的半截预览不算「运行验证过」。
    output = {
      viewports: [
        viewport(360, 'light', {
          status: 'failed',
          findings: [{ rule: 'console.warn', message: 'w' }],
        }),
      ],
    };
    expect((await check()).stages.S2.status).toBe('skipped');
  });

  it('制作取消：本地放弃等待并抛出（检查器据 signal 透传，不当作 S2 结果）', async () => {
    const rpc = createWidgetPreviewRpc();
    rpc.bindFacade({ run: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const pending = runWidgetCheck({
      draftDir: draft({ 'index.html': GOOD }),
      validateQueries: () => null,
      preview: createWidgetPreviewRunner({ rpc }),
      now: 1,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
