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
 * 协议与内置 dashscope 引擎的图片生成同源，但**在插件内重新实现**（A/B dogfood 执行型
 * 运行时）：`POST /api/v1/services/aigc/multimodal-generation/generation`
 * （qwen-image 系列同步接口；prompt 在 `input.messages[0].content[].text`，参考图作为
 * 同数组的 `{ image }` 项 → 即编辑），响应取 `output.choices[0].message.content[].image`。
 * 产物只返回厂商 URL（24h 有效）；下载与落附件永远在 core 侧（61 §3.2）。
 *
 * 边界：网络只走 `host.net.fetch`（清单白名单 dashscope.aliyuncs.com，SSRF 由宿主
 * 守卫）；API Key 来自实例敏感字段（`runtime.instanceFields`，调用时注入
 * `ctx.credentials`，插件不落盘、不打日志）。
 *
 * 为什么是同步而不是 wan 异步任务：qwen-image 系列官方推荐同步接口（同一请求返回
 * 图片）；wan 异步（`text2image/image-synthesis`）只接受 wan 文生图模型，把视频模型
 * （`*t2v`）发过去会被百炼以 `url error, please check url!` 拒绝（真机教训，DEV-124）。
 * 同步请求期间无法向宿主上报细粒度阶段，进度只报「提交」与「取回」两端。
 */

const API_BASE = 'https://dashscope.aliyuncs.com';
const GENERATE_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
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
  '本条目请求的是百炼 qwen-image 同步接口（multimodal-generation/generation），它只接受 qwen-image 系列模型' +
  '（如 qwen-image-3.0 / qwen-image-3.0-pro / qwen-image-2.1-pro / qwen-image-2.1-turbo）；' +
  '可在该插件清单的条目 params.model 里覆盖 model，视频模型（*t2v）与 wan 文生图模型不能用于本端点。';

function isUrlError(message: string): boolean {
  return /url error|check url/i.test(message);
}

/**
 * DashScope HTTP 失败 → `PROVIDER_*`（61 §5）：
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
        // qwen-image 3.0 起支持 negative_prompt；低版本模型传入由厂商自行忽略或报错。
        const promptExtend = boolParam(ctx.params['prompt_extend']) ?? true;
        const watermark = boolParam(ctx.params['watermark']) ?? false;
        // model 允许条目 params.model 覆盖：在售 id 会随版本更替（下线即报 url error），
        // 用户改清单即可换模型，无需改插件代码重新打包。
        const model = stringParam(ctx.params['model']) ?? ctx.model;

        host.progress({ phase: 'submitting', message: '正在请求百炼生成图片' });
        const content: DashscopeContentItem[] = [
          ...(params.images ?? []).map((image) => ({ image })),
          { text: params.prompt },
        ];
        let response: HostNetResponse;
        try {
          response = await host.net.fetch(`${API_BASE}${GENERATE_PATH}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
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

        // 同步接口无法中途中断宿主代理请求；返回后立即尊重取消，避免把已放弃的
        // 结果继续往下走（产物下载与投递都在 core 侧，由工具层按 signal 决定）。
        if (ctx.signal.aborted) {
          throw new PluginInvokeError('PROVIDER_UNAVAILABLE', '调用已取消');
        }

        const text = await response.text();
        const body = parseJson(text);
        if (!response.ok) {
          providerError(response.status, body.code, body.message ?? '');
        }
        const items = body.output?.choices?.[0]?.message?.content ?? [];
        const urls = items
          .map((item) => item.image)
          .filter((url): url is string => typeof url === 'string' && url.length > 0);
        if (urls.length === 0) {
          providerError(200, body.code, body.message ?? '百炼图片接口未返回图片地址');
        }
        host.log.info('百炼图片生成完成', { model, size, n, images: urls.length });
        host.progress({ phase: 'downloading', percent: 100, message: '图片已生成，正在取回' });
        return { images: urls.map((url) => ({ url })) };
      },
    },
  },
});

runPluginRuntime(plugin);
