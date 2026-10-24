import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// 扩展收到的一个待导入文件。
struct CollectedFile {
    /// 原始文件名（已清洗 basename，≤255 字节）。
    let originalName: String
    /// 推断出的 MIME（不信任扩展名；未知用 octet-stream）。
    let mime: String
    /// 暂存后的字节。
    let bytes: Data
}

/// 从系统分享的 `NSExtensionItem` 里收集文件与纯文本。
///
/// 契约不绑微信：任何来源的 Share sheet 走同一条路。文件按 file-url 读；图片 /
/// 影片（Photos 分享常见）拿不到 file-url 时退 `loadItem`（in-place URL 直接收、
/// Data 按类型扩展名收）；纯文本（分享的是一段文字而不是文件）落成 `.txt`
/// 附件——不塞进消息正文。一个 item 多种表示时优先 file-url。
///
/// 全程有两条上限防线：单文件 30MB 在读取前用 resourceValues 预检、读取后复核；
/// 累计 60MB 达到即停止收集并丢弃超额项——扩展不能把用户内存当无底洞。
enum PayloadCollector {
    /// 系统分享的纯文本类型（按优先级）。
    private static let textTypeIdentifiers = [
        UTType.plainText.identifier,
        UTType.text.identifier,
        UTType.utf8PlainText.identifier,
    ]

    /// 图片 / 影片类型（Photos 分享；file-url 之外的第二条路，§9.3）。
    private static let mediaTypeIdentifiers = [
        UTType.image.identifier,
        UTType.movie.identifier,
    ]

    static func collect(from items: [NSExtensionItem]) async -> [CollectedFile] {
        var collected: [CollectedFile] = []
        var totalBytes = 0
        let deadline = Date().addingTimeInterval(SharedConfig.collectTimeoutSeconds)

        /// 收一个文件；返回 false = 到达数量 / 总量上限，停止收集。
        func add(_ file: CollectedFile) -> Bool {
            guard totalBytes + file.bytes.count <= SharedConfig.maxTotalBytes else { return false }
            collected.append(file)
            totalBytes += file.bytes.count
            return collected.count < SharedConfig.maxFiles
        }

        for item in items {
            for provider in item.attachments ?? [] {
                // 整体超时：带着已收集的内容返回（比永远空白好）。
                if Date() >= deadline { return collected }
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    if let file = await loadFile(provider), !add(file) { return collected }
                    continue
                }
                if let mediaType = mediaTypeIdentifiers.first(where: {
                    provider.hasItemConformingToTypeIdentifier($0)
                }) {
                    if
                        let file = await loadMedia(provider, typeIdentifier: mediaType),
                        !add(file)
                    { return collected }
                    continue
                }
                if let textType = textTypeIdentifiers.first(where: {
                    provider.hasItemConformingToTypeIdentifier($0)
                }) {
                    if let text = await loadText(provider, typeIdentifier: textType) {
                        let file = CollectedFile(
                            originalName: "shared-text.txt",
                            mime: "text/plain",
                            bytes: Data(text.utf8)
                        )
                        if !add(file) { return collected }
                    }
                }
            }
        }
        return collected
    }

    private static func loadFile(_ provider: NSItemProvider) async -> CollectedFile? {
        let item: NSSecureCoding? = await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) {
                item, _ in
                continuation.resume(returning: item)
            }
        }
        guard let url = decodedFileURL(item) else { return nil }
        return file(at: url)
    }

    /// `public.file-url` 的 loadItem 载荷不止 URL 一种形态：不少来源给 Data
    /// （URL 字符串 / plist / keyed-archiver 归档的 NSURL）或 String。只认 URL
    /// 会把这些分享全判成「没有可发送的内容」。
    private static func decodedFileURL(_ item: NSSecureCoding?) -> URL? {
        switch item {
        case let url as URL:
            return url
        case let string as String:
            return fileURLFromString(string)
        case let data as Data:
            return fileURLFromData(data)
        default:
            return nil
        }
    }

    private static func fileURLFromData(_ data: Data) -> URL? {
        // UTF-8 / UTF-16 文本形态（URL 字符串或裸路径）。
        if
            let string = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .utf16),
            let url = fileURLFromString(string)
        {
            return url
        }
        // plist 编码：纯字符串，或 NSURL 字典表示（NS.relative 是原始 URL 字符串）。
        if let decoded = try? PropertyListSerialization.propertyList(from: data, format: nil) {
            if let string = decoded as? String {
                if let url = fileURLFromString(string) { return url }
            } else if let dict = decoded as? [String: Any] {
                for key in ["NS.relative", "NSFileSystemPath", "NS.fileSystemPath"] {
                    if let string = dict[key] as? String, let url = fileURLFromString(string) {
                        return url
                    }
                }
            }
        }
        // keyed-archiver 归档的 NSURL（部分来源用 NSKeyedArchiver 打包）。
        if
            let url = try? NSKeyedUnarchiver.unarchivedObject(ofClass: NSURL.self, from: data),
            url.isFileURL
        {
            return url as URL
        }
        return nil
    }

    /// URL 字符串或裸路径 → 文件 URL。先按 URL 解析（保留百分号编码语义）；
    /// 裸路径（含未编码的空格 / 非 ASCII）解不出合法 URL 时按文件路径兜底。
    private static func fileURLFromString(_ string: String) -> URL? {
        if let url = URL(string: string), url.isFileURL { return url }
        guard !string.isEmpty, string.hasPrefix("/") else { return nil }
        return URL(fileURLWithPath: string)
    }

    /// 图片 / 影片：Photos 分享常给 in-place URL 或裸 Data（§9.3）。
    private static func loadMedia(
        _ provider: NSItemProvider,
        typeIdentifier: String
    ) async -> CollectedFile? {
        let item: NSSecureCoding? = await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                continuation.resume(returning: item)
            }
        }
        if let url = item as? URL {
            return file(at: url)
        }
        guard let data = item as? Data, !data.isEmpty else { return nil }
        if data.count > SharedConfig.maxFileBytes { return nil }
        let type = UTType(typeIdentifier)
        let ext = type?.preferredFilenameExtension ?? "bin"
        let suggested = sanitizeName(provider.suggestedName ?? "shared")
        let name = sanitizeName(suggested.hasSuffix(".\(ext)") ? suggested : "\(suggested).\(ext)")
        let mime = type?.preferredMIMEType ?? "application/octet-stream"
        return CollectedFile(originalName: name, mime: mime, bytes: data)
    }

    /// 校验并读一个文件 URL（file-url 与图片 / 影片的 in-place URL 共用）。
    static func file(at url: URL) -> CollectedFile? {
        // 系统分享给的是安全作用域 URL：读之前要开作用域，读完要关。
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped { url.stopAccessingSecurityScopedResource() }
        }

        // 拒绝目录、符号链接与包（.app / .bundle）。
        let values = try? url.resourceValues(forKeys: [
            .isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey,
        ])
        if values?.isDirectory == true || values?.isSymbolicLink == true { return nil }
        if values?.isRegularFile != true { return nil }
        // 零字节文件不收：core 侧 attachments.upload 明确拒绝空附件（"Attachment
        // is empty"），收了整批会在消费时失败。
        if let size = values?.fileSize, size == 0 { return nil }
        if size(for: url) > SharedConfig.maxFileBytes { return nil }

        guard let bytes = coordinatedRead(url) else { return nil }
        if bytes.count > SharedConfig.maxFileBytes { return nil }
        if bytes.isEmpty { return nil }

        let name = sanitizeName(url.lastPathComponent)
        let mime = mimeType(for: url)
        return CollectedFile(originalName: name, mime: mime, bytes: bytes)
    }

    private static func size(for url: URL) -> Int {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return values?.fileSize ?? 0
    }

    /// 云盘占位文件：先让 `NSFileCoordinator` 协调下载，再读；下载失败不写半成品。
    private static func coordinatedRead(_ url: URL) -> Data? {
        var coordinatorError: NSError?
        var data: Data?
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinatorError) {
            zippedURL in
            data = try? Data(contentsOf: zippedURL)
        }
        if coordinatorError != nil { return nil }
        return data
    }

    private static func loadText(_ provider: NSItemProvider, typeIdentifier: String) async -> String? {
        let text: String? = await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { item, _ in
                if let string = item as? String {
                    continuation.resume(returning: string)
                } else if let data = item as? Data {
                    continuation.resume(returning: String(data: data, encoding: .utf8))
                } else if let url = item as? URL {
                    continuation.resume(returning: try? String(contentsOf: url, encoding: .utf8))
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
        guard let text, !text.isEmpty else { return nil }
        return text
    }

    /// 文件名清洗：只留 basename，去掉控制字符与路径分隔符。
    static func sanitizeName(_ raw: String) -> String {
        let base = (raw as NSString).lastPathComponent
        let allowed = CharacterSet.alphanumerics
            .union(CharacterSet(charactersIn: "._- "))
            .union(CharacterSet(charactersIn: "-_"))
        let filtered = base.unicodeScalars.filter { allowed.contains($0) }.map(String.init).joined()
        let trimmed = filtered.trimmingCharacters(in: CharacterSet(charactersIn: " ."))
        guard !trimmed.isEmpty else { return "file" }
        return truncatingName(trimmed)
    }

    /// 文件名超 255 字节（NAME_MAX）时砍主名、保扩展名；按 UTF-8 标量边界截，
    /// 不产出半个字符。
    private static func truncatingName(_ name: String) -> String {
        guard name.utf8.count > SharedConfig.maxNameBytes else { return name }
        let nsName = name as NSString
        let ext = nsName.pathExtension
        let extPart = ext.isEmpty ? "" : ".\(ext)"
        let budget = SharedConfig.maxNameBytes - extPart.utf8.count
        guard budget > 0 else {
            // 扩展名自己就把预算吃光了：整名硬截（扩展名保不住，长度必须合法）。
            return String(decoding: name.utf8.prefix(SharedConfig.maxNameBytes), as: UTF8.self)
        }
        let stemLength = ext.isEmpty ? nsName.length : nsName.length - (ext as NSString).length - 1
        let stem = nsName.substring(to: max(0, stemLength))
        var kept = ""
        for scalar in stem.unicodeScalars {
            let width = UTF8.width(scalar)
            if kept.utf8.count + width > budget { break }
            kept.unicodeScalars.append(scalar)
        }
        return kept + extPart
    }

    /// MIME 用 UTType 推断（不信扩展名）；未知用 octet-stream。
    static func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension), let mime = type.preferredMIMEType {
            return mime
        }
        return "application/octet-stream"
    }

    /// 文件的 SHA256（小写十六进制）。
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
