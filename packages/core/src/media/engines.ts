import { VENDOR_DESCRIPTORS, type ModelCapability, type VendorId } from '@kepcup/shared';
import type { PluginField } from '@kepcup/shared';
import { dashscopeAdapter } from './adapters/dashscope.js';
import { openAICompatibleAdapter } from './adapters/openai-compatible.js';
import { volcengineAdapter } from './adapters/volcengine.js';
import type { VendorAdapter } from './types.js';

/**
 * 引擎注册表（D124，docs/design/60-capability-model-plugins.md §1）：把现有
 * VendorAdapter 具名化——「适配器 + 展示名 + 支持能力 + 凭据字段声明」打包成
 * 一个引擎，插件条目以 `engine` 字段绑定（安装期校验未知引擎拒绝，
 * PLUGIN_ENGINE_UNKNOWN）。插件永远只是数据：新增引擎 = core 内新模块并在此
 * 注册（第一方，随应用发版）。
 *
 * **行为零变化是第一验收项**：首批三个引擎的 adapter 就是现有适配器对象
 * 原样注册（不改一行行为）；既有全局槽位路径继续走 service.ts 的 `ADAPTERS`，
 * 不经本注册表。`VendorAdapter` 契约冻结（media/types.ts）。
 */

export interface MediaEngine {
  id: string;
  /** 展示名（插件详情 / 条目行 / 凭据表单标题）。 */
  displayName: string;
  /** 引擎可服务的能力（UI / 条目校验用；与适配器实际实现的方法一致）。 */
  capabilities: readonly ModelCapability[];
  /** 现有适配器契约，逐字复用（原对象原样注册）。 */
  adapter: VendorAdapter;
  /** 实例表单字段声明（materializer 落地：非敏感 → config_json，sensitive → secrets）。 */
  credentialFields: readonly PluginField[];
  /**
   * VendorCallContext 的路由键（dashscope/volcengine-ark 引擎带厂商 id，供
   * `#unsupported` 取展示名等既有语义；通用兼容引擎为 'custom'）。适配器
   * 本身不读该字段。
   */
  vendor: VendorId | 'custom';
}

/**
 * 引擎实例字段是 core 派生的 zh 文案（与 mail/im/mcp 的内置实例字段同一姿态，
 * P1 review disposition P1-6）；PluginField 的 description / required / multiple
 * 等缺省语义与 pluginFieldSchema 一致。
 */
function dashscopeCredentialFields(): readonly PluginField[] {
  return [
    {
      key: 'apiKey',
      type: 'string',
      title: 'API Key',
      description: '在阿里云百炼控制台获取的 API Key',
      required: true,
      sensitive: true,
      multiple: false,
    },
    {
      key: 'baseUrl',
      type: 'string',
      title: 'API 根地址（覆盖默认）',
      description: '选填，缺省使用内置地址',
      required: false,
      sensitive: false,
      multiple: false,
    },
  ];
}

function volcengineCredentialFields(): readonly PluginField[] {
  return [
    {
      key: 'apiKey',
      type: 'string',
      title: 'API Key',
      description: '在火山方舟控制台获取的 API Key',
      required: true,
      sensitive: true,
      multiple: false,
    },
    {
      key: 'baseUrl',
      type: 'string',
      title: 'API 根地址（覆盖默认）',
      description: '选填，缺省使用内置地址',
      required: false,
      sensitive: false,
      multiple: false,
    },
  ];
}

function openAICompatibleCredentialFields(): readonly PluginField[] {
  return [
    {
      key: 'apiKey',
      type: 'string',
      title: 'API Key',
      description: '兼容端点的 API Key',
      required: true,
      sensitive: true,
      multiple: false,
    },
    {
      key: 'baseUrl',
      type: 'string',
      title: 'API 根地址',
      description: 'OpenAI 兼容根地址（以 /v1 结尾的兼容路径通常也要带上）',
      required: true,
      sensitive: false,
      multiple: false,
    },
  ];
}

/** 既有全局槽位路径的能力矩阵来自 VENDOR_DESCRIPTORS；引擎注册表与之对齐。 */
function descriptorCapabilities(vendor: VendorId): readonly ModelCapability[] {
  return VENDOR_DESCRIPTORS[vendor].capabilities;
}

export const MEDIA_ENGINES: Readonly<Record<string, MediaEngine>> = {
  dashscope: {
    id: 'dashscope',
    displayName: VENDOR_DESCRIPTORS.dashscope.name,
    capabilities: descriptorCapabilities('dashscope'),
    adapter: dashscopeAdapter,
    credentialFields: dashscopeCredentialFields(),
    vendor: 'dashscope',
  },
  'volcengine-ark': {
    id: 'volcengine-ark',
    displayName: VENDOR_DESCRIPTORS.volcengine.name,
    capabilities: descriptorCapabilities('volcengine'),
    adapter: volcengineAdapter,
    credentialFields: volcengineCredentialFields(),
    vendor: 'volcengine',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    displayName: 'OpenAI 兼容端点',
    // DEV-133：TTS / ASR 的 de-facto 标准接口（/audio/speech、
    // /audio/transcriptions）已补进通用适配器——自定义兼容端点也能承载
    // 语音槽位；图像 / 视频生成仍归插件条目，不在此列。
    capabilities: ['embedding', 'tts', 'asr'],
    adapter: openAICompatibleAdapter,
    credentialFields: openAICompatibleCredentialFields(),
    vendor: 'custom',
  },
};

/** 已注册引擎 id 列表（安装期 PLUGIN_ENGINE_UNKNOWN 错误信息列出）。 */
export function mediaEngineIds(): string[] {
  return Object.keys(MEDIA_ENGINES);
}
