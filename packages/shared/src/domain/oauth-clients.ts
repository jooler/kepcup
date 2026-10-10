import { z } from 'zod';

/**
 * 预注册 OAuth 客户端表（D73 P2 §6.4，设计 29 §5.2）：`apps/desktop/oauth-clients.json`，
 * 构建期注入 `__KEPCUP_OAUTH_CLIENTS__`。只放平台定义为**非保密**的桌面 / 原生应用客户端
 * （Google Desktop app、GitHub App 公共客户端等）；真正保密的 secret 不得进发行包。
 * 键 = 目录条目 `auth.clientRef`。
 */
export const preregisteredClientSchema = z.object({
  /** 授权服务器 issuer：流程发现到的 issuer 必须与之相等才会使用该客户端。 */
  issuer: z.string().url(),
  clientId: z.string().min(1).max(512),
  /** 平台定义为非保密的 secret（如 Google 桌面客户端）；公共客户端 + PKCE 则省略。 */
  clientSecret: z.string().min(1).max(2048).optional(),
});
export type PreregisteredClient = z.infer<typeof preregisteredClientSchema>;

export const preregisteredClientTableSchema = z.record(
  z.string().min(1),
  preregisteredClientSchema,
);
export type PreregisteredClientTable = z.infer<typeof preregisteredClientTableSchema>;

/** `apps.oauthClients.list` 的一行：绝不含 secret。 */
export const oauthClientViewSchema = z.object({
  issuer: z.string(),
  source: z.enum(['dcr', 'manual', 'preregistered']),
  /** client id 不是机密，返回给界面显示。 */
  clientId: z.string(),
  /** 是否带 client secret（只告知有无）。 */
  hasSecret: z.boolean(),
  /** 仍在使用该 issuer 的连接数（>0 时不可删除）。 */
  connectionCount: z.number().int().nonnegative(),
});
export type OAuthClientView = z.infer<typeof oauthClientViewSchema>;

export const oauthClientsListOutputSchema = z.object({ clients: z.array(oauthClientViewSchema) });
export const oauthClientsSetInputSchema = z.object({
  issuer: z.string().url().max(2048),
  clientId: z.string().trim().min(1).max(512),
  clientSecret: z.string().max(2048).optional(),
  /** 没给 `clientSecret` 时默认保留同一 client id 已存的 secret；`true` = 明确清除它。 */
  clearSecret: z.boolean().optional(),
});
export const oauthClientsRemoveInputSchema = z.object({ issuer: z.string().url().max(2048) });
