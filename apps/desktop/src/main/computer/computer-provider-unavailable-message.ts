export function computerProviderUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return [
      'computer-use has no native provider for darwin because KepCup Computer Use.app was not found or this macOS version is unsupported.',
      'For local development, run node scripts/build-computer-use-macos.mjs and restart KepCup from this worktree.'
    ].join(' ')
  }
  if (platform === 'linux' || platform === 'win32') {
    const runtime =
      platform === 'linux' ? 'computer-use-linux/runtime.py' : 'computer-use-windows/runtime.ps1'
    return `Computer use isn't available on this host: the host install has no ${runtime}. The install predates computer use; update or rebuild.`
  }
  return `computer-use has no native provider for ${platform}`
}
