import SwiftUI

/// 目标选择 + 附言（D94 §9.2）。
///
/// 列表读主应用写的 `targets.v1.json`：读不到就显示「打开 KepCup 同步列表」
/// 并禁止确认；快照过期只提示，仍可选（core 确认时按实时数据校验）。
struct TargetPickerView: View {
    /// 收集到的文件（用于展示数量与总大小）。
    let files: [CollectedFile]
    /// 确认回调：目标与附言。
    let onConfirm: (ShareManifest.Target, String) -> Void
    /// 取消回调。
    let onCancel: () -> Void

    @State private var targets: ShareTargets?
    @State private var targetsMissing = false
    @State private var targetsStale = false
    @State private var query = ""
    @State private var note = ""
    @State private var selected: ShareManifest.Target?

    private var bots: [ShareTargets.Entry] {
        let all = targets?.bots ?? []
        return query.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    private var projects: [ShareTargets.Entry] {
        let all = targets?.projects ?? []
        return query.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }

    private var totalBytes: Int {
        files.reduce(0) { $0 + $1.bytes.count }
    }

    private var noteTooLong: Bool {
        note.count > SharedConfig.maxNoteChars
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if targetsMissing {
                Text("无法读取目标列表。请打开 KepCup 让它同步一次，再回到这里重试。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                if targetsStale {
                    Text("目标列表可能已过期，确认时以 KepCup 为准。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                searchField
                targetList
            }
            summary
            noteField
            actions
        }
        .padding(16)
        .frame(minWidth: 380, idealWidth: 420, maxWidth: 520)
        .task { loadTargets() }
    }

    private var header: some View {
        HStack {
            Text("导入到 KepCup")
                .font(.headline)
            Spacer()
        }
    }

    private var searchField: some View {
        TextField("搜索 Bot 或项目组", text: $query)
            .textFieldStyle(.roundedBorder)
    }

    private var targetList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if !bots.isEmpty {
                    Text("Bot")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(bots) { entry in
                        targetRow(
                            id: entry.id,
                            name: entry.name,
                            archived: entry.archived,
                            kind: .bot
                        )
                    }
                }
                if !projects.isEmpty {
                    Text("项目组")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    ForEach(projects) { entry in
                        targetRow(
                            id: entry.id,
                            name: entry.name,
                            archived: entry.archived,
                            kind: .project
                        )
                    }
                }
            }
        }
        .frame(maxHeight: 220)
    }

    private func targetRow(
        id: String,
        name: String,
        archived: Bool,
        kind: ShareManifest.Target.Kind
    ) -> some View {
        let isSelected = selected?.id == id && selected?.kind == kind
        return Button {
            selected = ShareManifest.Target(kind: kind, id: id)
        } label: {
            HStack {
                Text(String(name.prefix(1)))
                    .font(.caption)
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(Color.secondary.opacity(0.2)))
                Text(name)
                    .lineLimit(1)
                if archived {
                    Text("（已归档）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.caption)
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var summary: some View {
        Text("\(files.count) 个文件 · \(ByteFormat.string(totalBytes))")
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private var noteField: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("附言（可留空）")
                .font(.caption)
                .foregroundStyle(.secondary)
            // macOS 12 没有 TextField(_:text:axis:)，用 TextEditor 起多行。
            TextEditor(text: $note)
                .font(.body)
                .frame(height: 56)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.25))
                )
            if noteTooLong {
                Text("附言最多 \(SharedConfig.maxNoteChars) 字")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var actions: some View {
        HStack {
            Button("取消", action: onCancel)
                .keyboardShortcut(.cancelAction)
            Spacer()
            Button("导入") {
                guard let selected else { return }
                onConfirm(selected, String(note.prefix(SharedConfig.maxNoteChars)))
            }
            .keyboardShortcut(.defaultAction)
            .disabled(selected == nil || targetsMissing || noteTooLong)
        }
    }

    private func loadTargets() {
        switch ShareTargetsStore.load() {
        case let .ok(loaded, isStale):
            targets = loaded
            targetsMissing = false
            targetsStale = isStale
        case .missing:
            targets = nil
            targetsMissing = true
        case .invalid:
            targets = nil
            targetsMissing = true
        }
    }
}

/// 字节数的人话格式。
enum ByteFormat {
    static func string(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes)B" }
        if bytes < 1024 * 1024 { return "\(Int((Double(bytes) / 1024).rounded()))KB" }
        return String(format: "%.1fMB", Double(bytes) / 1024 / 1024)
    }
}
