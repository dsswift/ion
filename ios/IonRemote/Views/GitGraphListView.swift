import SwiftUI

/// Scrollable list of git commits with ref badges and pagination.
struct GitGraphListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let directory: String

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
                ForEach(commits) { commit in
                    commitRow(commit)
                    Divider()
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

    // MARK: - Commit row

    private func commitRow(_ commit: GitCommitInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            // Subject line
            Text(commit.subject)
                .font(.subheadline)
                .lineLimit(2)

            HStack(spacing: 6) {
                // Short hash
                Text(commit.hash)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)

                // Author
                Text(commit.authorName)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                // Relative date
                Text(commit.relativeDate)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // Ref badges
            if !commit.refs.isEmpty {
                refBadges(commit.refs)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
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
