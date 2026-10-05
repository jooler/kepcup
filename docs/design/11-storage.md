# 11 存储

## 数据目录

所有平台统一放在用户主目录下：`~/.kepcup/`（Windows 为 `%USERPROFILE%\.kepcup\`）。

```text
~/.kepcup/
  main.db                                  -- 主库
  runs.db                                  -- 执行记录库
  skills-library/{skill}@{hash}/           -- 导入的技能，只读，按内容哈希存放
  toolchains/                              -- 按需安装的运行时与工具
    embedding-model/{version}/             -- 本地向量模型（model.onnx + vocab.txt + config.json）
    onnxruntime/{version}/                 -- ONNX Runtime Node 包（含 node_modules/onnxruntime-common）
  cache/                                   -- 依赖包缓存，按内容寻址，多个 workspace 共享
  logs/                                    -- 运行日志（敏感字段脱敏）
  sandbox/                                 -- 沙箱运行时（例如 Windows 的 WSL2 发行版）
  projects/{project_id}/checkpoints/       -- project 的影子 git 仓库
  bots/{bot_id}/
    memory.db                              -- 该 Bot 的记忆库
    wiki/                                  -- git
    skills/                                -- git，自建技能
    workspaces/{conversation_id}/
    maintenance/{loop_type}/
    browser/                               -- 该 Bot 的浏览器会话数据
  conversations/{conversation_id}/attachments/
```

## 数据库引擎

选择 **`better-sqlite3-multiple-ciphers`**，配合内置 FTS5 与 `sqlite-vec`。

- 成熟的 SQLite；默认使用带完整性校验的 ChaCha20-Poly1305 整库加密，也兼容 SQLCipher 格式。
- 三个平台的 x64 与 arm64 都有预编译包。
- 混合检索：FTS5 全文检索 + `sqlite-vec` 精确向量检索，用倒数排名融合（RRF）合并结果。每个 Bot 的记忆量级下，精确检索足够快且召回完整。
- 非 N-API 模块，需按 Electron 版本重新编译原生依赖（electron-builder 的 `install-app-deps`）。

不采用 libSQL 的原因：

- 只有整库加密，**没有字段级加密**；可用的算法只有 `aes256cbc`，没有完整性校验。
- 没有 Windows arm64 构建。
- JS 客户端中 FTS5 是否可用尚未明确；向量索引存在已知缺陷。
- Turso 的新 Rust 版本中加密仍是实验性功能。

持续关注 Turso Database，待其 1.0 且加密不再是实验性功能后再评估。

## 库文件划分

| 库 | 内容 |
|---|---|
| `main.db` | 消息、对话、Bot 注册表与 Profile、Project、用户画像、定时任务、待发送队列、授权与审批、技能库、各 Bot 的技能安装记录与公共技能（public_skills）、环境安装记录、用量账本、敏感数据表 |
| `runs.db` | 执行记录与步骤（体积大，独立清理与压缩，不影响聊天读写） |
| `bots/{bot_id}/memory.db` | 该 Bot 的记忆条目、FTS5 索引、向量索引；删除 Bot 时连同目录一起删除 |

- 全部启用 WAL 模式，设置 `busy_timeout`，写事务保持短小。
- **所有数据库连接只由核心服务持有**，界面通过 IPC 访问；加密密钥不进入界面进程。
- 跨库事务不是原子的，写入设计上避免依赖跨库原子性。
- Bot 记忆库按需打开，不同时挂载全部。
- **运行时元数据统一存放在数据库中**（Bot Profile、技能安装记录、环境安装记录）；文件系统只存放文件类内容（Wiki、Skills 内容、workspace、附件、检查点）。

## 加密

- 首次运行生成随机 32 字节主密钥，存入系统钥匙串（`@napi-rs/keyring`）。
  - Linux 上强制使用 Secret Service；不允许退回到内核密钥环，它在重启后丢失，会导致数据无法解密。
- 没有可用钥匙串时（例如无桌面环境的 Linux），要求用户设置口令，用 Argon2id 从口令派生主密钥。**明文密钥永远不写入磁盘。**
- 用 HKDF 从主密钥为每个库派生独立密钥，另派生一把敏感数据专用密钥。
- 设置 `PRAGMA temp_store=MEMORY`，避免临时数据落盘。
- 文件类数据（Wiki、Skills、workspace、附件、检查点）不做应用层加密：沙箱和工具需要直接读写，依赖操作系统的磁盘加密保护。

## 敏感数据（API key 等凭据）

- 存放在 `main.db` 的敏感数据表中，在整库加密之上再做**字段级加密**（AES-256-GCM，以记录 id 作为附加认证数据）。
- 只在核心服务发出请求的那一刻解密。
- LLM 与工具只能看到代号（例如 `secret://openai`），执行记录中的敏感值自动脱敏。
- 永远不发送到界面；界面只显示掩码。

## git

- Wiki、Skills、project 检查点使用 **`es-git`**（基于 libgit2，六种平台架构都有预编译包，支持回退提交）。
- 备选：isomorphic-git（纯 JS，无原生依赖，但没有 revert，需要用“恢复旧版本再提交”实现）。
