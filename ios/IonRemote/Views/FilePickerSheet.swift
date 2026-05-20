import SwiftUI

/// Modal sheet that browses the desktop filesystem using fsListDir.
/// The user navigates directories and selects a file to attach.
struct FilePickerSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let initialDirectory: String
    let onSelect: (String, String) -> Void  // (path, name)

    @State private var currentDir: String = ""
    @State private var dirStack: [String] = []

    private var listing: FsDirListingResponse? {
        viewModel.fileListings[currentDir]
    }

    private var isLoading: Bool {
        viewModel.fileListingLoading.contains(currentDir)
    }

    var body: some View {
        NavigationStack {
            Group {
                if isLoading && listing == nil {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = listing?.error {
                    ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if let entries = listing?.entries, !entries.isEmpty {
                    fileList(entries)
                } else {
                    ContentUnavailableView("Empty Folder", systemImage: "folder", description: Text("No files here"))
                }
            }
            .navigationTitle(currentDirName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                if dirStack.count > 0 {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            if let parent = dirStack.popLast() {
                                currentDir = parent
                                requestListing()
                            }
                        } label: {
                            Image(systemName: "chevron.up")
                        }
                    }
                }
            }
        }
        .onAppear {
            currentDir = initialDirectory
            requestListing()
        }
    }

    private var currentDirName: String {
        (currentDir as NSString).lastPathComponent
    }

    private func fileList(_ entries: [FsEntry]) -> some View {
        List(entries, id: \.path) { entry in
            Button {
                if entry.isDirectory {
                    dirStack.append(currentDir)
                    currentDir = entry.path
                    requestListing()
                } else {
                    onSelect(entry.path, entry.name)
                    dismiss()
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: entry.isDirectory ? "folder.fill" : fileIcon(entry.name))
                        .foregroundStyle(entry.isDirectory ? .blue : .secondary)
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.name)
                            .lineLimit(1)
                        if !entry.isDirectory {
                            Text(formatSize(entry.size))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Spacer()
                    if entry.isDirectory {
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .foregroundStyle(.primary)
        }
        .listStyle(.plain)
    }

    private func requestListing() {
        guard !currentDir.isEmpty else { return }
        viewModel.requestFsListDir(directory: currentDir)
    }

    private func fileIcon(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        let imageExts: Set = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
        if imageExts.contains(ext) { return "photo" }
        return "doc"
    }

    private func formatSize(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        if bytes < 1024 * 1024 { return "\(bytes / 1024) KB" }
        return String(format: "%.1f MB", Double(bytes) / 1_048_576)
    }
}
