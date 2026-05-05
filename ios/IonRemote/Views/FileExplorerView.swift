import SwiftUI

/// Full-screen file explorer for browsing and editing files in a tab's working directory.
/// Presented via `.fullScreenCover` from `ConversationView`.
struct FileExplorerView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var expandedPaths: Set<String> = []
    @State private var loaded = false
    @State private var showHidden = false

    private var directory: String {
        viewModel.tab(for: tabId)?.workingDirectory ?? ""
    }

    private var directoryName: String {
        (directory as NSString).lastPathComponent
    }

    /// Flatten the tree into a list of (entry, depth) pairs for rendering.
    private var flatEntries: [(entry: FsEntry, depth: Int)] {
        guard let listing = viewModel.fileListings[directory] else { return [] }
        var result: [(entry: FsEntry, depth: Int)] = []
        appendEntries(listing.entries, depth: 0, into: &result)
        return result
    }

    private func appendEntries(
        _ entries: [FsEntry],
        depth: Int,
        into result: inout [(entry: FsEntry, depth: Int)]
    ) {
        for entry in entries {
            result.append((entry: entry, depth: depth))
            if entry.isDirectory && expandedPaths.contains(entry.path) {
                if let childListing = viewModel.fileListings[entry.path] {
                    appendEntries(childListing.entries, depth: depth + 1, into: &result)
                }
            }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let listing = viewModel.fileListings[directory] {
                    if let error = listing.error {
                        errorView(error)
                    } else if listing.entries.isEmpty {
                        emptyView
                    } else {
                        fileList
                    }
                } else {
                    ProgressView("Loading files…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle(directoryName.isEmpty ? "Files" : directoryName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showHidden.toggle()
                    } label: {
                        Image(systemName: showHidden ? "eye" : "eye.slash")
                    }
                    .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        refresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .task {
                guard !loaded else { return }
                loaded = true
                refresh()
            }
            .refreshable {
                refresh()
            }
            .onChange(of: showHidden) {
                expandedPaths.removeAll()
                refresh()
            }
        }
    }

    // MARK: - File List

    private var fileList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                let items = flatEntries
                ForEach(Array(items.enumerated()), id: \.element.entry.id) { _, item in
                    FileExplorerRowView(
                        entry: item.entry,
                        depth: item.depth,
                        isExpanded: expandedPaths.contains(item.entry.path)
                    ) {
                        handleTap(item.entry)
                    }

                    // Show loading indicator for expanded dir that's still loading
                    if item.entry.isDirectory
                        && expandedPaths.contains(item.entry.path)
                        && viewModel.fileListingLoading.contains(item.entry.path)
                        && viewModel.fileListings[item.entry.path] == nil {
                        HStack {
                            Spacer()
                                .frame(width: CGFloat(item.depth + 1) * 20 + 16)
                            ProgressView()
                                .controlSize(.small)
                                .padding(.vertical, 6)
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    // MARK: - Tap Handler

    private func handleTap(_ entry: FsEntry) {
        guard entry.isDirectory else { return }
        withAnimation(.easeInOut(duration: 0.2)) {
            if expandedPaths.contains(entry.path) {
                expandedPaths.remove(entry.path)
            } else {
                expandedPaths.insert(entry.path)
                viewModel.requestFsListDir(directory: entry.path, includeHidden: showHidden)
            }
        }
    }

    // MARK: - Error/Empty

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") { refresh() }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("Empty directory")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Refresh

    private func refresh() {
        guard !directory.isEmpty else { return }
        viewModel.requestFsListDir(directory: directory, includeHidden: showHidden)
    }
}
