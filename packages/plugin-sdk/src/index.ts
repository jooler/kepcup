export {
  definePlugin,
  PluginInvokeError,
  type MediaCallContext,
  type MediaContractImpl,
  type PluginReadyContext,
  type PluginSpec,
} from './plugin.js';
export {
  host,
  HostApiNotConnectedError,
  wireHostApi,
  type HostLogApi,
  type HostNetApi,
  type HostNetRequestInit,
  type HostNetResponse,
  type HostSecretsApi,
  type HostStorageApi,
  type PluginHostApi,
} from './host.js';
export {
  nodeProcessTransport,
  runPluginRuntime,
  type PluginFrameTransport,
  type PluginIpcLike,
  type PluginRuntimeController,
} from './client.js';
// 协议常量与帧类型 re-export：插件代码无需再直接依赖 @kepcup/shared 即可取用
// （帧 schema 本体与 media 契约 schema 仍从 @kepcup/shared 导出——单一事实源在 shared，
// SDK 不复刻任何 schema）。
export { PLUGIN_RUNTIME_HOST_API_VERSION, PLUGIN_RUNTIME_ERROR_CODES } from '@kepcup/shared';
export type {
  HostToPluginFrame,
  PluginRuntimeErrorFrame,
  PluginRuntimeFrame,
  PluginRuntimeLogPayload,
  PluginRuntimeProgressPayload,
  PluginToHostFrame,
} from '@kepcup/shared';
