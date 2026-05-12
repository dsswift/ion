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
            .navigationTitle("Git")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
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
}
