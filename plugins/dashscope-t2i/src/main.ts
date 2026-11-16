import {
  definePlugin,
  host,
  PluginInvokeError,
  runPluginRuntime,
  type HostNetResponse,
} from '@kepcup/plugin-sdk';

/**
 * 百炼 Qwen-Image 执行型试点（D125 P4，todo/plugin-runtime/P4-governance-pilot.md 步骤 3）。
 *
 * 与内置 dashscope 引擎使用同一厂商与 qwen-image 模型，但协议不同：内置引擎走同步
 * `multimodal-generation/generation`，本插件**在插件内重新实现**异步任务协议（A/B
 * dogfood 执行型运行时）：qwen-image 系列**异步**接口
 * `POST /api/v1/services/aigc/image-generation/generation`（`X-DashScope-Async: enable`，
 * prompt 在 `input.messages[0].content[].text`，参考图作为同数组的 `{ image }` 项 → 即编辑）
 * 拿 `task_id` → `GET /api/v1/tasks/{task_id}` 轮询；成功后取
 * `output.choices[0].message.content[].image`。产物只返回厂商 URL（厂商任务数据含
 * URL 保留 24h，应用会立即下载并落附件）；下载与落附件永远在 core 侧（61 §3.2）。
 *
 * 为什么用异步而不是同步：同步接口要求单条 HTTP 连接挂到出图完成（含 prompt_extend
 * 常 60s+），任何网络抖动 / 代理超时都会让整次调用失败，且插件无法在等待中上报阶段或
 * 响应取消。异步提交是秒级短请求，轮询失败可重试，进度与取消都有自然的介入点。
 *
 * 超时：单次 `host.net.fetch` 由插件声明（`timeoutMs`，短请求 30s 足够）；整个调用的
 * 看门狗由清单 `runtime.timeouts['media.generateImage']`（5 分钟）声明——应用只钳制上限。
 *
 * 边界：网络只走 `host.net.fetch`（清单白名单 dashscope.aliyuncs.com，SSRF 由宿主
 * 守卫）；API Key 来自实例敏感字段（`runtime.instanceFields`，调用时注入
 * `ctx.credentials`，插件不落盘、不打日志）；取消 = 尽快返回，不调用任务删除接口
 * （服务端任务自然过期）。
 */

const API_BASE = 'https://dashscope.aliyuncs.com';
const SUBMIT_PATH = '/api/v1/services/aigc/image-generation/generation';
const POLL_INTERVAL_MS = 3_000;
/** 自设等待上限：低于清单声明的调用超时（300s），留 15s 给结果回传与错误处理。 */
const MAX_WAIT_MS = 285_000;
/** 单次网络请求超时：提交 / 轮询都是短请求，30s 足够；由插件声明（不是应用固定值）。 */
const NET_TIMEOUT_MS = 30_000;
const DEFAULT_SIZE = '1024*1024';
const DEFAULT_N = 1;

interface DashscopeContentItem {
  text?: string;
  image?: string;
}

interface DashscopeBody {
  code?: string;
  message?: string;
  output?: {
    task_id?: string;
    task_status?: string;
    code?: string;
    message?: string;
    choices?: Array<{ message?: { content?: DashscopeContentItem[] } }>;
  };
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
 * 百炼对「model 不存在 / 与端点不匹配」的报错是 `url error, please check url!`，
 * 极易被误读成 URL 写错。补一条可操作指引：本端点只接受 qwen-image 系列。
 */
const MODEL_ENDPOINT_HINT =
  '本条目请求的是百炼 qwen-image 接口（image-generation/generation），它只接受 qwen-image 系列模型' +
  '（如 qwen-image-3.0 / qwen-image-3.0-pro / qwen-image-2.1-pro / qwen-image-2.1-turbo）；' +
  '可在该插件清单的条目 params.model 里覆盖 model，视频模型（*t2v）与 wan 文生图模型不能用于本端点。';

function isUrlError(message: string): boolean {
  return /url error|check url/i.test(message);
}

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
  if (isUrlError(detail)) {
    throw new PluginInvokeError(
      'PROVIDER_UNAVAILABLE',
      `百炼图片生成失败：${detail}。${MODEL_ENDPOINT_HINT}`,
    );
  }
  throw new PluginInvokeError('PROVIDER_UNAVAILABLE', `百炼图片生成失败：${detail}`);
}

/** 一次宿主代理请求（短请求）：网络失败归一 UNAVAILABLE；非 2xx 走错误映射。 */
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
      timeoutMs: NET_TIMEOUT_MS,
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
 * abort 监听——长时间轮询（285s / 3s ≈ 95 次）不清理会累积监听器并触发
 * MaxListenersExceededWarning。
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

function boolParam(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
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
        // 条目 params 是清单默认值（size / n / prompt_extend / watermark），工具显式传参优先。
        const size = (params.size ?? stringParam(ctx.params['size']) ?? DEFAULT_SIZE).replace(
          /x/g,
          '*',
        );
        const n = params.n ?? intParam(ctx.params['n']) ?? DEFAULT_N;
        const seed = params.seed ?? intParam(ctx.params['seed']);
        const negativePrompt = params.negativePrompt ?? stringParam(ctx.params['negativePrompt']);
        const promptExtend = boolParam(ctx.params['prompt_extend']) ?? true;
        const watermark = boolParam(ctx.params['watermark']) ?? false;
        // model 允许条目 params.model 覆盖：在售 id 会随版本更替（下线即报 url error），
        // 用户改清单即可换模型，无需改插件代码重新打包。
        const model = stringParam(ctx.params['model']) ?? ctx.model;

        host.progress({ phase: 'submitting', message: '正在提交百炼文生图任务' });
        const content: DashscopeContentItem[] = [
          ...(params.images ?? []).map((image) => ({ image })),
          { text: params.prompt },
        ];
        const submitted = await dashscope(apiKey, SUBMIT_PATH, {
          method: 'POST',
          body: JSON.stringify({
            model,
            input: { messages: [{ role: 'user', content }] },
            parameters: {
              size,
              n,
              prompt_extend: promptExtend,
              watermark,
              ...(negativePrompt !== undefined ? { negative_prompt: negativePrompt } : {}),
              ...(seed !== undefined ? { seed } : {}),
            },
          }),
        });
        const taskId = submitted.output?.task_id;
        if (taskId === undefined || taskId.length === 0) {
          providerError(
            200,
            submitted.code ?? submitted.output?.code,
            submitted.message ?? '百炼未返回 task_id',
          );
        }
        host.log.info('百炼文生图任务已提交', { taskId, model, size, n });

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
            const urls = (output.choices?.[0]?.message?.content ?? [])
              .map((item) => item.image)
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
          // 百分比估算：10% 起步，每秒 +1%，上限 90%（成功前不冒充 100%）。
          const nextPercent = Math.min(90, 10 + Math.floor(elapsed / 1000));
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
