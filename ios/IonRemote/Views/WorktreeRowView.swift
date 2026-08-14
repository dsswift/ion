import SwiftUI

// MARK: - One worktree row (iOS)
//
// Mirrors the desktop's WorktreeRow vocabulary exactly: a dirty dot, the
// unlanded-commit count, a base-moved indicator, and the last commit subject
// for telling worktrees apart. The desktop computes all of it; this only
// renders.
//
// ONE row for enrolled and unenrolled worktrees alike. There used to be a
// second `BenchMemberRowView` describing the same object -- a bench member IS a
// worktree -- so an enrolled one appeared in two sections with two vocabularies
// for the same facts. Membership is now a leading badge plus a few trailing
// ones, exactly as the desktop expresses it.

struct WorktreeRowView: View {
    @Environment(\.appTheme) private var theme
    let worktree: RemoteWorktree
    let busy: Bool
    let onOpen: () -> Void
    let onSync: () -> Void
    let onLand: () -> Void
    /// Bench verbs. Absent (no-op) when the surface offers no bench actions,
    /// such as the new-tab sheet.
    var onToggleEnrollment: (() -> Void)?
    var onToggleIncluded: (() -> Void)?
    var onUpdatePin: (() -> Void)?
    /// Set or clear the worktree's workflow stage. Worktree-scoped, so it is
    /// offered on unenrolled rows too. Nil clears.
    var onSetStage: ((WorkStage?) -> Void)?
    /// Create an additional conversation here, as distinct from `onOpen`, which
    /// focuses or cycles the ones that exist.
    var onNewConversation: (() -> Void)?
    /// Focus a specific conversation from the "Open here" list in the context
    /// menu. Absent (no-op row, just a name) when the host doesn't wire
    /// navigation -- mirrors `onNewConversation`'s optionality.
    var onSelectConversation: ((String) -> Void)?
    /// Retire a landed worktree. Absent when the host doesn't offer retire.
    var onRetire: (() -> Void)?

    @State private var confirmRetire = false

    private var membership: RemoteMembership? { worktree.membership }

    /// Aggregate status of the conversations in this worktree, or nil when none
    /// are open.
    ///
    /// Nil is a different fact from idle -- "nothing open" versus "open, all
    /// idle" -- and renders as a hollow ring rather than a filled grey dot.
    /// Mirrors the desktop's `getGroupStatusColor` fold: highest-priority state
    /// across the conversations, using the same status tokens both clients share.
    private var activityColor: Color? {
        let statuses = worktree.openConversations.map(\.status)
        if statuses.isEmpty { return nil }
        if statuses.contains("error") { return theme.statusError }
        if statuses.contains("running") || statuses.contains("connecting") { return theme.statusRunning }
        if statuses.contains("waiting") { return theme.statusWaitingChildren }
        return theme.statusIdle
    }

    /// One line-2 membership word, styled consistently.
    private func benchWord(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
    }

    /// "2 conflicts" when the count is known, otherwise the operation name.
    private var conflictChipText: String {
        if let count = worktree.conflictedCount, count > 0 {
            return count == 1 ? "1 conflict" : "\(count) conflicts"
        }
        switch worktree.operationState {
        case .merging: return "merging"
        case .cherryPicking: return "cherry-picking"
        default: return "rebasing"
        }
    }

    var body: some View {
        if worktree.isLanded {
            landedBody
        } else {
            activeBody
        }
    }

    // MARK: - Landed row

    private var landedBody: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.green)

            Text(worktree.displayName)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Text(worktree.branchName)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)

            Spacer(minLength: 4)

            Text("landed")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if busy { ProgressView().controlSize(.mini) }
        }
        .contextMenu {
            if !worktree.openConversations.isEmpty {
                Section("Open here") {
                    ForEach(worktree.openConversations) { conversation in
                        if let onSelectConversation {
                            Button {
                                onSelectConversation(conversation.tabId)
                            } label: {
                                Text(conversation.title)
                            }
                        } else {
                            Text(conversation.title)
                        }
                    }
                }
            }
            if let onRetire {
                Button(role: .destructive) {
                    confirmRetire = true
                } label: {
                    Label("Retire worktree", systemImage: "trash")
                }
            }
        }
        .confirmationDialog("Retire this worktree?",
                            isPresented: $confirmRetire,
                            titleVisibility: .visible) {
            Button("Retire", role: .destructive) { onRetire?() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The worktree directory and its branch will be removed. All work in this worktree has already landed.")
        }
    }

    // MARK: - Active row

    private var activeBody: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    // Bench membership leads: it is the only state that changes
                    // what the BUILD contains. The three readings differ by SHAPE
                    // and HUE, not by opacity -- `excluded` was a dimmed grey
                    // diamond and `none` drew nothing, which at this size made an
                    // excluded member read as one that was never enrolled. An
                    // excluded member keeps the accent because the fact it must
                    // convey is "IS a member, currently skipped".
                    switch worktree.enrollment {
                    case .included:
                        Image(systemName: "diamond.fill")
                            .font(.system(size: 7)) // design-type: SF Symbol membership glyph sized as icon geometry, not text
                            .foregroundStyle(Color.accentColor)
                    case .excluded:
                        Image(systemName: "diamond.bottomhalf.filled")
                            .font(.system(size: 7)) // design-type: SF Symbol membership glyph sized as icon geometry, not text
                            .foregroundStyle(Color.accentColor)
                    case .none:
                        Image(systemName: "diamond")
                            .font(.system(size: 7)) // design-type: SF Symbol membership glyph sized as icon geometry, not text
                            .foregroundStyle(Color.secondary)
                    }

                    // Activity: the aggregate of this worktree's conversations,
                    // in the app's existing dot vocabulary. This circle used to
                    // report DIRTY in green -- claiming success about a worktree
                    // holding unsaved work, and saying nothing about whether
                    // anything was running in it. Dirty is its own marker below.
                    Circle()
                        .fill(activityColor ?? Color.clear)
                        .strokeBorder(activityColor == nil ? Color.secondary : Color.clear, lineWidth: 1)
                        .frame(width: 8, height: 8)

                    // Uncommitted work, as an exclamation rather than a filled
                    // shape. That is what lets it borrow the danger hue without
                    // reading as a failure: `git status` has trained everyone
                    // that a terse mark beside a path means "this has changes",
                    // and next to the commit count that is how it reads. It also
                    // differs from the activity dot by SHAPE, which a colour
                    // difference alone cannot do at this size.
                    if worktree.isDirty {
                        Text("!")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(theme.worktreeDirty)
                    }

                    // Title-first: the desktop names a worktree from the
                    // first prompt sent inside it, and that is the only string
                    // here that says what the work is about. The branch stays
                    // beside it because every git verb names the branch.
                    Text(worktree.displayName)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)

                    Text(worktree.branchName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Spacer(minLength: 4)

                    // An in-progress conflicted operation outranks every other
                    // badge: the worktree is mid-rebase and its other numbers
                    // are conservative defaults. Resolution is desktop-only;
                    // this chip keeps the state visible instead of the worktree
                    // looking healthy (or vanishing, as it once did).
                    if worktree.operationState != nil {
                        HStack(spacing: 2) {
                            Image(systemName: "exclamationmark.triangle.fill")
                            Text(conflictChipText)
                        }
                        .font(.caption2)
                        .foregroundStyle(.red)
                    }

                    // A bench merge conflict is a different failure from an
                    // in-worktree one: the contribution is not in the build at
                    // all. Both can be true, so both are shown.
                    if membership?.merge == .conflicted {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2)
                            .foregroundStyle(.red)
                    }
                    // The operator's workflow stage -- same glyph vocabulary as
                    // the desktop's gutter chip, set from the context menu.
                    if let stage = worktree.stage {
                        Image(systemName: stage.systemImage)
                            .font(.caption2)
                            .foregroundStyle(stage.color)
                            .accessibilityLabel(stage.label)
                    }
                    // The bench holds older content than this worktree.
                    //
                    // Suppressed while a sync is pending, matching the desktop's
                    // priority exactly: sync is a rebase, so a pin taken before it
                    // is stale the moment the sync lands. Showing both badges
                    // would invite the operator to act on the one that must come
                    // second. Same rule, same order, both clients -- this row has
                    // more horizontal room than the desktop's single-slot gutter,
                    // but room is not a reason to give the two clients different
                    // advice about what to do next.
                    if membership?.pin == .behind && !worktree.needsSync {
                        Image(systemName: "arrow.up.circle")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }

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
                    // The worktree ID leads the detail line, ahead of the commit
                    // subject. This is the token shared with every other surface:
                    // the directory name under ~/.ion/worktrees/ and the suffix of
                    // the branch (`wt/<id>`), so a row can be correlated against a
                    // conversation title that says something else entirely.
                    //
                    // Fixed (no lineLimit truncation pressure) and monospaced: it is
                    // machine text being matched character by character against
                    // another surface, and truncating the thing being correlated
                    // would defeat the point. The subject yields width instead.
                    Text(worktree.label)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .layoutPriority(1)
                    Text("·")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(worktree.lastCommitSubject.isEmpty ? "no commits yet" : worktree.lastCommitSubject)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    // Compact parenthesized count distinguishes one worktree's
                    // active conversations without repeating a redundant word.
                    if let openConversationCountLabel = worktree.openConversationCountLabel {
                        Text(openConversationCountLabel)
                            .font(.caption2)
                            .foregroundStyle(.tint)
                    }
                    // Membership words. The badges above are a summary; these
                    // carry what a summary cannot, which is why three axes exist
                    // rather than one collapsed status.
                    if let m = membership {
                        if !m.enabled { benchWord("excluded") }
                        switch m.pin {
                        case .empty: benchWord("no commits yet")
                        case .absorbed: benchWord("landed")
                        case .gone: benchWord("worktree gone")
                        case .behind, .current: EmptyView()
                        }
                        Text("#\(m.order)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
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
            if worktree.needsSync && worktree.sourceBranch != nil && worktree.operationState == nil {
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
                Label(worktree.openConversations.isEmpty ? "Open conversation" : "Go to conversation",
                      systemImage: "bubble.left")
            }
            if let onNewConversation {
                Button {
                    onNewConversation()
                } label: {
                    Label("New conversation here", systemImage: "plus.bubble")
                }
            }
            // The conversations by name: the phone has no hover, so the menu
            // is where "what is actually running in here" belongs. Each row
            // is tappable when the host wires `onSelectConversation` -- the
            // desktop's equivalent (the row menu's hover card / "Go to tab"
            // submenu) has always been able to focus a conversation by name;
            // this closes that parity gap for iOS's `.contextMenu` shape.
            if !worktree.openConversations.isEmpty {
                Section("Open here") {
                    ForEach(worktree.openConversations) { conversation in
                        if let onSelectConversation {
                            Button {
                                onSelectConversation(conversation.tabId)
                            } label: {
                                Text(conversation.title)
                            }
                        } else {
                            Text(conversation.title)
                        }
                    }
                }
            }
            // Bench verbs. Resolution and reordering stay desktop-only (a
            // 3-pane merge and a drag rail do not translate to a phone), but
            // enrollment and the workflow stage are one tap and belong here.
            if let onToggleEnrollment {
                Button {
                    onToggleEnrollment()
                } label: {
                    Label(membership == nil ? "Add to integration bench" : "Remove from bench",
                          systemImage: membership == nil ? "diamond" : "diamond.fill")
                }
                .disabled(worktree.sourceBranch == nil)
            }
            if let m = membership {
                // The bench conflict's detail. Resolution is desktop-only (a
                // 3-pane merge does not translate to a phone), but the FACTS --
                // which files, which member -- ride the wire already, and a bare
                // red triangle with no explanation was the parity gap: the
                // desktop names them, so the phone does too.
                if m.merge == .conflicted {
                    Section("Bench conflict -- assembly failed") {
                        ForEach(m.conflictPaths ?? [], id: \.self) { path in
                            Text(path)
                        }
                        if let colliders = m.conflictsWith, !colliders.isEmpty {
                            Text("Collides with \(colliders.joined(separator: ", "))")
                        } else {
                            Text("Collides with the base branch")
                        }
                        Text("The bench is empty until this is resolved on the desktop.")
                    }
                }
                if let onToggleIncluded {
                    Button {
                        onToggleIncluded()
                    } label: {
                        Label(m.enabled ? "Exclude from the merge" : "Include in the merge",
                              systemImage: m.enabled ? "minus.circle" : "plus.circle")
                    }
                }
                if let onUpdatePin, m.pin == .behind {
                    Button {
                        onUpdatePin()
                    } label: {
                        Label(worktree.needsSync ? "Update pin (sync first)" : "Update pin & assemble",
                              systemImage: "arrow.up.circle")
                    }
                    // Disabled while a sync is pending, for the same reason the
                    // desktop ranks Sync above Update-pin: sync rebases the
                    // worktree, so a pin taken first is stale the moment the sync
                    // lands -- and it publishes pre-rebase content to anyone who
                    // reassembles the bench in between.
                    .disabled(worktree.needsSync)
                }
            }
            // Workflow stage. Outside the membership block on purpose: the
            // stage is worktree-scoped (the desktop stores it in the registry),
            // so an unenrolled worktree carries it too -- `plan` happens before
            // any enrollment exists. Selecting the active stage clears it,
            // matching the desktop's strip.
            if let onSetStage {
                Menu {
                    ForEach(WorkStage.allCases, id: \.self) { stage in
                        Button {
                            onSetStage(worktree.stage == stage ? nil : stage)
                        } label: {
                            if worktree.stage == stage {
                                Label(stage.label, systemImage: "checkmark")
                            } else {
                                Label(stage.label, systemImage: stage.systemImage)
                            }
                        }
                    }
                    if worktree.stage != nil {
                        Divider()
                        Button(role: .destructive) {
                            onSetStage(nil)
                        } label: {
                            Label("Clear stage", systemImage: "xmark.circle")
                        }
                    }
                } label: {
                    Label(worktree.stage.map { "Stage: \($0.label)" } ?? "Set stage",
                          systemImage: worktree.stage?.systemImage ?? "circle.dashed")
                }
            }
            if worktree.sourceBranch != nil {
                Button {
                    onSync()
                } label: {
                    Label("Sync from \(worktree.sourceBranch ?? "source")", systemImage: "arrow.triangle.pull")
                }
                .disabled(worktree.isDirty || worktree.operationState != nil)

                Button {
                    onLand()
                } label: {
                    Label("Land into \(worktree.sourceBranch ?? "source")", systemImage: "arrow.down.to.line")
                }
                .disabled(worktree.isDirty || worktree.unlandedCommitCount == 0 || worktree.operationState != nil)
            }
        }
    }
}
