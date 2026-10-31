// KepCup 垫片（orca src/shared/computer-use-permissions-types.ts 原样复制）。
// @kepcup/shared 暂无这组类型（不允许为移植补进 shared），先在本地定义；
// 主线如把权限类型提升进 shared，可整体改 import 并删除本文件。
export type ComputerUsePermissionId = 'accessibility' | 'screenshots'

export type ComputerUsePermissionStatus = 'granted' | 'not-granted' | 'unsupported'

export type ComputerUsePermissionState = {
  id: ComputerUsePermissionId
  status: ComputerUsePermissionStatus
}

export type ComputerUsePermissionStatusResult = {
  platform: NodeJS.Platform
  helperAppPath: string | null
  helperUnavailableReason: string | null
  permissions: ComputerUsePermissionState[]
}

export type ComputerUsePermissionSetupResult = {
  platform: NodeJS.Platform
  helperAppPath: string | null
  permissionId?: ComputerUsePermissionId
  openedSettings: boolean
  // True when a helper launched, is showing for a newer request, or is queued; older clients only read this.
  launchedHelper: boolean
  // Queued for when the 5s setup window reopens; a newer request or a reset may replace it.
  launchQueued?: boolean
  permissions?: ComputerUsePermissionState[]
  nextStep?: string | null
}

export type ComputerUsePermissionResetResult = ComputerUsePermissionStatusResult & {
  bundleId: string | null
}
