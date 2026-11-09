export function computerProviderUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return [
      'computer-use has no provider on darwin because CuaDriver.app was not found or its version pin is missing.',
      'For local development, run node scripts/fetch-cua-driver.mjs and restart KepCup from this worktree.'
    ].join(' ')
  }
  return `computer-use is not enabled on ${platform} yet (the CuaDriver integration currently targets macOS).`
}
