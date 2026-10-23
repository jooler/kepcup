import {
  AppError,
  WIDGET_CHECK_TIMEOUT_MS,
  WIDGET_PREVIEW_MONKEY_MAX_ELEMENTS,
  WIDGET_PREVIEW_VIEWPORTS,
  widgetPreviewRunOutputSchema,
  type WidgetAcceptanceResult,
  type WidgetCheckIssue,
  type WidgetPreviewRunInput,
  type WidgetPreviewRunOutput,
} from '@kepcup/shared';
import {
  PREVIEW_OFFLINE_NETWORK_RULE_ID,
  WIDGET_PREVIEW_UNAVAILABLE_REASON,
  previewOfflineNetworkMessage,
  previewOfflineResourceLoadMessage,
  ruleIssue,
  type WidgetPreviewOutcome,
  type WidgetPreviewRunner,
} from './check/index.js';
import { injectPreviewProbe } from './preview-probe.js';
import { injectWidgetSdk } from './sdk-injection.js';

/**
 * S2 预览的 core 侧（D87 P3b，设计 32 §11.8.3 / §11.9）：
 *
 * - {@link createWidgetPreviewRpc}：主进程预览宿主（平台方法 `widgetPreview.run`）的延迟绑定
 *   句柄，写法同 `apps/shell-facade.ts`——Electron 里在端口 B 就绪时 `bind`，集成测试可
 *   `bindFacade` 注入假宿主；都没有（无界面装配）时 `available()` 为 false，S2 记 skipped →
 *   交付为 `unverified`。
 * - {@link createWidgetPreviewRunner}：检查器的 S2 适配——按视口注入垫片（该视口的主题）与
 *   预览探针（单行，行号与原文一致），调宿主，把结果按规则注册表转成检查问题。
 */

/** Minimal client surface (the shared RpcChannel satisfies it structurally). */
export interface WidgetPreviewRpcClient {
  call(method: string, input?: unknown): Promise<unknown>;
  rejectPending(reason: string): void;
}

export interface WidgetPreviewHostRpc {
  /** 预览宿主是否可用（端口 B 已绑定或注入了假宿主）。 */
  available(): boolean;
  run(input: WidgetPreviewRunInput): Promise<WidgetPreviewRunOutput>;
}

export type DeferredWidgetPreviewRpc = WidgetPreviewHostRpc & {
  bind(client: WidgetPreviewRpcClient | null): void;
  /** In-process implementation (integration test fakes); takes precedence over the port. */
  bindFacade(facade: Pick<WidgetPreviewHostRpc, 'run'> | null): void;
};

class DeferredPreviewRpc implements DeferredWidgetPreviewRpc {
  #client: WidgetPreviewRpcClient | null = null;
  #facade: Pick<WidgetPreviewHostRpc, 'run'> | null = null;

  bind(client: WidgetPreviewRpcClient | null): void {
    this.#client?.rejectPending('widget preview host disconnected');
    this.#client = client;
  }

  bindFacade(facade: Pick<WidgetPreviewHostRpc, 'run'> | null): void {
    this.#facade = facade;
  }

  available(): boolean {
    return this.#facade !== null || this.#client !== null;
  }

  async run(input: WidgetPreviewRunInput): Promise<WidgetPreviewRunOutput> {
    if (this.#facade !== null) {
      return widgetPreviewRunOutputSchema.parse(await this.#facade.run(input));
    }
    if (this.#client === null) {
      throw new AppError('INTERNAL', '组件预览宿主未连接');
    }
    return widgetPreviewRunOutputSchema.parse(await this.#client.call('widgetPreview.run', input));
  }
}

/** The unbound-by-default handle used until the process entry binds the platform port. */
export function createWidgetPreviewRpc(): DeferredWidgetPreviewRpc {
  return new DeferredPreviewRpc();
}

/** 截图（只在自查时要；GATE 的报告只存文本）。 */
export interface WidgetPreviewImage {
  mimeType: string;
  base64: string;
}

export interface WidgetPreviewRunnerHandle extends WidgetPreviewRunner {
  /** 最近一次运行回传的截图（screenshots=true 时）。 */
  screenshots(): WidgetPreviewImage[];
}

/** 视口标签（报告里「出现在哪个视口」）。 */
function viewportLabel(width: number, theme: string): string {
  return `${width}/${theme}`;
}

/** 宿主自己的状态 → 额外的问题（超时由宿主随结果给出 preview.timeout；崩溃记运行时错误）。 */
function statusIssue(status: string, detail: string, viewport: string): WidgetCheckIssue | null {
  if (status === 'crashed') {
    return ruleIssue('runtime.error', {
      message: `组件进程崩溃${detail !== '' ? `：${detail}` : ''}`,
      viewport,
    });
  }
  return null;
}

export function createWidgetPreviewRunner(input: {
  rpc: WidgetPreviewHostRpc;
  screenshots?: boolean;
  /** 给宿主的总预算（含排队，缺省 WIDGET_CHECK_TIMEOUT_MS）：宿主据此不跑调用方已等不及的视口。 */
  budgetMs?: number;
}): WidgetPreviewRunnerHandle {
  let images: WidgetPreviewImage[] = [];
  return {
    screenshots: () => images,
    run: async ({ html, acceptance, fixtures, signal }) => {
      images = [];
      if (!input.rpc.available()) return { skipped: WIDGET_PREVIEW_UNAVAILABLE_REASON };
      const request: WidgetPreviewRunInput = {
        viewports: WIDGET_PREVIEW_VIEWPORTS.map((viewport) => ({
          width: viewport.width,
          theme: viewport.theme,
          html: injectPreviewProbe(injectWidgetSdk(html, { theme: viewport.theme })),
        })),
        acceptance,
        fixtures,
        monkeyMax: WIDGET_PREVIEW_MONKEY_MAX_ELEMENTS,
        screenshots: input.screenshots === true,
        budgetMs: input.budgetMs ?? WIDGET_CHECK_TIMEOUT_MS,
      };
      const output = await untilAborted(input.rpc.run(request), signal);
      const ran = output.viewports.filter((viewport) => viewport.status !== 'failed');

      const issues: WidgetCheckIssue[] = [];
      const acceptanceResults: WidgetAcceptanceResult[] = [];
      // 宿主自身出错（failed）的视口不算「跑过」，但它带回的问题（如主进程 console-message
      // 兜到的未捕获异常）照样要算——组件就算弄坏了探针也不能因此被放行。
      for (const viewport of output.viewports) {
        const label = viewportLabel(viewport.width, viewport.theme);
        const extra = statusIssue(viewport.status, viewport.detail, label);
        if (extra !== null) issues.push(extra);
        for (const finding of viewport.findings) {
          // 预览宿主离线（防未经确认的代码出网）：组件的联网请求 / 外链资源加载必然失败，归到
          // preview.offline-network（warning，非阻断），不算组件缺陷。资源加载失败只有 http(s)
          // 外链算离线产物——相对路径的失败是真实缺陷（S0 已有阻断项），照常上报。
          const offline =
            previewOfflineNetworkMessage(finding.message) ||
            (finding.rule === 'console.error' && previewOfflineResourceLoadMessage(finding.message));
          if (
            (finding.rule === 'runtime.error' ||
              finding.rule === 'runtime.rejection' ||
              finding.rule === 'csp.violation' ||
              finding.rule === 'console.error') &&
            offline
          ) {
            issues.push(
              ruleIssue(PREVIEW_OFFLINE_NETWORK_RULE_ID, {
                message: `组件的联网请求在预览里失败（正式运行时可联网）：${finding.message}`,
                viewport: label,
              }),
            );
            continue;
          }
          issues.push(
            ruleIssue(finding.rule, {
              message: finding.message,
              ...(finding.line !== undefined ? { line: finding.line } : {}),
              ...(finding.col !== undefined ? { col: finding.col } : {}),
              ...(finding.trigger !== undefined ? { trigger: finding.trigger } : {}),
              viewport: label,
            }),
          );
        }
        for (const item of viewport.acceptance) {
          acceptanceResults.push({ ...item, viewport: label });
        }
        if (viewport.screenshot !== undefined) {
          images.push({ mimeType: 'image/png', base64: viewport.screenshot });
        }
      }
      // 没有一个视口真正跑完：只有带回了阻断项（组件确实有错）才当作结果；否则如实记 skipped
      // （不能把半截的预览当成「运行验证过」）。
      if (ran.length === 0 && !issues.some((issue) => issue.blocking)) {
        const detail = output.viewports.map((viewport) => viewport.detail).find((d) => d !== '');
        images = [];
        return { skipped: `预览失败：${detail ?? '预览宿主没有返回结果'}` };
      }
      const outcome: WidgetPreviewOutcome = {
        issues,
        acceptance: acceptanceResults,
        outline: output.viewports.find((viewport) => viewport.outline !== '')?.outline ?? '',
      };
      return outcome;
    },
  };
}

/** 本地放弃等待（远端预览按自己的时限结束；串行队列里的下一个照常）。 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(new Error('preview aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('preview aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
