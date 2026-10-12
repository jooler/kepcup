/**
 * D87 P3c 基准用的 S2 预览服务：在真实 Electron 里起一个 `WidgetPreviewHost`，经 stdin / stdout
 * 收发 JSON 行（`{id, input}` → `{id, output}` / `{id, error}`），让跑在 Node 里的 core（基准评测）
 * 用上真实的预览宿主。由 `apps/desktop/scripts/widget-preview-server.mjs` 打包并启动；stdin 关闭即退出。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { app } from 'electron';
import { widgetPreviewRunInputSchema } from '@kepcup/shared';
import { registerAppsUiScheme } from '../../src/main/apps-ui';
import { WidgetPreviewHost } from '../../src/main/widget-preview';

registerAppsUiScheme();
const scratch = mkdtempSync(path.join(os.tmpdir(), 'kepcup-wp-server-'));
app.setPath('userData', path.join(scratch, 'userData'));
app.on('window-all-closed', () => {});

const send = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

void app.whenReady().then(() => {
  const host = new WidgetPreviewHost({
    tempRoot: scratch,
    log: (message, error) =>
      process.stderr.write(
        `[widget-preview] ${message}${error instanceof Error ? ` — ${error.message}` : ''}\n`,
      ),
  });
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let request: { id?: unknown; input?: unknown };
    try {
      request = JSON.parse(line) as { id?: unknown; input?: unknown };
    } catch {
      return;
    }
    const id = request.id;
    void (async () => {
      try {
        const output = await host.run(widgetPreviewRunInputSchema.parse(request.input));
        send({ id, output });
      } catch (error) {
        send({ id, error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
  lines.on('close', () => {
    host.dispose();
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
    app.exit(0);
  });
  send({ ready: true });
});
