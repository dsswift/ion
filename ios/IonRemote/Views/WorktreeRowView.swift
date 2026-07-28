import SwiftUI

// MARK: - One worktree row (iOS)
//
// Mirrors the desktop's WorktreeRow vocabulary exactly: a dirty dot, the
// unlanded-commit count, a base-moved indicator, and the last commit subject
// for telling worktrees apart. The desktop computes all of it; this only
// renders.

struct WorktreeRowView: View {
    let worktree: RemoteWorktree
    let busy: Bool
    let onOpen: () -> Void
    let onSync: () -> Void
    let onLand: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(worktree.isDirty ? Color.green : Color.clear)
                        .strokeBorder(worktree.isDirty ? Color.green : Color.secondary, lineWidth: 1)
                        .frame(width: 8, height: 8)

                    Text(worktree.label)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)

                    Text(worktree.branchName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    if worktree.unlandedCommitCount > 0 {
                        Text("\(worktree.unlandedCommitCount)↑")
                            .font(.caption2)
                            .foregroundStyle(.green)
                    }
                    // Only shown when a sync would genuinely change this
                    // worktree -- never for a no-op, which would train the
                    // operator to ignore the badge.
                    if worktree.needsSync {
                        Image(systemName: "arrow.triangle.pull")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    // Dependency provisioning (node_modules, hooks, caches --
                    // the gitignored state git never carries). Shown only while
                    // in flight or failed: `ready` is the normal case and needs
                    // no badge, and a nil state means Ion has no record rather
                    // than that something went wrong.
                    switch worktree.provisionState {
                    case .seeding, .building, .probing:
                        Image(systemName: "shippingbox")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    case .failed:
                        Image(systemName: "shippingbox.badge.exclamationmark")
                            .font(.caption2)
                            .foregroundStyle(.red)
                    case .idle, .ready, .none:
                        EmptyView()
                    }
                    if busy { ProgressView().controlSize(.mini) }
                }

                HStack(spacing: 6) {
                    Text(worktree.lastCommitSubject.isEmpty ? "no commits yet" : worktree.lastCommitSubject)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if worktree.openTabId != nil {
                        Text("open")
                            .font(.caption2)
                            .foregroundStyle(.tint)
                    }
                    if worktree.sourceBranch == nil {
                        // Ion did not create this worktree, so land and sync
                        // are unanswerable: guessing the source branch would
                        // land work in the wrong place.
                        Text("source unknown")
                            .font(.caption2)
                            .italic()
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if worktree.needsSync && worktree.sourceBranch != nil {
                Button {
                    onSync()
                } label: {
                    Label("Sync", systemImage: "arrow.triangle.pull")
                }
                .tint(.orange)
            }
        }
        .contextMenu {
            Button {
                onOpen()
            } label: {
                Label(worktree.openTabId == nil ? "Open conversation" : "Go to conversation",
                      systemImage: "bubble.left")
            }
            if worktree.sourceBranch != nil {
                Button {
                    onSync()
                } label: {
                    Label("Sync from \(worktree.sourceBranch ?? "source")", systemImage: "arrow.triangle.pull")
                }
                .disabled(worktree.isDirty)

                Button {
                    onLand()
                } label: {
                    Label("Land into \(worktree.sourceBranch ?? "source")", systemImage: "arrow.down.to.line")
                }
                .disabled(worktree.isDirty || worktree.unlandedCommitCount == 0)
            }
        }
    }
}

// MARK: - One bench member row (iOS)

struct BenchMemberRowView: View {
    let member: RemoteBenchMember
    let busy: Bool
    let onToggle: () -> Void
    let onUpdate: () -> Void
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                // Excluding keeps the member in the list but skips its merge,
                // so a broken build can be bisected without dismantling the
                // member set.
                Button(action: onToggle) {
                    Image(systemName: member.enabled ? "checkmark.square.fill" : "square")
                        .foregroundStyle(member.enabled ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)

                VStack(alignment: .leading, spacing: 1) {
                    Text(member.label)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(member.branchName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 4)

                statusLabel
                if busy { ProgressView().controlSize(.mini) }
            }

            if member.status == .conflicted, let paths = member.conflictPaths, !paths.isEmpty {
                // Inline, not behind a tap: the conflict detail is most needed
                // exactly when the row appears.
                Text(conflictSummary(paths))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 26)
            }
        }
        .opacity(member.enabled ? 1 : 0.55)
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if member.status == .stale {
                Button(action: onUpdate) {
                    Label("Update", systemImage: "arrow.clockwise")
                }
                .tint(.orange)
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive, action: onRemove) {
                Label("Remove", systemImage: "minus.circle")
            }
        }
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch member.status {
        case .integrated:
            Label("@\(String(member.pinnedSha.prefix(7)))", systemImage: "checkmark.circle.fill")
                .font(.caption2).labelStyle(.titleOnly).foregroundStyle(.green)
        case .landed:
            Label("landed", systemImage: "arrow.down.to.line")
                .font(.caption2).labelStyle(.titleOnly).foregroundStyle(.green)
        case .stale:
            // The pinned sha stays visible next to `stale`: what the bench
            // HOLDS and what the worktree HAS are different facts.
            Text("@\(String(member.pinnedSha.prefix(7))) · stale")
                .font(.caption2).foregroundStyle(.orange)
        case .conflicted:
            Text("conflict").font(.caption2).foregroundStyle(.red)
        case .missing:
            Text("missing").font(.caption2).foregroundStyle(.secondary)
        case .excluded:
            Text("excluded").font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func conflictSummary(_ paths: [String]) -> String {
        let shown = paths.prefix(3).joined(separator: ", ")
        let extra = paths.count > 3 ? " +\(paths.count - 3) more" : ""
        let with = (member.conflictsWith?.isEmpty == false)
            ? " · conflicts with \(member.conflictsWith!.joined(separator: ", "))"
            : ""
        return shown + extra + with
    }
}
