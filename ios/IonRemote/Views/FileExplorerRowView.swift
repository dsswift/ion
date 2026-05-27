import SwiftUI
import UIKit

/// A single row in the file explorer: directory or file entry with indentation.
struct FileExplorerRowView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let entry: FsEntry
    let depth: Int
    let isExpanded: Bool
    let rootDirectory: String
    let onTap: () -> Void

    /// Inline-rename UI state. The alert presents a `TextField` pre-filled
    /// with the entry's current name; submitting builds `newPath` under
    /// the same parent and dispatches `requestFsRename`. The desktop
    /// validates both paths and replies with `fs_rename_result`, which
    /// `SessionViewModel+EventHandlers` consumes to refresh the parent
    /// directory listing. We don't optimistically mutate local state —
    /// the listing comes back from the desktop.
    @State private var showRenameAlert = false
    @State private var renameText = ""

    /// Path relative to the root working directory.
    private var relativePath: String {
        let prefix = rootDirectory.hasSuffix("/") ? rootDirectory : rootDirectory + "/"
        if entry.path.hasPrefix(prefix) {
            return String(entry.path.dropFirst(prefix.count))
        }
        return entry.path
    }

    var body: some View {
        Group {
            if entry.isDirectory {
                directoryRow
            } else {
                fileRow
            }
        }
        .alert("Rename", isPresented: $showRenameAlert) {
            TextField("Name", text: $renameText)
                // File names should never autocapitalize or get
                // autocorrected. Matches the rename-tab alert in
                // `TabListView.swift` and the create-file flow on
                // desktop, which never alters typed text.
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Rename") { submitRename() }
            Button("Cancel", role: .cancel) {
                showRenameAlert = false
            }
        } message: {
            Text("Enter a new name for \(entry.name).")
        }
    }

    /// Build `newPath` under the same parent as `entry.path` and dispatch
    /// the remote command. Trimming the field defends against accidental
    /// whitespace; an empty or unchanged name is a silent no-op so the
    /// user isn't punished for opening the alert by accident.
    private func submitRename() {
        let trimmed = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != entry.name else {
            showRenameAlert = false
            return
        }
        let parent = (entry.path as NSString).deletingLastPathComponent
        let newPath = parent.isEmpty ? trimmed : "\(parent)/\(trimmed)"
        viewModel.requestFsRename(oldPath: entry.path, newPath: newPath)
        showRenameAlert = false
    }

    // MARK: - Directory Row

    private var directoryRow: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Spacer()
                    .frame(width: CGFloat(depth) * 20)

                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 12)

                Image(systemName: isExpanded ? "folder.fill" : "folder")
                    .font(.subheadline)
                    .foregroundStyle(Color.accentColor)

                Text(entry.name)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu { copyMenuItems }
    }

    // MARK: - File Row

    private var fileRow: some View {
        NavigationLink {
            FileEditorView(filePath: entry.path, fileName: entry.name)
                .environment(viewModel)
        } label: {
            HStack(spacing: 8) {
                Spacer()
                    .frame(width: CGFloat(depth) * 20)

                // Placeholder for chevron alignment
                Color.clear
                    .frame(width: 12)

                Image(systemName: entry.iconName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Text(entry.name)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()

                Text(entry.formattedSize)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu { copyMenuItems }
    }

    // MARK: - Context Menu

    @ViewBuilder
    private var copyMenuItems: some View {
        Button { UIPasteboard.general.string = entry.path } label: {
            Label("Copy Path", systemImage: "doc.on.doc")
        }
        Button { UIPasteboard.general.string = relativePath } label: {
            Label("Copy Relative Path", systemImage: "doc.on.doc")
        }
        Button {
            // Seed the field with the current name and present the alert
            // on the next runloop. Setting both flags in the same tick
            // is safe because SwiftUI's alert reads `renameText` when
            // the binding triggers, not before.
            renameText = entry.name
            showRenameAlert = true
        } label: {
            Label("Rename", systemImage: "pencil")
        }
    }
}
