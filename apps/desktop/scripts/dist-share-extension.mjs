/**
 * dist.mjs 的 Share Extension 决策纯函数（D94，docs/design/44-macos-share-extension.md §10）。
 *
 * dist.mjs 本体是顶层顺序执行的脚本，没有可 import 的出口——可单测的判定逻辑
 * 拆到这里：
 *  - `macTargetArchesFromYml` / `macTargetArches`：要构建哪些架构的 appex。
 *    裸 `pnpm dist --mac`（无架构参数）时 electron-builder 按配置文件的双架构
 *    （[arm64, x64]）各跑一个 pass，appex 必须备齐两份，缺的那份会让第二个
 *    pass 硬失败——所以无参数时默认对齐 yml 声明，而不是只出宿主架构。
 *  - `shareExtensionSkipPlan`：构建脚本跑完后按产物存在性决定是否随包发行
 *    （没有 Xcode 的本地构建跳过；跳过时 dist.mjs 还要清掉上次的陈旧产物）。
 */

/** electron-builder.yml 里 mac.target 各条目声明的架构（去重、保持声明顺序）。 */
export function macTargetArchesFromYml(raw) {
  const macKey = /^mac:\s*$/m.exec(raw);
  if (macKey === null) return [];
  const after = raw.slice(macKey.index + macKey[0].length);
  // mac 块的子键都有缩进：下一个顶格行就是块结束。
  const nextTop = /^[^\s#]/m.exec(after);
  const section = nextTop === null ? after : after.slice(0, nextTop.index);
  const arches = [];
  for (const list of section.matchAll(/arch:\s*\[([^\]]*)\]/g)) {
    for (const item of list[1].split(',')) {
      const arch = item.trim().replace(/^['"]|['"]$/g, '');
      if (arch.length > 0) arches.push(arch);
    }
  }
  return [...new Set(arches)];
}

/**
 * dist 目标的 mac 架构：命令行显式给的优先；裸 `--mac` 时用 yml 的声明（读不出
 * 时退 [arm64, x64]，与今天的 electron-builder.yml 一致）；不是 mac 目标时空。
 */
export function macTargetArches(builderArgs, ymlArches) {
  if (!builderArgs.includes('--mac')) return [];
  const explicit = builderArgs
    .filter((arg) => arg === '--arm64' || arg === '--x64')
    .map((arg) => arg.slice(2));
  if (explicit.length > 0) return [...new Set(explicit)];
  const fromYml = Array.isArray(ymlArches) ? ymlArches.filter((arch) => typeof arch === 'string') : [];
  return fromYml.length > 0 ? fromYml : ['arm64', 'x64'];
}

/**
 * appex 是否备齐：任一架构缺产物就整体跳过（`skip: true` + 缺失清单）。跳过的
 * 产物不能只警告——`resources/share-extension` 已 gitignore，上次构建的陈旧
 * appex 会被 electron-builder 静默打包，调用方在 skip 时应整个删掉该目录。
 */
export function shareExtensionSkipPlan({ arches, appexExists }) {
  const missing = arches.filter((arch) => !appexExists(arch));
  return { skip: missing.length > 0, missing };
}
