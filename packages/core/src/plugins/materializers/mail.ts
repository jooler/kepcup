import { MAIL_POLL_MIN_SEC, type PluginFieldValue } from '@kepcup/shared';
import { AppError } from '@kepcup/shared';
import type { CoreLogger } from '../../infra/logger.js';
import type { MailService } from '../../mail/service.js';
import type { PluginInstanceService } from '../instances.js';
import type { InstanceMaterializer, InstanceMaterializerContext } from '../instances.js';

/**
 * Mail instance materializer (D105 P3): a mail instance IS a mailbox account. Create
 * reuses the mail service's internal landing path (connection test → account row with
 * `instance_id` → password into secrets → session start); update applies endpoint /
 * credential edits (a vendor contribution's locks are re-applied on top of the
 * submitted values); remove tears the account down through the existing delete
 * cascade (bindings, secret, jobs, session). The instance secret is the single
 * password store for instance accounts (`pluginInstanceSecretName`); the account row's
 * title is the address.
 */

function requiredString(ctx: InstanceMaterializerContext, key: string, label: string): string {
  const value = ctx.values[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_INPUT', `缺少必填项：${label}`);
  }
  return value.trim();
}

function optionalString(values: Readonly<Record<string, PluginFieldValue>>, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredPort(
  ctx: InstanceMaterializerContext,
  key: string,
  label: string,
  fallback: number,
): number {
  const value = ctx.values[key];
  if (value === undefined || value === '') return fallback;
  const port = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError('INVALID_INPUT', `${label} 不合法`);
  }
  return port;
}

function requiredSecure(
  ctx: InstanceMaterializerContext,
  key: string,
  label: string,
  fallback: 'ssl' | 'starttls',
): 'ssl' | 'starttls' {
  const value = ctx.values[key];
  if (value === undefined || value === '') return fallback;
  if (value === 'ssl' || value === 'starttls') return value;
  throw new AppError('INVALID_INPUT', `${label} 只能是 ssl 或 starttls`);
}

export function createMailMaterializer(mail: MailService): InstanceMaterializer {
  return {
    async create(ctx) {
      const contribution = ctx.manifest.contributions.mail[0] ?? null;
      const vendor = contribution !== null && contribution.imap.host !== '';
      const address = requiredString(ctx, 'address', '邮箱地址');
      // 锁定端点恒取贡献声明；通用插件的端点是必填实例字段。端口 / 加密方式在
      // 通用插件下也接受贡献里声明的值作为回缺省（993 / 465 / ssl）。
      const account = await mail.createForInstance({
        address,
        username: optionalString(ctx.values, 'username'),
        password: requiredString(ctx, 'password', '授权码'),
        imapHost: vendor ? contribution.imap.host : requiredString(ctx, 'imapHost', 'IMAP 服务器'),
        imapPort: vendor
          ? contribution.imap.port
          : requiredPort(ctx, 'imapPort', 'IMAP 端口', contribution?.imap.port ?? 993),
        imapSecure: vendor
          ? contribution.imap.secure
          : requiredSecure(ctx, 'imapSecure', 'IMAP 加密方式', contribution?.imap.secure ?? 'ssl'),
        smtpHost: vendor ? contribution.smtp.host : requiredString(ctx, 'smtpHost', 'SMTP 服务器'),
        smtpPort: vendor
          ? contribution.smtp.port
          : requiredPort(ctx, 'smtpPort', 'SMTP 端口', contribution?.smtp.port ?? 465),
        smtpSecure: vendor
          ? contribution.smtp.secure
          : requiredSecure(ctx, 'smtpSecure', 'SMTP 加密方式', contribution?.smtp.secure ?? 'ssl'),
        mode: contribution?.defaultMode,
        pollIntervalSec: contribution?.defaultPollSec,
        minPollSec: contribution?.minPollSec ?? MAIL_POLL_MIN_SEC,
        defaultPollSec: contribution?.defaultPollSec ?? 300,
        instanceId: ctx.instanceId,
      });
      // 实例 title = 账号地址。
      return { title: account.address };
    },

    async update(ctx) {
      const current = mail.accountByInstance(ctx.instanceId);
      if (current === null) {
        // 账号已被删（理论上实例删除会级联；这里是防御）：让上层以失败呈现，不静默重建。
        throw new AppError('NOT_FOUND', '该实例的邮箱账号已不存在');
      }
      const contribution = ctx.manifest.contributions.mail[0] ?? null;
      const vendor = contribution !== null && contribution.imap.host !== '';
      const address = requiredString(ctx, 'address', '邮箱地址');
      if (address.toLowerCase() !== current.address.toLowerCase()) {
        // 地址是账号身份（收件游标、发信身份都挂在它上面）：换邮箱 = 删了重建。
        throw new AppError('INVALID_INPUT', '邮箱地址不能修改；如需换邮箱请删除该账号后重新添加');
      }
      // 端点 / 用户名：厂商插件恒锁贡献值；通用插件取提交值，未提交沿用现值。
      const imapHost = vendor
        ? contribution.imap.host
        : (optionalString(ctx.values, 'imapHost') ?? current.imapHost);
      const smtpHost = vendor
        ? contribution.smtp.host
        : (optionalString(ctx.values, 'smtpHost') ?? current.smtpHost);
      // 授权码：表单未填（sensitive 缺省语义）时读存量 secret 重测连接。
      const password = optionalString(ctx.values, 'password') ?? ctx.readStoredSecret('password');
      if (password === null || password.length === 0) {
        throw new AppError('MAIL_AUTH_FAILED', '邮箱授权码不存在，请重新填写');
      }
      const result = await mail.updateInstanceAccount({
        id: current.id,
        username: optionalString(ctx.values, 'username'),
        password,
        imapHost,
        imapPort: vendor
          ? contribution.imap.port
          : requiredPort(ctx, 'imapPort', 'IMAP 端口', current.imapPort),
        imapSecure: vendor
          ? contribution.imap.secure
          : requiredSecure(ctx, 'imapSecure', 'IMAP 加密方式', current.imapSecure),
        smtpHost,
        smtpPort: vendor
          ? contribution.smtp.port
          : requiredPort(ctx, 'smtpPort', 'SMTP 端口', current.smtpPort),
        smtpSecure: vendor
          ? contribution.smtp.secure
          : requiredSecure(ctx, 'smtpSecure', 'SMTP 加密方式', current.smtpSecure),
      });
      return { title: result.address };
    },

    async remove(ctx) {
      void ctx;
      mail.deleteByInstance(ctx.instanceId);
    },
  };
}

/**
 * 启动对账（DEV-065 登记的责任落在 materializer 落地的这一刻）：创建流程里
 * 「实例行已写、账号落地失败」的崩溃窗口会在下次启动留下没有账号的孤儿实例行。
 * 逐行核对 mail 实例：账号不在（软删也算不在）→ 走实例删除清行（幂等，secrets
 * 一并清扫）。
 */
export function reconcileMailInstanceRows(
  instances: PluginInstanceService,
  mail: MailService,
  logger: CoreLogger,
): void {
  for (const row of instances.listKind('mail')) {
    if (mail.accountByInstance(row.id) !== null) continue;
    logger.info({ instanceId: row.id, pluginId: row.pluginId }, 'mail instance reconciliation: removing orphan instance row');
    void instances.delete(row.id).catch((error: unknown) => {
      logger.warn(
        {
          instanceId: row.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'mail instance reconciliation: orphan row cleanup failed',
      );
    });
  }
}
