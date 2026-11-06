import bailianColor from '@lobehub/icons-static-svg/icons/bailian-color.svg?url';
import volcengineColor from '@lobehub/icons-static-svg/icons/volcengine-color.svg?url';
import zaiMono from '@lobehub/icons-static-svg/icons/zai.svg?url';
import zhipuColor from '@lobehub/icons-static-svg/icons/zhipu-color.svg?url';
import kimiColor from '@lobehub/icons-static-svg/icons/kimi-color.svg?url';
import minimaxColor from '@lobehub/icons-static-svg/icons/minimax-color.svg?url';
import deepseekColor from '@lobehub/icons-static-svg/icons/deepseek-color.svg?url';
import xiaomiMimoMono from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?url';
import tencentCloudColor from '@lobehub/icons-static-svg/icons/tencentcloud-color.svg?url';
import stepfunColor from '@lobehub/icons-static-svg/icons/stepfun-color.svg?url';
import openaiMono from '@lobehub/icons-static-svg/icons/openai.svg?url';
import anthropicMono from '@lobehub/icons-static-svg/icons/anthropic.svg?url';
import xaiMono from '@lobehub/icons-static-svg/icons/xai.svg?url';
import siliconCloudColor from '@lobehub/icons-static-svg/icons/siliconcloud-color.svg?url';
import openrouterColor from '@lobehub/icons-static-svg/icons/openrouter-color.svg?url';
import opencodeMono from '@lobehub/icons-static-svg/icons/opencode.svg?url';
import geminiColor from '@lobehub/icons-static-svg/icons/gemini-color.svg?url';
import mistralColor from '@lobehub/icons-static-svg/icons/mistral-color.svg?url';
import groqMono from '@lobehub/icons-static-svg/icons/groq.svg?url';
import fireworksColor from '@lobehub/icons-static-svg/icons/fireworks-color.svg?url';
import togetherColor from '@lobehub/icons-static-svg/icons/together-color.svg?url';
import nvidiaColor from '@lobehub/icons-static-svg/icons/nvidia-color.svg?url';
import cerebrasColor from '@lobehub/icons-static-svg/icons/cerebras-color.svg?url';
import basetenMono from '@lobehub/icons-static-svg/icons/baseten.svg?url';
import huggingfaceColor from '@lobehub/icons-static-svg/icons/huggingface-color.svg?url';
import vercelMono from '@lobehub/icons-static-svg/icons/vercel.svg?url';
import lingColor from '@lobehub/icons-static-svg/icons/ling-color.svg?url';
import startPlan from '../../assets/provider-icons/model-provider-start-plan.png?url';

/**
 * 供应商图标。
 *
 * 键是模板 / 实例 `logo` 字段存的资产文件名——沿用 ZCode provider-icons
 * 时代的文件名，保证已存进 settings 的实例不用迁移就能换上新图标。
 *
 * 图标本体优先用 `@lobehub/icons-static-svg`（随应用打包的矢量品牌图标）：
 * 有品牌色的用 `*-color`，走 `<img>`；只有单色标记的用 mono（`currentColor`
 * 在 `<img>` 里会退化成黑色，暗色主题下不可见），由 `ProviderLogo` 以 CSS
 * mask 按前景色渲染，跟随明暗主题。`@lobehub` 没有对应品牌的（目前只有
 * start-plan）继续用 `lib/assets/provider-icons/` 下的位图；都没有的供应商
 * （自定义实例）由 UI 回退到首字母占位。
 */
export interface ProviderIconAsset {
  url: string;
  /** true = 单色标记，按当前文字颜色渲染（CSS mask），不能用 <img>。 */
  mono: boolean;
}

const ICONS: Readonly<Record<string, ProviderIconAsset>> = {
  // 我们自己的媒体厂商卡。
  'model-provider-alibaba-cloud.png': { url: bailianColor, mono: false },
  'model-provider-volcengine.png': { url: volcengineColor, mono: false },
  // Z.ai / BigModel / Kimi / MiniMax / DeepSeek。
  'model-provider-zai-app.png': { url: zaiMono, mono: true },
  'model-provider-zai.png': { url: zaiMono, mono: true },
  'logo-bigmodel.svg': { url: zhipuColor, mono: false },
  'model-provider-moonshot-kimi.png': { url: kimiColor, mono: false },
  'model-provider-minimax.png': { url: minimaxColor, mono: false },
  'model-provider-deepseek.png': { url: deepseekColor, mono: false },
  // 国内其余厂商。
  'model-provider-xiaomi-mimo.png': { url: xiaomiMimoMono, mono: true },
  'model-provider-tencent-cloud.png': { url: tencentCloudColor, mono: false },
  'model-provider-stepfun.png': { url: stepfunColor, mono: false },
  // 一线海外厂商。
  'model-provider-openai.png': { url: openaiMono, mono: true },
  'model-provider-anthropic.png': { url: anthropicMono, mono: true },
  'model-provider-xai.png': { url: xaiMono, mono: true },
  'model-provider-google-gemini.png': { url: geminiColor, mono: false },
  'model-provider-mistral.webp': { url: mistralColor, mono: false },
  // 聚合 / 推理平台。
  'model-provider-siliconflow.png': { url: siliconCloudColor, mono: false },
  'model-provider-openrouter-light.svg': { url: openrouterColor, mono: false },
  'model-provider-opencode-light.svg': { url: opencodeMono, mono: true },
  'model-provider-groq.webp': { url: groqMono, mono: true },
  'model-provider-fireworks.webp': { url: fireworksColor, mono: false },
  'model-provider-together.png': { url: togetherColor, mono: false },
  'model-provider-nvidia.png': { url: nvidiaColor, mono: false },
  'model-provider-cerebras.png': { url: cerebrasColor, mono: false },
  'model-provider-baseten.png': { url: basetenMono, mono: true },
  'model-provider-huggingface.webp': { url: huggingfaceColor, mono: false },
  'model-provider-vercel.webp': { url: vercelMono, mono: true },
  'model-provider-ant-ling.webp': { url: lingColor, mono: false },
  // @lobehub 暂无对应品牌，保留原资产。
  'model-provider-start-plan.png': { url: startPlan, mono: false },
};

export function providerIcon(key: string | undefined): ProviderIconAsset | undefined {
  if (key === undefined || key.length === 0) return undefined;
  return ICONS[key];
}
