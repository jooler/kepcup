import Foundation

/// 把一个批次写进 App Group inbox（D94 §5.1 / §9.4）。
///
/// 写入顺序：复制文件 → 逐文件算 SHA256 → 写 `manifest.json.tmp` → rename
/// 为 `manifest.json` → 最后写 `ready`。主进程只消费带 `ready` 的完整目录。
enum InboxWriter {
    enum WriteError: Error {
        case noAppGroup
        case noFiles
        case tooManyFiles
        case tooLarge
        case ioFailed(String)
    }

    struct Result {
        let intakeId: String
        let directory: URL
    }

    /// 写一个批次。失败时清掉未完成的目录（不留半成品）。
    static func write(
        target: ShareManifest.Target,
        note: String,
        files: [CollectedFile]
    ) throws -> Result {
        guard files.isEmpty == false else { throw WriteError.noFiles }
        guard files.count <= SharedConfig.maxFiles else { throw WriteError.tooManyFiles }
        let total = files.reduce(0) { $0 + $1.bytes.count }
        guard total <= SharedConfig.maxTotalBytes else { throw WriteError.tooLarge }

        guard let inboxRoot = SharedConfig.inboxRootURL else { throw WriteError.noAppGroup }
        let intakeId = SharedConfig.newIntakeId()
        let directory = inboxRoot.appendingPathComponent(intakeId, isDirectory: true)
        let filesDir = directory.appendingPathComponent("files", isDirectory: true)

        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: filesDir, withIntermediateDirectories: true)
        } catch {
            throw WriteError.ioFailed("create directory failed: \(error.localizedDescription)")
        }

        var manifestFiles: [ShareManifest.File] = []
        for (index, file) in files.enumerated() {
            let stagedName = String(format: "%03d-%@", index, file.originalName)
            let destination = filesDir.appendingPathComponent(stagedName, isDirectory: false)
            do {
                try file.bytes.write(to: destination, options: .atomic)
                try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            } catch {
                cleanup(directory)
                throw WriteError.ioFailed("write file failed: \(error.localizedDescription)")
            }
            manifestFiles.append(
                ShareManifest.File(
                    stagedName: stagedName,
                    originalName: file.originalName,
                    mime: file.mime,
                    size: file.bytes.count,
                    sha256: PayloadCollector.sha256(file.bytes)
                )
            )
        }

        let manifest = ShareManifest(
            version: 1,
            intakeId: intakeId,
            createdAt: Date().timeIntervalSince1970 * 1000,
            target: target,
            note: SharedConfig.clampedNote(note),
            files: manifestFiles
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let manifestData = try? encoder.encode(manifest) else {
            cleanup(directory)
            throw WriteError.ioFailed("encode manifest failed")
        }
        let manifestURL = directory.appendingPathComponent("manifest.json", isDirectory: false)
        let tempURL = directory.appendingPathComponent("manifest.json.tmp", isDirectory: false)
        do {
            try manifestData.write(to: tempURL, options: .atomic)
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tempURL.path)
            try fileManager.moveItem(at: tempURL, to: manifestURL)
        } catch {
            cleanup(directory)
            throw WriteError.ioFailed("write manifest failed: \(error.localizedDescription)")
        }

        // ready 最后写：主进程看到它就知道这个目录是完整的。
        let readyURL = directory.appendingPathComponent("ready", isDirectory: false)
        do {
            try Data().write(to: readyURL, options: .atomic)
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: readyURL.path)
        } catch {
            cleanup(directory)
            throw WriteError.ioFailed("write ready failed: \(error.localizedDescription)")
        }

        return Result(intakeId: intakeId, directory: directory)
    }

    /// 失败时清掉未完成的目录。
    private static func cleanup(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }
}
