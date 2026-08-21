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
    let onLandAndRetire: () -> Void
    /// Bench verbs. Absent (no-op) when the surface offers no bench actions,
    /// such as the new-tab sheet.
    var onToggleEnrollment: (() -> Void)?
    var onUpdatePin: (() -> Void)?
    var onRename: (() -> Void)?
    var onReprovision: (() -> Void)?
    var onMoveEarlier: (() -> Void)?
    var onMoveLater: (() -> Void)?
    var onDiscardRecordings: (() -> Void)?
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
    /// Verification evidence for this replayed member. The desktop identifies
    /// suspects in its projection; iOS renders that fact and opens analysis.
    var verificationFailure: RemoteBenchVerification?
    /// Retire this worktree (appraised on the desktop; refusals carry the
    /// reason). Absent on hosts that do not offer lifecycle verbs.
    var onRetire: (() -> Void)?
    /// The live auto-fix resolver for THIS worktree's directory, when one is
    /// running. While set, the conflict chip flashes and its tap focuses the
    /// resolver instead of launching a second one — the desktop's exact
    /// reactivation block (WorktreeStateSlot).
    var activeAutoFixTabId: String?
    /// The live auto-fix resolver for the BENCH directory, for the
    /// bench-conflict triangle's flash + focus routing.
    var benchAutoFixTabId: String?
    /// Launch the AI-assisted resolver on this worktree's conflicted
    /// operation. iOS supports the assisted flow only (the 3-pane manual
    /// merge stays desktop-only, the one authorized difference).
    var onConflictAssist: (() -> Void)?
    /// Bench chain: recreate the failed assembly merge, then launch the
    /// assisted resolver on the bench directory.
    var onBenchConflictAssist: (() -> Void)?


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
        activeBody
    }

    /// One conflict indicator: flashing + focus while a resolver runs,
    /// assisted-resolution launch otherwise. `onSelectConversation` is the
    /// focus path (the resolver is an ordinary conversation tab).
    @ViewBuilder
    private func conflictBadge(
        label: String?,
        resolverTabId: String?,
        assist: (() -> Void)?,
        accessibility: String
    ) -> some View {
        let resolving = resolverTabId != nil
        Button {
            if let resolverTabId, let onSelectConversation {
                onSelectConversation(resolverTabId)
            } else {
                assist?()
            }
        } label: {
            HStack(spacing: 2) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .symbolEffect(.pulse, options: .repeating, isActive: resolving)
                if let label { Text(label) }
            }
            .font(.caption2)
            // A live resolver is work in progress (warning); an unattended
            // conflict is a failure state (error). Named palette colors resolve
            // the same under every theme pack, so a pack could not reach this
            // badge at all.
            .foregroundStyle(resolving ? theme.statusWarning : theme.statusError)
        }
        .buttonStyle(.plain)
        // Assist requires a wired action or a live resolver; a bare badge
        // (new-tab sheet host) stays non-interactive.
        .disabled(assist == nil && resolverTabId == nil)
        .accessibilityLabel(resolving ? "AI resolution in progress. Tap to focus." : accessibility)
    }

    // MARK: - Active row

    private var activeBody: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    // Bench membership is binary. A filled diamond means the
                    // worktree contributes to its bench. An outline means it does not.
                    Image(systemName: worktree.isBenchMember ? "diamond.fill" : "diamond")
                        .font(.system(size: 7)) // design-type: SF Symbol membership glyph sized as icon geometry, not text
                        .foregroundStyle(worktree.isBenchMember ? Color.accentColor : Color.secondary)

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
                    // are conservative defaults. Tappable: while an auto-fix
                    // resolver runs it FLASHES and focuses that conversation
                    // (the desktop's reactivation block — the resolve verb is
                    // unreachable while the machine conversation is live);
                    // otherwise it launches the AI-assisted resolution. The
                    // 3-pane manual merge stays desktop-only.
                    if worktree.operationState != nil {
                        conflictBadge(
                            label: conflictChipText,
                            resolverTabId: activeAutoFixTabId,
                            assist: onConflictAssist,
                            accessibility: "Resolve conflicts with AI assistance"
                        )
                    }

                    // A bench merge conflict is a different failure from an
                    // in-worktree one: the contribution is not in the build at
                    // all. Both can be true, so both are shown. Tappable with
                    // the same flash + focus/assist routing, against the BENCH
                    // resolver and the bench assist chain.
                    if membership?.merge == .conflicted {
                        conflictBadge(
                            label: nil,
                            resolverTabId: benchAutoFixTabId,
                            assist: onBenchConflictAssist,
                            accessibility: "Resolve bench conflict with AI assistance"
                        )
                    }
                    if membership?.mergeResolution == "replayed" {
                        Image(systemName: "arrow.triangle.2.circlepath")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .accessibilityLabel("Merged from replayed resolution")
                    }
                    if verificationFailure != nil {
                        Image(systemName: "checkmark.seal.trianglebadge.exclamationmark")
                            .font(.caption2)
                            .foregroundStyle(.red)
                            .accessibilityLabel("Verification failed after replayed resolution")
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
                        if m.mergeResolution == "replayed" { benchWord("replay used") }
                        if verificationFailure != nil { benchWord("verification failed") }
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
                                if let roleLabel = conversation.roleLabel {
                                    Text(roleLabel)
                                        .foregroundStyle(.tint)
                                }
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
                if let verificationFailure {
                    Section("Verification failed after replay") {
                        Text(verificationFailure.command).font(.caption2.monospaced())
                        Text(verificationFailure.outputTail).font(.caption2).lineLimit(4)
                    }
                }
                // The bench conflict's detail. The FACTS -- which files, which
                // member -- ride the wire; the assisted resolution is one tap.
                // Only the 3-pane manual merge stays desktop-only.
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
                        if let resolverTabId = benchAutoFixTabId {
                            // Reactivation block: while a resolver runs, focus
                            // is the only affordance — never a second launch.
                            if let onSelectConversation {
                                Button {
                                    onSelectConversation(resolverTabId)
                                } label: {
                                    Label("AI resolution in progress — go to it", systemImage: "bolt.fill")
                                }
                            }
                        } else if let onBenchConflictAssist {
                            Button {
                                onBenchConflictAssist()
                            } label: {
                                Label("Resolve with AI assistance", systemImage: "wand.and.stars")
                            }
                        } else {
                            Text("The bench is empty until this is resolved.")
                        }
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
            if let onRename {
                Button { onRename() } label: { Label("Rename worktree", systemImage: "pencil") }
            }
            if let onReprovision {
                Button { onReprovision() } label: { Label("Re-provision", systemImage: "arrow.clockwise") }
            }
            if membership != nil, let onMoveEarlier, let onMoveLater {
                Section("Bench order") {
                    Button { onMoveEarlier() } label: { Label("Move earlier", systemImage: "arrow.up") }
                    Button { onMoveLater() } label: { Label("Move later", systemImage: "arrow.down") }
                }
            }
            if membership != nil, let onDiscardRecordings {
                Button(role: .destructive) { onDiscardRecordings() } label: {
                    Label("Discard recorded resolutions", systemImage: "arrow.counterclockwise")
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
                    onLandAndRetire()
                } label: {
                    Label("Land and retire into \(worktree.sourceBranch ?? "source")", systemImage: "arrow.down.to.line")
                }
                .disabled(worktree.isDirty || worktree.unlandedCommitCount == 0 || worktree.operationState != nil)
            }
            // An in-worktree conflicted operation: assisted resolution, or
            // focus the resolver already working on it. Placed with the
            // lifecycle verbs because it unblocks them.
            if worktree.operationState != nil {
                if let resolverTabId = activeAutoFixTabId, let onSelectConversation {
                    Button {
                        onSelectConversation(resolverTabId)
                    } label: {
                        Label("AI resolution in progress — go to it", systemImage: "bolt.fill")
                    }
                } else if let onConflictAssist {
                    Button {
                        onConflictAssist()
                    } label: {
                        Label("Resolve conflicts with AI assistance", systemImage: "wand.and.stars")
                    }
                }
            }
            // Retire: the explicit removal verb. Destructive styling; the
            // desktop appraises and refuses when work would be lost
            // (refusedDirty), and the op result words a refusal differently
            // from a failure. Disabled mid-operation because the appraisal
            // fields are conservative defaults then.
            if let onRetire {
                Button(role: .destructive) {
                    onRetire()
                } label: {
                    Label("Retire worktree", systemImage: "trash")
                }
                .disabled(worktree.operationState != nil)
            }
        }
    }
}
