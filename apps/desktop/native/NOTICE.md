# Vendored 原生代码声明（computer-use）

`computer-use-macos/` 目录整体搬运自 [stablyai/orca](https://github.com/stablyai/orca)
（MIT）的 `native/computer-use-macos`，快照 commit `55507b87`（v1.4.214）。

**搬运约定（docs/design/52-computer-use.md D105）**：Sources / Tests / Package.swift
原样照搬（包括包名 `OrcaComputerUseMacOS*` 与产物名
`orca-computer-use-macos`），保持与上游的 diff 能力；重命名（bundle 显示名
`KepCup Computer Use`、bundle id `app.kepcup.desktop.computer-use`）、图标与签名
只发生在构建脚本 `scripts/build-computer-use-macos.mjs` 里，不碰本目录。
上游跟进走人工 diff，不自动同步。

**例外（均已向用户报备，见 docs/dev/DEVIATIONS.md DEV-077 / DEV-082）**：

1. `Sources/OrcaComputerUseMacOSCore/TrustedOrcaApplication.swift`
   在信任列表追加了 `app.kepcup.desktop`（精确 + 点号前缀）两条——helper 的 socket
   peer 校验硬编码了 orca 自己的 bundle id，KepCup 打包版（`app.kepcup.desktop`）
   不改动此文件就永远连不上 helper；dev 壳 `com.github.Electron` 本就在上游列表内。
   改动是纯增量（上游条目全部保留），语义与该文件的定位（宿主身份配置）一致。
2. `Sources/OrcaComputerUseMacOS/main.swift` 的**用户可见显示文案**品牌化（2026-10-31，
   真机冒烟发现错误文案原样返回给用户与 Bot）：错误文案、权限引导窗口标题 / 副标题、
   stderr 提示里的 `Orca Computer Use` / `Orca` → `KepCup Computer Use` / `KepCup`；
   另有一处失效指引改写（`Run \`orca computer permissions\`` 是上游 CLI，KepCup 没有
   ——保留会误导用户，改为只指设置页）。标识符（`orca-computer-use-macos`、
   `ORCA_*` env、socket 前缀、`OrcaComputerUse*` 包名）一律不动——它们是协议与
   peer 校验的一部分。上游条目语义全保留。

## 路径映射

| 本仓库 | 上游（stablyai/orca @ 55507b87） |
| --- | --- |
| `apps/desktop/native/computer-use-macos/` | `native/computer-use-macos/` |
| `apps/desktop/scripts/build-computer-use-macos.mjs`（改造） | `config/scripts/build-computer-macos.mjs` |
| `apps/desktop/src/main/computer/`（TS 编排层，移植） | `src/main/computer/` |
| `packages/shared/src/domain/computer.ts`（契约，裁剪自） | `src/shared/computer-use-runtime-types.ts` |

改动说明：`Sources/OrcaComputerUseMacOSCore/TrustedOrcaApplication.swift` 追加
KepCup bundle id 两条 + `Sources/OrcaComputerUseMacOS/main.swift` 显示文案品牌化
（见上「例外」），其余文件零修改（`diff -rq` 与上游一致）。

## 许可证（上游 LICENSE 全文）

MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
