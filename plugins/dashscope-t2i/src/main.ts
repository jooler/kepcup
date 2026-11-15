import {
  definePlugin,
  host,
  PluginInvokeError,
  runPluginRuntime,
  type HostNetResponse,
} from '@kepcup/plugin-sdk';

/**
 * 百炼文生图执行型试点（D125 P4，todo/plugin-runtime/P4-governance-pilot.md 步骤 3）。
 *
 * 协议与内置 dashscope 引擎同源但**在插件内重新实现**（A/B dogfood 执行型运行时）：
 * wan 系列异步文生图 `POST /api/v1/services/aigc/text2image/image-synthesis`
 * （`X-DashScope-Async: enable`，prompt 在顶层 `input.prompt`）拿 `task_id` →
 * `GET /api/v1/tasks/{task_id}` 2s 轮询，状态 PENDING / RUNNING → SUCCEEDED / FAILED。
 * 产物只返回厂商 URL；下载与落附件永远在 core 侧（61 §3.2）。
 *
 * 边界：网络只走 `host.net.fetch`（清单白名单 dashscope.aliyuncs.com，SSRF 由宿主
 * 守卫）；API Key 来自实例敏感字段（`runtime.instanceFields`，调用时注入
 * `ctx.credentials`，插件不落盘、不打日志）；取消只尽快返回，不调用删除接口
 * （服务端任务自然过期）。
 */

const API_BASE = 'https://dashscope.aliyuncs.com';
const SUBMIT_PATH = '/api/v1/services/aigc/text2image/image-synthesis';
const POLL_INTERVAL_MS = 2_000;
/** 自设等待上限：图片契约超时 120s（61 §3.1），留 10s 余量给错误回传。 */
const MAX_WAIT_MS = 110_000;
const DEFAULT_SIZE = '1024*1024';
const DEFAULT_N = 1;

interface DashscopeOutput {
  task_id?: string;
  task_status?: string;
  results?: Array<{ url?: string }>;
  code?: string;
  message?: string;
}

interface DashscopeBody {
  code?: string;
  message?: string;
  output?: DashscopeOutput;
  request_id?: string;
}

function parseJson(text: string): DashscopeBody {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === 'object' ? (value as DashscopeBody) : {};
  } catch {
    return {};
  }
}

/** 配额 / 欠费关键词（与 media/http.ts 的错误族口径一致，c0bf9168）。 */
const QUOTA_PATTERN = /quota|balance|arrears|insufficient|exceed|欠费|额度|余额|配额|超出/i;
const AUTH_PATTERN = /invalidapikey|unauthorized|authentication|api\s*key|鉴权|认证/i;

/**
 * DashScope HTTP / 任务失败 → `PROVIDER_*`（61 §5）：
 * 401 → AUTH_FAILED；402 或配额词 → QUOTA；429 → RATE_LIMITED；其余 → UNAVAILABLE。
 */
function providerError(status: number, code: string | undefined, message: string): never {
  const detail =
    message.length > 0 ? message : code !== undefined && code.length > 0 ? code : `HTTP ${status}`;
  if (status === 401 || AUTH_PATTERN.test(code ?? '') || AUTH_PATTERN.test(detail)) {
    throw new PluginInvokeError('PROVIDER_AUTH_FAILED', `百炼鉴权失败：${detail}`);
  }
  if (status === 402 || QUOTA_PATTERN.test(code ?? '') || QUOTA_PATTERN.test(detail)) {
    throw new PluginInvokeError('PROVIDER_QUOTA', `百炼账户额度不足：${detail}`);
  }
  if (status === 429) {
    throw new PluginInvokeError('PROVIDER_RATE_LIMITED', `百炼请求过于频繁：${detail}`);
  }
  throw new PluginInvokeError('PROVIDER_UNAVAILABLE', `百炼文生图失败：${detail}`);
}

/** 一次宿主代理请求：网络失败归一 UNAVAILABLE；非 2xx 走错误映射。 */
async function dashscope(
  apiKey: string,
  pathAndQuery: string,
  init?: { method?: string; body?: string },
): Promise<DashscopeBody> {
  let response: HostNetResponse;
  try {
    response = await host.net.fetch(`${API_BASE}${pathAndQuery}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body !== undefined
          ? { 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' }
          : {}),
      },
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    throw new PluginInvokeError(
      'PROVIDER_UNAVAILABLE',
      code === 'PLUGIN_NETWORK_DENIED'
        ? `百炼域名被宿主网络白名单拒绝：${message}`
        : `无法连接百炼服务：${message}`,
    );
  }
  const text = await response.text();
  const body = parseJson(text);
  if (!response.ok) {
    providerError(response.status, body.code, body.message ?? '');
  }
  return body;
}

/**
 * 可取消的等待：abort 后立即 resolve，由调用方决定「尽快返回」。正常到时也要摘掉
 * abort 监听——长时间轮询（110s / 2s ≈ 55 次）不清理会累积监听器并触发
 * MaxListenersExceededWarning（本轮审查发现）。
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function intParam(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

const plugin = definePlugin({
  contracts: {
    media: {
      async generateImage(ctx, params) {
        const apiKey = ctx.credentials['apiKey'];
        if (apiKey === undefined || apiKey.length === 0) {
          throw new PluginInvokeError(
            'PROVIDER_AUTH_FAILED',
            '百炼 API Key 未配置：请在插件详情的账号实例里填写后再试',
          );
        }
        // 试点只实现文生图：wan 异步 text2image 端点不接受参考图，显式拒绝而不是
        // 静默丢弃（图生图 / 编辑走内置 qwen-image 引擎）。
        if ((params.images?.length ?? 0) > 0) {
          throw new PluginInvokeError(
            'PROVIDER_UNAVAILABLE',
            '百炼文生图试点的条目只支持纯文生图，不接受参考图；图生图 / 编辑请使用内置 qwen-image 条目',
          );
        }
        // 条目 params 是清单默认值（size / n），工具显式传参优先。
        const size = (params.size ?? stringParam(ctx.params['size']) ?? DEFAULT_SIZE).replace(
          /x/g,
          '*',
        );
        const n = params.n ?? intParam(ctx.params['n']) ?? DEFAULT_N;
        const seed = params.seed ?? intParam(ctx.params['seed']);
        const negativePrompt = params.negativePrompt ?? stringParam(ctx.params['negativePrompt']);

        host.progress({ phase: 'submitting', message: '正在提交百炼文生图任务' });
        const submitted = await dashscope(apiKey, SUBMIT_PATH, {
          method: 'POST',
          body: JSON.stringify({
            model: ctx.model,
            input: {
              prompt: params.prompt,
              ...(negativePrompt !== undefined ? { negative_prompt: negativePrompt } : {}),
            },
            parameters: {
              size,
              n,
              ...(seed !== undefined ? { seed } : {}),
            },
          }),
        });
        const taskId = submitted.output?.task_id;
        if (taskId === undefined || taskId.length === 0) {
          providerError(200, submitted.code, submitted.message ?? '百炼未返回 task_id');
        }
        host.log.info('百炼文生图任务已提交', { taskId, model: ctx.model, size, n });

        const startedAt = Date.now();
        let lastPercent = 5;
        host.progress({ phase: 'queued', percent: lastPercent, message: '任务已排队' });
        for (;;) {
          if (ctx.signal.aborted) {
            // 不做删除调用：服务端任务自然过期（任务书步骤 3.2）。
            throw new PluginInvokeError('PROVIDER_UNAVAILABLE', '调用已取消，百炼任务将自然过期');
          }
          await sleep(POLL_INTERVAL_MS, ctx.signal);
          if (ctx.signal.aborted) {
            throw new PluginInvokeError('PROVIDER_UNAVAILABLE', '调用已取消，百炼任务将自然过期');
          }
          const polled = await dashscope(apiKey, `/api/v1/tasks/${encodeURIComponent(taskId)}`);
          const output = polled.output ?? {};
          const status = output.task_status ?? '';
          if (status === 'SUCCEEDED') {
            const urls = (output.results ?? [])
              .map((item) => item.url)
              .filter((url): url is string => typeof url === 'string' && url.length > 0);
            if (urls.length === 0) {
              providerError(200, output.code, output.message ?? '百炼任务成功但未返回图片地址');
            }
            host.progress({ phase: 'downloading', percent: 100, message: '图片已生成，正在取回' });
            return { images: urls.map((url) => ({ url })) };
          }
          if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
            providerError(200, output.code, output.message ?? `任务状态 ${status}`);
          }
          const elapsed = Date.now() - startedAt;
          // 百分比估算：10% 起步，每秒 +3%，上限 90%（成功前不冒充 100%）。
          const nextPercent = Math.min(90, 10 + Math.floor(elapsed / 1000) * 3);
          if (nextPercent > lastPercent) {
            lastPercent = nextPercent;
            host.progress({
              phase: status === 'PENDING' ? 'queued' : 'generating',
              percent: nextPercent,
              message: status === 'PENDING' ? '任务已排队' : '正在生成图片',
            });
          }
          if (elapsed > MAX_WAIT_MS) {
            throw new PluginInvokeError(
              'PROVIDER_UNAVAILABLE',
              '百炼文生图等待超时（服务端任务可能仍在生成，可稍后重试）',
            );
          }
        }
      },
    },
  },
});

runPluginRuntime(plugin);
