import SwiftUI

/// Scrollable list of git commits with ref badges and pagination.
struct GitGraphListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let directory: String
    @State private var expandedCommitHash: String? = nil
    @State private var selectedCommitFileDiff: (hash: String, path: String)? = nil

    private var graphResponse: GitGraphResponse? {
        viewModel.gitGraph[directory]
    }

    private var commits: [GitCommitInfo] {
        graphResponse?.commits ?? []
    }

    private var hasMore: Bool {
        guard let response = graphResponse else { return false }
        return commits.count < response.totalCount
    }

    var body: some View {
        Group {
            if graphResponse == nil {
                HStack(spacing: 8) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Loading graph…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity)
            } else if commits.isEmpty {
                Text("No commits")
                    .foregroundStyle(.secondary)
                    .font(.caption)
                    .padding(.vertical, 8)
            } else {
                LazyVStack(spacing: 0) {
                    ForEach(Array(commits.enumerated()), id: \.element.id) { index, commit in
                        commitRow(commit, index: index)
                    }

                    if hasMore {
                        Button {
                            viewModel.requestGitGraph(
                                directory: directory,
                                skip: commits.count,
                                limit: 100
                            )
                        } label: {
                            Text("Load more commits…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 12)
                                .frame(maxWidth: .infinity)
                        }
                    }
                }
            }
        }
        .fullScreenCover(isPresented: Binding(
            get: { selectedCommitFileDiff != nil },
            set: { if !$0 { selectedCommitFileDiff = nil } }
        )) {
            if let sel = selectedCommitFileDiff {
                CommitFileDiffSheet(
                    hash: sel.hash,
                    path: sel.path,
                    onDismiss: { selectedCommitFileDiff = nil }
                )
            }
        }
    }

    // MARK: - Commit row

    private func commitRow(_ commit: GitCommitInfo, index: Int) -> some View {
        let layout = graphResponse?.graphLayout?[safe: index]

        return Button {
            withAnimation(IonTheme.snappySpring) {
                if expandedCommitHash == commit.fullHash {
                    expandedCommitHash = nil
                } else {
                    expandedCommitHash = commit.fullHash
                    Haptic.light()
                }
            }
        } label: {
            VStack(spacing: 0) {
                HStack(alignment: .top, spacing: 0) {
                    // Lane visualization (if available)
                    if let layout {
                        GitGraphLaneView(layout: layout)
                    }

                    // Commit info
                    VStack(alignment: .leading, spacing: 4) {
                        Text(commit.subject)
                            .font(.subheadline)
                            .lineLimit(2)
                            .foregroundStyle(.primary)

                        HStack(spacing: 6) {
                            Text(commit.hash)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(.secondary)

                            Text(commit.authorName)
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            Spacer()

                            Text(commit.relativeDate)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }

                        if !commit.refs.isEmpty {
                            refBadges(commit.refs)
                        }
                    }
                    .padding(.horizontal, layout != nil ? 4 : 12)
                    .padding(.vertical, 8)
                }

                // Expanded detail
                if expandedCommitHash == commit.fullHash {
                    expandedDetail(commit)
                }
            }
        }
        .buttonStyle(.plain)
    }

    // MARK: - Expanded detail

    private func expandedDetail(_ commit: GitCommitInfo) -> some View {
        let filesResponse = viewModel.gitCommitFiles[commit.fullHash]

        return VStack(alignment: .leading, spacing: 8) {
            Divider()

            // Metadata row
            HStack(spacing: 6) {
                Text(commit.fullHash)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                Spacer()
                if !commit.parents.isEmpty {
                    Text(commit.parents.count == 1 ? "1 parent" : "\(commit.parents.count) parents")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // Stats summary
            if let stats = filesResponse?.stats {
                HStack(spacing: 10) {
                    Label("\(stats.filesChanged) files", systemImage: "doc")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if stats.insertions > 0 {
                        Text("+\(stats.insertions)")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.green)
                    }
                    if stats.deletions > 0 {
                        Text("−\(stats.deletions)")
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(.red)
                    }
                    Spacer()
                }
            }

            // File list
            if let files = filesResponse?.files, !files.isEmpty {
                VStack(spacing: 0) {
                    ForEach(files) { file in
                        Button {
                            Haptic.light()
                            viewModel.requestGitCommitFileDiff(
                                directory: directory,
                                hash: commit.fullHash,
                                path: file.path
                            )
                            selectedCommitFileDiff = (hash: commit.fullHash, path: file.path)
                        } label: {
                            commitFileRow(file)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            } else if filesResponse == nil {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Loading files…")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 10)
        .transition(.opacity.combined(with: .move(edge: .top)))
        .onAppear {
            if viewModel.gitCommitFiles[commit.fullHash] == nil {
                viewModel.requestGitCommitFiles(directory: directory, hash: commit.fullHash)
            }
        }
    }

    private func commitFileRow(_ file: GitCommitFile) -> some View {
        HStack(spacing: 8) {
            Text(file.statusLetter)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(fileStatusColor(file.status))
                .frame(width: 14)

            VStack(alignment: .leading, spacing: 1) {
                Text(file.fileName)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                if !file.directory.isEmpty {
                    Text(file.directory)
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.system(size: 8))
                .foregroundStyle(.quaternary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func fileStatusColor(_ status: String) -> Color {
        switch status {
        case "added": return .green
        case "deleted": return .red
        case "renamed": return .purple
        default: return .blue
        }
    }

    // MARK: - Ref badges

    private func refBadges(_ refs: [GitRef]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(refs, id: \.name) { ref in
                    Text(ref.name)
                        .font(.system(size: 10, weight: ref.isCurrent ? .bold : .regular))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(refColor(ref).opacity(0.2))
                        .foregroundStyle(refColor(ref))
                        .clipShape(Capsule())
                }
            }
        }
    }

    private func refColor(_ ref: GitRef) -> Color {
        if ref.isCurrent { return .green }
        switch ref.type {
        case "head": return .green
        case "remote": return .blue
        case "tag": return .yellow
        default: return .secondary
        }
    }
}

// MARK: - Commit file diff sheet (reactive to @Observable)

/// Separate view so SwiftUI re-evaluates the body when the view model updates.
private struct CommitFileDiffSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    let hash: String
    let path: String
    let onDismiss: () -> Void

    private var response: GitCommitFileDiffResponse? {
        viewModel.gitCommitFileDiff["\(hash):\(path)"]
    }

    var body: some View {
        if let response {
            GitDiffView(fileName: response.fileName, diff: response.diff)
        } else {
            NavigationStack {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading diff…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { onDismiss() }
                    }
                }
            }
        }
    }
}

// MARK: - Safe collection subscript

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
