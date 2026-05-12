import SwiftUI

/// List of staged and unstaged file changes in a tree layout grouped by directory,
/// with stage/unstage swipe actions and a commit bar.
struct GitChangesListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let directory: String
    @State private var commitMessage = ""
    @State private var showDiff = false
    @State private var selectMode = false
    @State private var selectedPaths: Set<String> = []
    @State private var recentCommitMessages: [String] = []

    private var changesResponse: GitChangesResponse? {
        viewModel.gitChanges[directory]
    }

    private var stagedFiles: [GitChangedFile] {
        changesResponse?.files.filter(\.staged) ?? []
    }

    private var unstagedFiles: [GitChangedFile] {
        changesResponse?.files.filter { !$0.staged } ?? []
    }

    var body: some View {
        if changesResponse == nil {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading changes…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
        } else if changesResponse?.files.isEmpty == true {
            Text("No changes")
                .foregroundStyle(.secondary)
                .font(.caption)
                .padding(.vertical, 8)
        } else {
            VStack(spacing: 0) {
                // Staged section
                if !stagedFiles.isEmpty {
                    sectionHeader(
                        "Staged",
                        count: stagedFiles.count,
                        action: {
                            viewModel.gitUnstage(
                                directory: directory,
                                paths: stagedFiles.map(\.path)
                            )
                        },
                        actionLabel: "Unstage All"
                    )
                    treeView(files: stagedFiles)
                }

                // Unstaged section
                if !unstagedFiles.isEmpty {
                    sectionHeader(
                        "Changes",
                        count: unstagedFiles.count,
                        action: {
                            viewModel.gitStage(
                                directory: directory,
                                paths: unstagedFiles.map(\.path)
                            )
                        },
                        actionLabel: "Stage All"
                    )
                    treeView(files: unstagedFiles)
                }

                // Commit bar
                if !stagedFiles.isEmpty {
                    commitBar
                }

                // Batch actions
                if selectMode && !selectedPaths.isEmpty {
                    HStack(spacing: 12) {
                        Button {
                            viewModel.gitStage(directory: directory, paths: Array(selectedPaths))
                            selectedPaths.removeAll()
                        } label: {
                            Label("Stage \(selectedPaths.count)", systemImage: "plus.circle")
                                .font(.caption.weight(.medium))
                        }
                        .buttonStyle(.bordered)
                        .tint(.green)

                        Button {
                            viewModel.gitUnstage(directory: directory, paths: Array(selectedPaths))
                            selectedPaths.removeAll()
                        } label: {
                            Label("Unstage \(selectedPaths.count)", systemImage: "minus.circle")
                                .font(.caption.weight(.medium))
                        }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
            }
            .fullScreenCover(isPresented: $showDiff) {
                if let result = viewModel.gitDiffResult {
                    GitDiffView(fileName: result.fileName, diff: result.diff)
                } else {
                    ProgressView("Loading diff…")
                }
            }
        }
    }

    // MARK: - Tree view

    /// Groups files by directory and renders a tree with collapsible folder rows.
    private func treeView(files: [GitChangedFile]) -> some View {
        let grouped = buildTree(files)
        return ForEach(grouped, id: \.dir) { group in
            if !group.dir.isEmpty {
                folderRow(group.dir)
            }
            ForEach(group.files) { file in
                fileRow(file, indented: !group.dir.isEmpty)
                Divider().padding(.leading, group.dir.isEmpty ? 40 : 60)
            }
        }
    }

    /// Builds a tree grouping: files at root level get dir="", others are grouped.
    private func buildTree(_ files: [GitChangedFile]) -> [FileGroup] {
        var groups: [String: [GitChangedFile]] = [:]
        var order: [String] = []
        for file in files {
            let dir = file.directory
            if groups[dir] == nil { order.append(dir) }
            groups[dir, default: []].append(file)
        }
        return order.map { FileGroup(dir: $0, files: groups[$0]!) }
    }

    // MARK: - Folder row

    private func folderRow(_ dir: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "folder.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(dir)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill))
    }

    // MARK: - Section header

    private func sectionHeader(
        _ title: String,
        count: Int,
        action: @escaping () -> Void,
        actionLabel: String
    ) -> some View {
        HStack {
            Text("\(title) (\(count))")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer()
            if count >= 3 {
                Button(selectMode ? "Done" : "Select") {
                    selectMode.toggle()
                    if !selectMode { selectedPaths.removeAll() }
                }
                .font(.caption)
            }
            Button(actionLabel, action: action)
                .font(.caption)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.secondarySystemGroupedBackground))
    }

    // MARK: - File row

    private func fileRow(_ file: GitChangedFile, indented: Bool) -> some View {
        Button {
            viewModel.requestGitDiff(
                directory: directory,
                path: file.path,
                staged: file.staged
            )
            showDiff = true
        } label: {
            HStack(spacing: 8) {
                statusBadge(file)
                Text(file.fileName)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer()
                if selectMode {
                    Image(systemName: selectedPaths.contains(file.path) ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selectedPaths.contains(file.path) ? IonTheme.accent : Color(.tertiaryLabel))
                        .onTapGesture {
                            if selectedPaths.contains(file.path) {
                                selectedPaths.remove(file.path)
                            } else {
                                selectedPaths.insert(file.path)
                            }
                        }
                } else {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.quaternary)
                }
            }
            .padding(.leading, indented ? 28 : 12)
            .padding(.trailing, 12)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            if file.staged {
                Button {
                    viewModel.gitUnstage(directory: directory, paths: [file.path])
                } label: {
                    Label("Unstage", systemImage: "minus.circle")
                }
                .tint(.orange)
            } else {
                Button {
                    viewModel.gitStage(directory: directory, paths: [file.path])
                } label: {
                    Label("Stage", systemImage: "plus.circle")
                }
                .tint(.green)
            }
        }
    }

    // MARK: - Status badge

    private func statusBadge(_ file: GitChangedFile) -> some View {
        Text(file.statusLetter)
            .font(.system(size: 12, weight: .bold, design: .monospaced))
            .foregroundStyle(statusColor(file.status))
            .frame(width: 20, height: 20)
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "added", "untracked": return .green
        case "modified": return .orange
        case "deleted": return .red
        case "renamed": return .blue
        default: return .secondary
        }
    }

    // MARK: - Commit bar

    private var commitBar: some View {
        HStack(spacing: 8) {
            if commitMessage.isEmpty && !recentCommitMessages.isEmpty {
                Menu {
                    ForEach(recentCommitMessages, id: \.self) { msg in
                        Button(msg) { commitMessage = msg }
                    }
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            TextField("Commit message", text: $commitMessage)
                .textFieldStyle(.roundedBorder)
                .font(.subheadline)

            Button {
                guard !commitMessage.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                recentCommitMessages.insert(commitMessage, at: 0)
                if recentCommitMessages.count > 5 { recentCommitMessages.removeLast() }
                viewModel.gitCommit(directory: directory, message: commitMessage)
                commitMessage = ""
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(
                        commitMessage.trimmingCharacters(in: .whitespaces).isEmpty
                            ? .secondary
                            : IonTheme.accent
                    )
            }
            .disabled(commitMessage.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemGroupedBackground))
    }
}

// MARK: - File group model

private struct FileGroup {
    let dir: String
    let files: [GitChangedFile]
}
