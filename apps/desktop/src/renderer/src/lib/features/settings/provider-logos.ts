import alibabaCloud from '$lib/assets/provider-icons/model-provider-alibaba-cloud.png';
import anthropic from '$lib/assets/provider-icons/model-provider-anthropic.png';
import antLing from '$lib/assets/provider-icons/model-provider-ant-ling.webp';
import baseten from '$lib/assets/provider-icons/model-provider-baseten.png';
import bigmodel from '$lib/assets/provider-icons/logo-bigmodel.svg';
import cerebras from '$lib/assets/provider-icons/model-provider-cerebras.png';
import deepseek from '$lib/assets/provider-icons/model-provider-deepseek.png';
import fireworks from '$lib/assets/provider-icons/model-provider-fireworks.webp';
import googleGemini from '$lib/assets/provider-icons/model-provider-google-gemini.png';
import groq from '$lib/assets/provider-icons/model-provider-groq.webp';
import huggingface from '$lib/assets/provider-icons/model-provider-huggingface.webp';
import mistral from '$lib/assets/provider-icons/model-provider-mistral.webp';
import nvidia from '$lib/assets/provider-icons/model-provider-nvidia.png';
import together from '$lib/assets/provider-icons/model-provider-together.png';
import vercel from '$lib/assets/provider-icons/model-provider-vercel.webp';
import minimax from '$lib/assets/provider-icons/model-provider-minimax.png';
import moonshotKimi from '$lib/assets/provider-icons/model-provider-moonshot-kimi.png';
import openai from '$lib/assets/provider-icons/model-provider-openai.png';
import opencodeLight from '$lib/assets/provider-icons/model-provider-opencode-light.svg';
import openrouterLight from '$lib/assets/provider-icons/model-provider-openrouter-light.svg';
import siliconflow from '$lib/assets/provider-icons/model-provider-siliconflow.png';
import startPlan from '$lib/assets/provider-icons/model-provider-start-plan.png';
import stepfun from '$lib/assets/provider-icons/model-provider-stepfun.png';
import tencentCloud from '$lib/assets/provider-icons/model-provider-tencent-cloud.png';
import volcengine from '$lib/assets/provider-icons/model-provider-volcengine.png';
import xai from '$lib/assets/provider-icons/model-provider-xai.png';
import xiaomiMimo from '$lib/assets/provider-icons/model-provider-xiaomi-mimo.png';
import zai from '$lib/assets/provider-icons/model-provider-zai.png';
import zaiApp from '$lib/assets/provider-icons/model-provider-zai-app.png';

/**
 * 供应商图标（取自 ZCode 的 provider-icons 资产，来源与授权见
 * `assets/provider-icons/model-provider-logo-sources.json`）。键为模板 /
 * 实例 `logo` 字段存的资产文件名；没有资产的供应商（pi 目录实例、自定义）
 * 由 UI 回退到首字母占位。
 */
const LOGOS: Readonly<Record<string, string>> = {
  'model-provider-alibaba-cloud.png': alibabaCloud,
  'model-provider-anthropic.png': anthropic,
  'model-provider-ant-ling.webp': antLing,
  'model-provider-baseten.png': baseten,
  'model-provider-cerebras.png': cerebras,
  'model-provider-fireworks.webp': fireworks,
  'model-provider-google-gemini.png': googleGemini,
  'model-provider-groq.webp': groq,
  'model-provider-huggingface.webp': huggingface,
  'model-provider-mistral.webp': mistral,
  'model-provider-nvidia.png': nvidia,
  'model-provider-together.png': together,
  'model-provider-vercel.webp': vercel,
  'logo-bigmodel.svg': bigmodel,
  'model-provider-deepseek.png': deepseek,
  'model-provider-minimax.png': minimax,
  'model-provider-moonshot-kimi.png': moonshotKimi,
  'model-provider-openai.png': openai,
  'model-provider-opencode-light.svg': opencodeLight,
  'model-provider-openrouter-light.svg': openrouterLight,
  'model-provider-siliconflow.png': siliconflow,
  'model-provider-start-plan.png': startPlan,
  'model-provider-stepfun.png': stepfun,
  'model-provider-tencent-cloud.png': tencentCloud,
  'model-provider-volcengine.png': volcengine,
  'model-provider-xai.png': xai,
  'model-provider-xiaomi-mimo.png': xiaomiMimo,
  'model-provider-zai.png': zai,
  'model-provider-zai-app.png': zaiApp,
};

export function providerLogo(key: string | undefined): string | undefined {
  if (key === undefined || key.length === 0) return undefined;
  return LOGOS[key];
}
