import Foundation

/// D94（docs/design/44-macos-share-extension.md §9）：扩展侧的常量与路径。
///
/// 扩展只做三件事：接收系统分享的 payload、在 App Group 里写一个批次目录、
/// 唤起主应用。它不读 `~/.kepcup`、不调 core、不联网、不跑模型。
enum SharedConfig {
    /// 构建期注入完整组 id 的 Info.plist 键（scripts/build-share-extension.mjs
    /// 在签名前写入）。
    static let groupIdInfoPlistKey = "KEPCUPShareGroupId"

    /// App Group 标识。签名的正式构建由构建脚本把 entitlements 展开后的完整组 id
    /// （`<TeamID>.app.kepcup.desktop`）写进 Info.plist——`containerURL` 要求它
    /// 与 entitlements 里的值逐字一致，硬编码的无前缀常量拿不到容器。dev 未签名
    /// 构建读不到注入值，回退无前缀常量（此时 entitlements 里也没有 App Group
    /// 权限，写批次会明确报错）。
    static let appGroupIdentifier: String = {
        if
            let injected = Bundle.main.infoDictionary?[groupIdInfoPlistKey] as? String,
            !injected.isEmpty
        {
            return injected
        }
        return "app.kepcup.desktop"
    }()

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

    /// 附言按 UTF-16 码元截断——主进程的 zod schema 用 `.max(2000)`（UTF-16 计数），
    /// Swift 的 `String.prefix` 数的是字形簇，两者对 emoji 等增补平面字符数出来的
    /// 长度不一样，按 UTF-16 截才对齐。
    static func clampedNote(_ note: String) -> String {
        let units = note.utf16
        guard units.count > maxNoteChars else { return note }
        // 截断点落在代理对中间时，String(decoding:as:) 会用 U+FFFD 补位——总长
        // 仍 ≤ 2000 码元，schema 校验照样通过。
        return String(decoding: units.prefix(maxNoteChars), as: UTF16.self)
    }

    /// 收集整体超时（秒）：超时后带已收集的内容继续——items 少了总比永远空白好。
    static let collectTimeoutSeconds: Double = 30

    /// 清洗后的文件名字节上限：文件系统 NAME_MAX 是 255 字节（UTF-8 计）。
    static let maxNameBytes = 255

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
