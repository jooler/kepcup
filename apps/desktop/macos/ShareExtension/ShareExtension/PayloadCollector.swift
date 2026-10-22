import CryptoKit
import Foundation
import UniformTypeIdentifiers

/// 扩展收到的一个待导入文件。
struct CollectedFile {
    /// 原始文件名（已清洗 basename）。
    let originalName: String
    /// 推断出的 MIME（不信任扩展名；未知用 octet-stream）。
    let mime: String
    /// 暂存后的字节。
    let bytes: Data
}

/// 从系统分享的 `NSExtensionItem` 里收集文件与纯文本。
///
/// 契约不绑微信：任何来源的 Share sheet 走同一条路。文件按 file-url 读；
/// 纯文本（分享的是一段文字而不是文件）落成 `.txt` 附件——不塞进消息正文。
enum PayloadCollector {
    /// 系统分享的纯文本类型（按优先级）。
    private static let textTypeIdentifiers = [
        UTType.plainText.identifier,
        UTType.text.identifier,
        UTType.utf8PlainText.identifier,
    ]

    static func collect(from items: [NSExtensionItem]) async -> [CollectedFile] {
        var collected: [CollectedFile] = []
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                    if let file = await loadFile(provider) {
                        collected.append(file)
                        if collected.count >= SharedConfig.maxFiles { return collected }
                    }
                    continue
                }
                if let textType = textTypeIdentifiers.first(where: {
                    provider.hasItemConformingToTypeIdentifier($0)
                }) {
                    if let text = await loadText(provider, typeIdentifier: textType) {
                        collected.append(
                            CollectedFile(
                                originalName: "shared-text.txt",
                                mime: "text/plain",
                                bytes: Data(text.utf8)
                            )
                        )
                        if collected.count >= SharedConfig.maxFiles { return collected }
                    }
                }
            }
        }
        return collected
    }

    private static func loadFile(_ provider: NSItemProvider) async -> CollectedFile? {
        let url: URL? = await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) {
                item, _ in
                continuation.resume(returning: item as? URL)
            }
        }
        guard let url else { return nil }

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
        if let size = values?.fileSize, size == 0 { return nil }
        if size(for: url) > SharedConfig.maxFileBytes { return nil }

        guard let bytes = coordinatedRead(url) else { return nil }
        if bytes.count > SharedConfig.maxFileBytes { return nil }

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
        return trimmed.isEmpty ? "file" : trimmed
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
