export function computerProviderUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return [
      'computer-use has no provider on darwin because CuaDriver.app was not found or its version pin is missing.',
      'For local development, run node scripts/fetch-cua-driver.mjs and restart KepCup from this worktree.'
    ].join(' ')
  }
  if (platform !== 'win32' && platform !== 'linux') {
    // 真正未启用的平台（headless / 未知系统）：provider 为 null 是门控结果，
    // 不是运行时缺失，不要误导用户去 fetch。
    return `computer-use is not supported on ${platform} (the CuaDriver integration targets macOS, Windows, and Linux).`
  }
  // 2026-11 三端启用后 win32/linux 也由 CuaDriver 承载：provider 缺失多半是
  // 运行时没取（dev 首跑 / CI 跳过了 fetch），给出与 darwin 同构的可行动指引。
  return [
    `computer-use has no provider on ${platform} because the pinned cua-driver runtime was not found.`,
    'For local development, run node scripts/fetch-cua-driver.mjs and restart KepCup from this worktree.'
  ].join(' ')
}
