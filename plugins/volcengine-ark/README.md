# volcengine-ark —— 火山方舟插件（D124 能力模型条目官方数据包）

> 机制设计（条目契约、引擎注册表、Bot 绑定、解析链）以 **[docs/design/60-capability-model-plugins.md](../../docs/design/60-capability-model-plugins.md)**（**D124**）为唯一事实来源；执行方案见 [todo/capability-model-plugins](../../todo/capability-model-plugins/README.md)。

## 1 定位

把「火山方舟」（Volcano Ark）的在售媒体模型做成**纯数据条目包**（60 号决策 12）：插件不含代码，
执行逻辑全部住在 core 内置引擎 `MEDIA_ENGINES['volcengine-ark']`（既有 `volcengineAdapter`
原样注册，行为逐字节不变）。条目 = `VENDOR_DESCRIPTORS.volcengine.presets` 的非 chat 部分全量逐 preset
一条（**只迁描述符已有信息**；描述符注释明确「方舟数据面没有 Rerank / TTS / ASR 接口」，
故条目只含 embedding / multimodal；DEV-133 起生成能力（image / video）由执行型插件提供，内置引擎不再承载）。用户配置路径与既有全局
槽位并存不迁移。

- 条目数：**3**（embedding 1 / multimodal 2；DEV-133 起不再携带 image / video 条目）；
- 引擎绑定：全部 `engine: 'volcengine-ark'`（安装期 `PLUGIN_ENGINE_UNKNOWN` 校验）；
- 实例：`instances: ['capability-model']`，凭据字段由引擎声明（apiKey 必填敏感 + baseUrl 可选），
  敏感值只进 secrets（`plugin:{pluginId}:instance:{instanceId}:{key}`）；
- chat 不在条目内：对话模型继续走 provider 注册表（`settings.modelProviders`），与本插件无交集。

## 2 包内文件

| 文件 | 说明 |
|---|---|
| `plugin.json` | 清单：3 条 `contributions.capabilityModels`（条目 id 即模型 id——方舟模型 id 全落在 `[a-z0-9-]` 规则内，`model` 字段同值） |
| `icon.png` | 复用渲染层 `assets/provider-icons/model-provider-volcengine.png`（7.5 KiB，市场图标上限 64 KiB） |
| `README.md` | 本文档 |

## 3 校验与分发

```bash
node packages/app-validator/dist/cli.js validate plugins/volcengine-ark
node packages/app-validator/dist/cli.js pack plugins/volcengine-ark --out /tmp/dist/volcengine-ark.kepcup
```

- `engines.kepcup >= 0.5.14`：`contributions.capabilityModels` 是 strict schema 新字段，旧宿主
  必须在索引层看到「需要更新版本」而不是下载后解析失败（51 §15.8 先例）。
- 市场上架：官方 verified（`infra/cloudflare/sign-plugins.sh` 流程，见
  [plugins/README.md](../README.md)；索引生成 `scripts/sign-plugin-index.mjs` 的
  `categoriesOf` 已补 `capability-model` 类别分支）。

## 4 已知边界

- **embedding 条目本期声明但不消费**（60 §10 Q4：记忆管线绑定全局槽位）；schema 允许声明以便
  后续单独开放，`media-entry-source` 对该能力防御性跳过。
- **多实例**：从官方市场安装后可添加多个方舟账号；条目未指定 `instance` 且多实例时调用报
  `INSTANCE_AMBIGUOUS`，单实例自动命中。
- 内置目录机制（D104 只读目录型）：本包在开发 / e2e 环境可经 `KEPCUP_BUILTIN_PLUGINS`
  以 builtin 来源投影（不入 `plugins` 表）；**builtin 来源不能持有账号实例**（外键约束，
  DEV-112），插件详情不展示实例表单——凭据 / 测试连接走官方市场安装形态，生产分发
  同样只走市场。
