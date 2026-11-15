import { AppError } from '@kepcup/shared';
import { MEDIA_ENGINES } from '../../media/engines.js';
import type { InstanceMaterializer } from '../instances.js';

/**
 * Capability-model 实例 materializer（D124，60 号文档 §1/§3）：一个实例就是一个
 * 厂商账号。与 mail / im 不同，实例**没有清单之外的领域数据要落地**——
 * plugin_instances 行（非敏感值在 config_json）与敏感凭据（secrets
 * `plugin:{pluginId}:instance:{instanceId}:{key}`）由 PluginInstanceService 的
 * 通用流程先写（create 失败的补偿、删除 / 卸载级联、前缀扫描清 secrets 都走
 * 既有机制），这里只剩三件事：
 *
 * - create：校验条目绑定的引擎在本版本已注册（防降级场景落地无用实例），
 *   实例标题取插件名（厂商账号卡片的默认展示名）；
 * - update：无表单之外的可编辑状态，幂等通过（凭据替换由通用 secrets 写入完成）；
 * - remove：幂等 no-op（行 + secrets 由上层清）。
 */
export function createCapabilityModelMaterializer(): InstanceMaterializer {
  return {
    async create(ctx) {
      const engines = new Set(
        (ctx.manifest.contributions.capabilityModels ?? []).map((entry) => entry.engine),
      );
      for (const engine of engines) {
        if (MEDIA_ENGINES[engine] === undefined) {
          // 安装管线已拒未知引擎；这里兜底「新版本安装 → 旧版本运行」的降级场景。
          throw new AppError('PLUGIN_ENGINE_UNKNOWN', `引擎 ${engine} 未在本版本注册，无法添加实例`);
        }
      }
      return { title: ctx.manifest.name };
    },

    async update() {
      // 凭据 / 可选覆盖值由通用流程写 config_json + secrets；无领域状态可改。
      return {};
    },

    async remove() {
      // 幂等：实例没有领域落地物，行与 secrets 由 PluginInstanceService 清扫。
    },
  };
}
