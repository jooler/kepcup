// Set synchronously once the host commits to shutting down (Electron will-quit).
// KepCup 垫片（orca src/main/host-shutdown-state.ts 原样复制）：主线集成层在 will-quit
// 时调用 markHostShuttingDown。
let hostShuttingDown = false

export function markHostShuttingDown(): void {
  hostShuttingDown = true
}

export function isHostShuttingDown(): boolean {
  return hostShuttingDown
}
