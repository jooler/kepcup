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
    /// 当前状态文案（loading / 空态 / 写入失败）。复用同一个 label——每次
    /// `showMessage` 都新添一个会把前后两条文案叠印在一起。
    private var messageLabel: NSTextField?
    /// viewDidAppear 可能被系统连发：payload 只收集一次。
    private var didLoadPayload = false
    /// confirm 的重入保护：写入期间再点「发送」不重复写批次。
    private var finishing = false
    /// 终态提示（空 payload / 写入失败）停留多久后自动结束分享请求。
    private static let terminalMessageDismissDelay: TimeInterval = 4

    override func viewDidLoad() {
        super.viewDidLoad()
        view.frame = NSRect(x: 0, y: 0, width: 460, height: 520)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard !didLoadPayload else { return }
        didLoadPayload = true
        loadPayload()
    }

    /// 收集系统分享的 payload（文件 URL / 图片 / 影片 / 纯文本）。
    private func loadPayload() {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        showMessage(String(localized: "share.loading", defaultValue: "正在读取分享内容…"))
        Task { @MainActor in
            // collect 是非隔离的 async 函数：文件读取、校验与哈希都跑在协作
            // 线程池，主线程只负责 UI（扩展主线程卡顿会直接被系统杀掉）。
            let collected = await PayloadCollector.collect(from: items)
            self.files = collected
            if collected.isEmpty {
                // 空态没有取消按钮（picker 才有，而它不展示），系统分享面板也
                // 不带关闭控件——不主动结束请求，面板就永远关不掉（§9.4 要求
                // 失败态必须结束请求）。
                self.showEmptyAndDismiss()
                return
            }
            self.showPicker()
        }
    }

    /// 空 payload 终态：提示后按写入失败同款节奏自动取消分享请求。
    private func showEmptyAndDismiss() {
        showMessage(String(localized: "share.empty", defaultValue: "没有可发送的内容。"))
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.terminalMessageDismissDelay
        ) { [weak self] in
            self?.cancel()
        }
    }

    private func showPicker() {
        messageLabel?.removeFromSuperview()
        messageLabel = nil
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

    private func showMessage(_ message: String) {
        if let label = messageLabel {
            label.stringValue = message
            return
        }
        let label = NSTextField(labelWithString: message)
        label.font = .systemFont(ofSize: 13)
        label.textColor = .secondaryLabelColor
        label.frame = NSRect(x: 24, y: 240, width: 412, height: 40)
        label.alignment = .center
        view.addSubview(label)
        messageLabel = label
    }

    /// 写批次 → 唤起主应用 → 结束请求。写盘（30MB×N 的复制 + SHA256）放到
    /// 后台线程，主线程只更新状态；完成后回主队列收尾。
    private func confirm(target: ShareManifest.Target, note: String) {
        guard !finishing else { return }
        finishing = true
        let files = self.files
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let outcome: Result<InboxWriter.Result, Error> = Result {
                try InboxWriter.write(target: target, note: note, files: files)
            }
            DispatchQueue.main.async { self?.finishWrite(outcome) }
        }
    }

    private func finishWrite(_ outcome: Result<InboxWriter.Result, Error>) {
        switch outcome {
        case let .success(result):
            wakeHost(intakeId: result.intakeId)
            extensionContext?.completeRequest(returningItems: nil)
        case let .failure(error):
            // 失败先让用户看清错误（可再点「发送」重试；重试成功就不取消了），
            // 几秒后才结束请求——立即 cancelRequest 会让提示一闪而过。
            finishing = false
            showMessage(
                String(
                    localized: "share.write_failed",
                    defaultValue: "发送失败：\(error.localizedDescription)"
                )
            )
            DispatchQueue.main.asyncAfter(
                deadline: .now() + Self.terminalMessageDismissDelay
            ) { [weak self] in
                guard let self, !self.finishing else { return }
                self.cancelRequest(with: error)
            }
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

    private func cancelRequest(with error: Error) {
        extensionContext?.cancelRequest(
            withError: NSError(
                domain: "app.kepcup.desktop.ShareExtension",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
            )
        )
    }

    /// 唤起主应用（`kepcup://share-intake?id=…`）。
    ///
    /// 先试 `NSWorkspace.open`（返回 false 才算被拒——之前忽略返回值，注释与
    /// 实现不符），被拒时退 `NSExtensionContext.open`。两条路都不通也不删
    /// inbox——主应用的启动扫描 / 轮询会把它捡走（§16.3）。
    private func wakeHost(intakeId: String) {
        guard let url = SharedConfig.wakeURL(intakeId: intakeId) else { return }
        if NSWorkspace.shared.open(url) { return }
        extensionContext?.open(url) { _ in }
    }
}
