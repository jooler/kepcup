import Foundation

/// D94（docs/design/44-macos-share-extension.md §9）：扩展侧的常量与路径。
///
/// 扩展只做三件事：接收系统分享的 payload、在 App Group 里写一个批次目录、
/// 唤起主应用。它不读 `~/.kepcup`、不调 core、不联网、不跑模型。
enum SharedConfig {
    /// App Group 标识（与主应用 entitlements 一致；`$(TeamIdentifierPrefix)` 在
    /// 签名时展开，最终以 Apple 配置为准）。
    static let appGroupIdentifier = "app.kepcup.desktop"

    /// 主应用的 URL Scheme（与 electron-builder.yml 的 CFBundleURLTypes 一致）。
    static let urlScheme = "kepcup"

    /// 批次目录名（`share-inbox/{intakeId}/`）。
    static let inboxDirName = "share-inbox"

    /// 目标快照文件名。
    static let targetsFileName = "targets.v1.json"

    /// 每次分享最多 10 个文件。
    static let maxFiles = 10

    /// 单文件 30MB。
    static let maxFileBytes = 30_000_000

    /// 单次总量 60MB。
    static let maxTotalBytes = 60_000_000

    /// 附言 2000 字符。
    static let maxNoteChars = 2000

    /// 批次 id 前缀（`shr_` + UUID）。
    static let intakeIdPrefix = "shr_"

    /// App Group 容器目录；拿不到（没装 entitlement / 非 macOS）时返回 nil。
    static var groupContainerURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        )
    }

    /// 扩展写批次的地方：`{group}/share-inbox/`。
    static var inboxRootURL: URL? {
        groupContainerURL?.appendingPathComponent(inboxDirName, isDirectory: true)
    }

    /// 主应用写目标快照的地方：`{group}/targets.v1.json`。
    static var targetsURL: URL? {
        groupContainerURL?.appendingPathComponent(targetsFileName, isDirectory: false)
    }

    /// 唤起主应用的 URL。
    static func wakeURL(intakeId: String) -> URL? {
        var components = URLComponents()
        components.scheme = urlScheme
        components.host = "share-intake"
        components.queryItems = [URLQueryItem(name: "id", value: intakeId)]
        return components.url
    }

    /// 新批次 id：`shr_` + UUID（大写、无连字符）。
    static func newIntakeId() -> String {
        intakeIdPrefix + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }
}
