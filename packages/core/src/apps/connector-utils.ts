/** 连接器领域的通用纯函数（原 directory-merge.ts 的存活部分；目录通道已随商店化移除）。 */

interface ParsedVersion {
  core: [number, number, number];
  pre: string | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ?? null,
  };
}

/** semver 比较（构建元数据忽略；预发行 < 正式）；任一方不可解析 = null。 */
export function compareConnectorVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  for (let i = 0; i < 3; i++) {
    const delta = (left.core[i] as number) - (right.core[i] as number);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const lp = left.pre.split('.');
  const rp = right.pre.split('.');
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    const x = lp[i];
    const y = rp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
