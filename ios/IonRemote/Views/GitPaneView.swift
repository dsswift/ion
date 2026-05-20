import SwiftUI

/// Full-screen git pane showing changes and commit graph for a tab's working directory.
/// Presented via `.fullScreenCover` from `ConversationView`.
struct GitPaneView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var changesExpanded = true
    @State private var graphExpanded = true
    @State private var loaded = false

    private var directory: String {
        viewModel.tab(for: tabId)?.workingDirectory ?? ""
    }

    private var branch: String {
        viewModel.gitChanges[directory]?.branch ?? ""
    }

    private var ahead: Int {
        viewModel.gitChanges[directory]?.ahead ?? 0
    }

    private var behind: Int {
        viewModel.gitChanges[directory]?.behind ?? 0
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    branchHeader
                    summaryBar

                    // Changes section
                    collapsibleSection(
                        title: "Changes",
                        icon: "doc.badge.plus",
                        isExpanded: $changesExpanded
                    ) {
                        GitChangesListView(directory: directory)
                    }

                    Divider().padding(.vertical, 4)

                    // Graph section
                    collapsibleSection(
                        title: "Graph",
                        icon: "point.3.connected.trianglepath.dotted",
                        isExpanded: $graphExpanded
                    ) {
                        GitGraphListView(directory: directory)
                    }
                }
            }
            .refreshable { await refreshAsync() }
            .navigationTitle("Git")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        refresh()
                        Haptic.light()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    Menu {
                        Button {
                            viewModel.gitPull(directory: directory)
                            Haptic.medium()
                        } label: {
                            Label("Pull", systemImage: "arrow.down")
                        }
                        Button {
                            viewModel.gitPush(directory: directory)
                            Haptic.medium()
                        } label: {
                            Label("Push", systemImage: "arrow.up")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
            .task {
                guard !loaded else { return }
                loaded = true
                refresh()
            }
            .overlay(alignment: .top) {
                if let toast = viewModel.gitToast {
                    GitToastView(toast: toast) {
                        viewModel.gitToast = nil
                    }
                    .onAppearAnimate()
                    .padding(.top, 8)
                }
            }
        }
    }

    // MARK: - Branch header

    private var branchHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.triangle.branch")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            if branch.isEmpty {
                Text("Loading…")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            } else {
                Text(branch)
                    .font(.subheadline.weight(.medium))
            }

            if ahead > 0 {
                Label("\(ahead)", systemImage: "arrow.up")
                    .font(.caption2)
                    .foregroundStyle(.green)
            }

            if behind > 0 {
                Label("\(behind)", systemImage: "arrow.down")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }

            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemGroupedBackground))
    }

    // MARK: - Summary bar

    private var summaryBar: some View {
        let changes = viewModel.gitChanges[directory]
        let staged = changes?.effectiveStagedCount ?? 0
        let unstaged = changes?.effectiveUnstagedCount ?? 0

        return Group {
            if staged > 0 || unstaged > 0 {
                HStack(spacing: 12) {
                    if staged > 0 {
                        Label("\(staged) staged", systemImage: "plus.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                    if unstaged > 0 {
                        Label("\(unstaged) changed", systemImage: "pencil.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
        }
    }

    // MARK: - Collapsible section

    private func collapsibleSection<Content: View>(
        title: String,
        icon: String,
        isExpanded: Binding<Bool>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(IonTheme.snappySpring) {
                    isExpanded.wrappedValue.toggle()
                }
            } label: {
                HStack {
                    Image(systemName: icon)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Spacer()
                    Image(systemName: isExpanded.wrappedValue ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)

            if isExpanded.wrappedValue {
                content()
                    .transition(.opacity)
            }
        }
        .clipped()
    }

    // MARK: - Refresh

    private func refresh() {
        guard !directory.isEmpty else { return }
        viewModel.requestGitChanges(directory: directory)
        viewModel.requestGitGraph(directory: directory)
    }

    private func refreshAsync() async {
        guard !directory.isEmpty else { return }
        viewModel.requestGitChanges(directory: directory)
        viewModel.requestGitGraph(directory: directory)
        Haptic.light()
        try? await Task.sleep(for: .milliseconds(500))
    }
}
