# oauth-clients.json

KepCup 预注册的 OAuth 客户端表（D73 P2 §6.4，设计 29 §5.2）。`pnpm dist` 把它注入核心服务的
`__KEPCUP_OAUTH_CLIENTS__`；开发 / 测试构建直接读这个文件。

```json
{
  "<clientRef>": { "issuer": "https://…", "clientId": "…", "clientSecret": "（可选）" }
}
```

- 键 = 目录条目 `auth.clientRef`；`issuer` 必须与授权服务器发现到的 issuer 一致，否则该客户端不会被使用。
- **只放平台定义为非保密的桌面 / 原生应用客户端**（公共客户端 + PKCE；或平台文档明确说明桌面应用的
  client secret 不是机密，如 Google「桌面应用」）。真正保密的 secret 不得提交，也不得进发行包。
- **环境变量来源**（推荐，真实凭据不进 git）：`google` 由 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 提供——
  开发态读 `process.env` 与仓库根 `.env`（已 gitignore），`pnpm dist` 以同样规则并入注入表；同名条目覆盖本文件。
  映射表见 `packages/core/src/apps/oauth-clients.ts` 的 `ENV_OAUTH_CLIENTS`（`dist.mjs` 同步一份）。
- 本文件目前为空：Microsoft / Slack / GitHub 的条目等用户完成平台注册（U3 / U4）后补入。
- 用户可在「扩展中心 → MCP → OAuth 客户端」按 issuer 自带客户端（BYO），优先于本表。
