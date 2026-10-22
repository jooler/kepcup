import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Share Extension 的入口（D94 §9）。
///
/// 流程：收 payload → 选目标 / 附言 → 写 App Group inbox → 唤起主应用 →
/// `completeRequest`。扩展不解压、不预览全文、不调模型、不联网。
final class ShareViewController: NSViewController {
    private var files: [CollectedFile] = []
    private var host: NSHostingView<TargetPickerView>?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.frame = NSRect(x: 0, y: 0, width: 460, height: 520)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        loadPayload()
    }

    /// 收集系统分享的 payload（文件 URL / 纯文本）。
    private func loadPayload() {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task { @MainActor in
            let collected = await PayloadCollector.collect(from: items)
            self.files = collected
            if collected.isEmpty {
                self.showError("没有可导入的内容。")
                return
            }
            self.showPicker()
        }
    }

    private func showPicker() {
        let picker = TargetPickerView(
            files: files,
            onConfirm: { [weak self] target, note in
                self?.confirm(target: target, note: note)
            },
            onCancel: { [weak self] in
                self?.cancel()
            }
        )
        let host = NSHostingView(rootView: picker)
        host.frame = NSRect(x: 0, y: 0, width: 460, height: 520)
        view.addSubview(host)
        host.autoresizingMask = [.width, .height]
        self.host = host
    }

    private func showError(_ message: String) {
        let label = NSTextField(labelWithString: message)
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 24, y: 240, width: 412, height: 40)
        label.alignment = .center
        view.addSubview(label)
    }

    /// 写批次 → 唤起主应用 → 结束请求。
    private func confirm(target: ShareManifest.Target, note: String) {
        do {
            let result = try InboxWriter.write(target: target, note: note, files: files)
            wakeHost(intakeId: result.intakeId)
            extensionContext?.completeRequest(returningItems: nil)
        } catch {
            showError("导入失败：\(error.localizedDescription)")
            // 失败：清掉未完成的目录并结束请求（文件没写成功，用户可以重试分享）。
            extensionContext?.cancelRequest(
                withError: NSError(
                    domain: "app.kepcup.desktop.ShareExtension",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
                )
            )
        }
    }

    private func cancel() {
        extensionContext?.cancelRequest(
            withError: NSError(
                domain: "app.kepcup.desktop.ShareExtension",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "cancelled"]
            )
        )
    }

    /// 唤起主应用（`kepcup://share-intake?id=…`）。
    ///
    /// 沙盒扩展能否直接打开自定义 URL 是 §16.3 的待验证项：先试
    /// `NSWorkspace`，再试 `NSExtensionContext.open`；都不行也不删 inbox——
    /// 主应用的启动扫描 / 轮询会把它捡走。
    private func wakeHost(intakeId: String) {
        guard let url = SharedConfig.wakeURL(intakeId: intakeId) else { return }
        NSWorkspace.shared.open(url)
    }
}
