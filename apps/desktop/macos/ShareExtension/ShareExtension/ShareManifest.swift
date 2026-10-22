import Foundation

/// 扩展 → 主应用的 manifest（与 packages/shared/src/domain/share.ts 的
/// `shareManifestSchema` 一一对应）。主进程用同一份 schema 校验。
struct ShareManifest: Codable {
    struct Target: Codable {
        enum Kind: String, Codable {
            case bot
            case project
        }

        let kind: Kind
        let id: String
    }

    struct File: Codable {
        /// 批次目录内的暂存名（`000-chat.zip`）：只作相对名，不作路径。
        let stagedName: String
        let originalName: String
        let mime: String
        let size: Int
        let sha256: String
    }

    let version: Int
    let intakeId: String
    let createdAt: Double
    let target: Target
    let note: String
    let files: [File]
}

/// 主应用写的目标快照（`targets.v1.json`，与 shared 的 `shareTargetsSchema`
/// 一一对应）。只含 id、显示名、类型与归档状态。
struct ShareTargets: Codable {
    struct Entry: Codable, Identifiable {
        enum Kind: String, Codable {
            case bot
            case project
        }

        let id: String
        let name: String
        let kind: Kind
        let archived: Bool
    }

    let version: Int
    let generatedAt: Double
    let bots: [Entry]
    let projects: [Entry]
}
