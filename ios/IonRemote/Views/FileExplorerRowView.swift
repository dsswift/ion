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

    /// Path relative to the root working directory.
    private var relativePath: String {
        let prefix = rootDirectory.hasSuffix("/") ? rootDirectory : rootDirectory + "/"
        if entry.path.hasPrefix(prefix) {
            return String(entry.path.dropFirst(prefix.count))
        }
        return entry.path
    }

    var body: some View {
        if entry.isDirectory {
            directoryRow
        } else {
            fileRow
        }
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
    }
}
