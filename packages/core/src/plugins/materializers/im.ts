import { AppError, type PluginManifest } from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import type { ImService } from '../../im/service.js';
import type { PluginInstanceService } from '../instances.js';
import type { InstanceMaterializer, InstanceMaterializerContext } from '../instances.js';

/**
 * IM 实例 materializer（D107，54 号文档 §2.3）：一个 im 实例就是一个 IM 账号。
 * create 按建号方式分流——`qrcode`：消费扫码确认载荷（core 内存 pending，
 * `im.login.qrcode.create/poll` 两步 RPC 之后），连接测试 → im_accounts 落行
 * （带 instance_id）→ bot_token 入实例 secrets → 启动长轮询；`secret` 表单建号
 * 首发未用（wecom-app 等后置插件），落地时缺 token 直接报错。update：token 失效
 * 重扫 = 消费该实例的确认载荷替换 secret（无 pending 则按「无表单编辑」幂等通过
 * ——im 账号没有可编辑的实例字段）。remove 幂等：停会话、删行（绑定 FK 级联）、
 * secrets 由 PluginInstanceService 的前缀扫描清扫。
 */

function contributionOf(manifest: PluginManifest): {
  transport: 'ilink' | 'wecom-app' | 'telegram-bot' | 'webhook';
  apiBase: string;
  label: string;
} {
  const contribution = manifest.contributions.im[0];
  if (contribution === undefined) {
    throw new AppError('PLUGIN_INVALID', '插件清单缺少 IM 贡献，无法落地 IM 账号');
  }
  return { transport: contribution.transport, apiBase: contribution.apiBase, label: contribution.label };
}

export function createImMaterializer(im: ImService): InstanceMaterializer {
  return {
    async create(ctx: InstanceMaterializerContext) {
      const contribution = contributionOf(ctx.manifest);
      // qrcode 建号：token 只存在于 core 的扫码 pending 表；这里取出并立刻入 secrets。
      const confirmed = im.takePendingLoginForCreate(ctx.pluginId);
      const label = await im.createForInstance({
        pluginId: ctx.pluginId,
        instanceId: ctx.instanceId,
        transport: contribution.transport,
        apiBase: confirmed.apiBase || contribution.apiBase,
        label: contribution.label,
        token: confirmed.token,
        ilinkBotId: confirmed.ilinkBotId,
        ilinkUserId: confirmed.ilinkUserId,
      });
      return { title: label };
    },

    async update(ctx: InstanceMaterializerContext) {
      const contribution = contributionOf(ctx.manifest);
      const accountId = im.store.idByInstance(ctx.instanceId);
      if (accountId === null) {
        // 账号已被删（理论上实例删除会级联；防御）：让上层以失败呈现，不静默重建。
        throw new AppError('NOT_FOUND', '该实例的 IM 账号已不存在');
      }
      // 重扫：pending 里绑定到本实例的确认载荷存在 → 替换 token 并重启会话；
      // 不存在 → im 实例没有表单字段可编辑，幂等通过（连接状态由会话自愈）。
      const confirmed = im.takePendingLoginForUpdate(ctx.pluginId, ctx.instanceId);
      if (confirmed !== null) {
        await im.reauthorizeForInstance({
          pluginId: ctx.pluginId,
          instanceId: ctx.instanceId,
          token: confirmed.token,
          apiBase: confirmed.apiBase || contribution.apiBase,
          ilinkBotId: confirmed.ilinkBotId,
          ilinkUserId: confirmed.ilinkUserId,
        });
      }
      const account = im.store.get(accountId);
      return { title: account?.label ?? contribution.label };
    },

    async remove(ctx) {
      void ctx;
      im.deleteByInstance(ctx.instanceId);
    },
  };
}

/**
 * 启动对账（仿 reconcileMailInstanceRows / DEV-065）：创建流程里「实例行已写、
 * 账号落地失败」的崩溃窗口会留下没有账号的孤儿实例行。逐行核对 im 实例：账号
 * 不在 → 走实例删除清行（幂等，secrets 一并清扫）。
 */
export function reconcileImInstanceRows(
  instances: PluginInstanceService,
  im: ImService,
  logger: CoreLogger,
): void {
  for (const row of instances.listKind('im')) {
    if (im.store.idByInstance(row.id) !== null) continue;
    logger.info(
      { instanceId: row.id, pluginId: row.pluginId },
      'im instance reconciliation: removing orphan instance row',
    );
    void instances.delete(row.id).catch((error: unknown) => {
      logger.warn(
        { instanceId: row.id, error: error instanceof Error ? error.message : String(error) },
        'im instance reconciliation: orphan row cleanup failed',
      );
    });
  }
}
