# directory — dl.kepcup.com 静态资源 Worker

`kepcup-directory` Worker（仅静态资源，无脚本）托管 **插件市场** 的签名索引
（D104，设计 51 §6.1）。历史上它还托管连接器目录（`/connectors/v1/`），
该通道已随 D104 商店化移除（连接能力完全由市场插件承担），路径已下线。

```
infra/cloudflare/directory/
  wrangler.jsonc                    仅静态资源（无 Worker 脚本），自定义域 dl.kepcup.com
  public/_headers                   缓存头（Static Assets 只认资源根目录的 _headers）
  public/plugins/v1/                插件市场索引：发布时把签名产物放这里再部署（.gitignore 忽略）
  public/.assetsignore              .gitkeep / .gitignore 不作为静态资源上线
```

## 插件市场索引（`/plugins/v1/`）

| 文件 | 内容 | 缓存 |
|---|---|---|
| `index.json` | `{ version: 1, generatedAt, keyId, entries[], revoked[] }` | `public, max-age=300` |
| `index.json.sig` | 对 `index.json` **原始字节**的 Ed25519 分离签名，base64 | 同上 |

签名用 `scripts/sign-plugin-index.mjs`（独立密钥 `KEPCUP_PLUGIN_SIGNING_KEY`，公钥登记在
shared 的 `PLUGIN_INDEX_PUBLIC_KEYS`）；包本体走 R2 内容寻址（`{sha256}.kepcup`）。
`generatedAt` 必须严格递增（客户端防回滚）。机制、防回滚与轮换流程见
**[../plugins/README.md](../plugins/README.md)**；发布命令序列在仓库 `plugins/README.md`。

## 部署

```bash
# 发布时：签名产物放 public/plugins/v1/ 后
cd infra/cloudflare/directory && npx wrangler deploy
```

⚠️ `public/plugins/v1/` 的签名产物不入库。**从本机检出重新部署前**必须确保
`plugins/v1/index.json` / `index.json.sig` 在位（从线上拉回或刚签名产出），
否则部署会把线上市场索引顶成 404。
