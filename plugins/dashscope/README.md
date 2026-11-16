# dashscope —— 阿里云百炼插件（D124 能力模型条目首个官方数据包）

> 机制设计（条目契约、引擎注册表、Bot 绑定、解析链）以 **[docs/design/60-capability-model-plugins.md](../../docs/design/60-capability-model-plugins.md)**（**D124**）为唯一事实来源；执行方案见 [todo/capability-model-plugins](../../todo/capability-model-plugins/README.md)。

## 1 定位

把「阿里云百炼」（DashScope）的在售媒体模型做成**纯数据条目包**（60 号决策 12）：插件不含代码，
执行逻辑全部住在 core 内置引擎 `MEDIA_ENGINES['dashscope']`（既有 `dashscopeAdapter` 原样注册，
行为逐字节不变）。条目 = `VENDOR_DESCRIPTORS.dashscope.presets` 的非 chat 部分全量逐 preset 一条
（**只迁描述符已有信息**：能力矩阵、模型 id、渠道事实注释；不发明新默认值，故条目不带
`params`）。用户配置路径与既有全局槽位并存不迁移（两条路径互不改写）。

- 条目数：**20**（embedding 3 / rerank 2 / multimodal 2 / image 4 / tts 5 / asr 1 / video 3）；
- 引擎绑定：全部 `engine: 'dashscope'`（安装期 `PLUGIN_ENGINE_UNKNOWN` 校验）；
- 实例：`instances: ['capability-model']`，凭据字段由引擎声明（apiKey 必填敏感 + baseUrl 可选），
  敏感值只进 secrets（`plugin:{pluginId}:instance:{instanceId}:{key}`）；
- chat 不在条目内：对话模型继续走 provider 注册表（`settings.modelProviders`），与本插件无交集。

## 2 包内文件

| 文件 | 说明 |
|---|---|
| `plugin.json` | 清单：20 条 `contributions.capabilityModels`（条目 id 是模型 id 的 slug 化——id 规则 `[a-z0-9-]` 不含点，`model` 字段保留厂商原始模型 id） |
| `icon.png` | 复用渲染层 `assets/provider-icons/model-provider-alibaba-cloud.png`（1.9 KiB，市场图标上限 64 KiB） |
| `README.md` | 本文档 |

## 3 校验与分发

```bash
node packages/app-validator/dist/cli.js validate plugins/dashscope
node packages/app-validator/dist/cli.js pack plugins/dashscope --out /tmp/dist/dashscope.kepcup
```

- `engines.kepcup >= 0.5.14`：`contributions.capabilityModels` 是 strict schema 新字段，旧宿主
  必须在索引层看到「需要更新版本」而不是下载后解析失败（51 §15.8 先例）。
- 市场上架：官方 verified（`infra/cloudflare/sign-plugins.sh` 流程，见
  [plugins/README.md](../README.md)；索引生成 `scripts/sign-plugin-index.mjs` 的
  `categoriesOf` 已补 `capability-model` 类别分支）。

## 4 已知边界

- **embedding / rerank 条目本期声明但不消费**（60 §10 Q4：记忆管线绑定全局槽位）；schema 允许
  声明以便后续单独开放，UI 上这类条目不会出现在 Bot 勾选数据源的媒体能力里
  （`media-entry-source` 防御性跳过）。
- **多实例**：从官方市场安装后可添加多个百炼账号；条目未指定 `instance` 且多实例时调用报
  `INSTANCE_AMBIGUOUS`，单实例自动命中。
- 内置目录机制（D104 只读目录型）：本包在开发 / e2e 环境可经 `KEPCUP_BUILTIN_PLUGINS`
  以 builtin 来源投影（不入 `plugins` 表）；**builtin 来源不能持有账号实例**（外键约束，
  DEV-112），插件详情不展示实例表单——凭据 / 测试连接走官方市场安装形态，生产分发
  同样只走市场。
