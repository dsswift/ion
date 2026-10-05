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
    @Environment(\.appTheme) var theme
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
    /// Discard this worktree without merging it into its source branch. The
    /// desktop appraises and preserves recoverable work before removal.
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
    /// When the row heads a collapsible group, whether that group is open.
    /// Draws the disclosure chevron in the leading column every inbox header
    /// uses. Nil for a row that heads nothing.
    var disclosureExpanded: Bool?
    /// Leave the worktree's name off the row. Set by a host that draws the
    /// worktree's only conversation directly beneath, under the same name:
    /// the header then carries the worktree's identity and state, and the
    /// title is read once instead of twice.
    var hidesTitle: Bool = false
    /// Another worktree or bench action is in flight on this repository. The
    /// row's action buttons are disabled so a second action cannot be started
    /// over the first; `busy` is the narrower fact that the action is THIS
    /// worktree's.
    var actionsLocked: Bool = false


    var membership: RemoteMembership? { worktree.membership }

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

    /// The tap target of a header action: the touch minimum wide, and the
    /// header's full height.
    static let actionSize: CGFloat = IonSpace.Metric.standardRowHeight

    /// A state mark that is also the action that resolves it. Drawn at mark
    /// size inside a full touch target, so the row stays one quiet line and
    /// the mark is still easy to hit. With no action wired (or one that
    /// cannot run yet) it is the mark alone; while another action is in
    /// flight on the repository it dims and does nothing.
    @ViewBuilder
    private func actionButton(_ systemName: String, label: String, action: (() -> Void)?) -> some View {
        let glyph = Image(systemName: systemName)
            .font(IonType.meaning)
            .foregroundStyle(theme.statusWarning)
        if let action {
            Button {
                Haptic.light()
                action()
            } label: {
                glyph
                    .frame(width: Self.actionSize, height: InboxLayout.minHeight(.groupHeader))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(actionsLocked)
            .opacity(actionsLocked ? 0.4 : 1)
            .accessibilityLabel(label)
        } else {
            glyph.accessibilityLabel(label)
        }
    }

    /// Membership states that have no mark of their own, in words.
    var detailWords: [String] {
        var words: [String] = []
        if let m = membership {
            if m.mergeResolution == "replayed" { words.append("replay used") }
            if verificationFailure != nil { words.append("verification failed") }
            switch m.pin {
            case .empty: words.append("no commits yet")
            case .absorbed: words.append("landed")
            case .gone: words.append("worktree gone")
            case .behind, .current: break
            }
        }
        // Ion did not create this worktree, so land and sync are
        // unanswerable: guessing the source branch would land work in the
        // wrong place.
        if worktree.sourceBranch == nil { words.append("source unknown") }
        // Closing its conversation kept a worktree that was ephemeral; say why
        // it is still here.
        if let reason = worktree.ephemeralKeptReason { words.append("kept: \(reason)") }
        return words
    }

    /// The long-press menu's heading: branch, last commit, bench position.
    var contextSummary: String {
        var parts = [worktree.branchName]
        parts.append(worktree.lastCommitSubject.isEmpty ? "no commits yet" : worktree.lastCommitSubject)
        if let m = membership { parts.append("bench #\(m.order)") }
        return parts.joined(separator: " · ")
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
            .font(IonType.microLabel)
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
                HStack(spacing: IonSpace.compactInset) {
                    if let disclosureExpanded {
                        InboxChevron(isExpanded: disclosureExpanded)
                    }
                    // The worktree's icon, in the column every group header
                    // uses. Tinted when the worktree contributes to its bench.
                    Image(systemName: "arrow.triangle.branch")
                        .font(IonType.metadata)
                        .foregroundStyle(worktree.isBenchMember ? theme.accent : theme.textSecondary)
                        .frame(width: InboxLayout.iconColumn)
                        .accessibilityLabel(worktree.isBenchMember ? "Worktree, bench member" : "Worktree")

                    // Activity: the aggregate of this worktree's conversations,
                    // in the app's existing dot vocabulary. Drawn only when a
                    // conversation is open here; the conversation count beside
                    // the group already says when none is.
                    if let activityColor {
                        Circle()
                            .fill(activityColor)
                            .frame(width: IonSpace.Metric.compactStatusDiameter, height: IonSpace.Metric.compactStatusDiameter)
                    }

                    // Uncommitted work, as an exclamation rather than a filled
                    // shape. That is what lets it borrow the danger hue without
                    // reading as a failure: `git status` has trained everyone
                    // that a terse mark beside a path means "this has changes",
                    // and next to the commit count that is how it reads. It also
                    // differs from the activity dot by SHAPE, which a colour
                    // difference alone cannot do at this size.
                    if worktree.isDirty {
                        Text("!")
                            .font(IonType.microLabel)
                            .foregroundStyle(theme.worktreeDirty)
                    }

                    // Title-first: the desktop names a worktree from the
                    // first prompt sent inside it, and that is the only string
                    // here that says what the work is about. The branch stays
                    // beside it because every git verb names the branch.
                    if !hidesTitle {
                        Text(worktree.displayName)
                            .font(IonType.sectionLabel)
                            .foregroundStyle(theme.textSecondary)
                            .lineLimit(1)
                    }

                    // The worktree ID: the token shared with every other
                    // surface (the directory name under ~/.ion/worktrees/ and
                    // the suffix of the branch), so a row can be matched
                    // against a conversation titled something else entirely.
                    Text(worktree.label)
                        .font(IonType.microLabel)
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                        // Machine text matched character by character against
                        // another surface: the title yields width, never this.
                        .fixedSize()

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
                            .font(IonType.microLabel)
                            .foregroundStyle(theme.statusWarning)
                            .accessibilityLabel("Merged from replayed resolution")
                    }
                    if verificationFailure != nil {
                        Image(systemName: "checkmark.seal.trianglebadge.exclamationmark")
                            .font(IonType.microLabel)
                            .foregroundStyle(theme.statusError)
                            .accessibilityLabel("Verification failed after replayed resolution")
                    }
                    // The operator's workflow stage -- same glyph vocabulary as
                    // the desktop's gutter chip, set from the context menu.
                    if let stage = worktree.stage {
                        Image(systemName: stage.systemImage)
                            .font(IonType.microLabel)
                            .foregroundStyle(stage.color)
                            .accessibilityLabel(stage.label)
                    }
                    // Ephemeral: removed when its conversation closes, unless it
                    // holds work that has not landed. Same mark as the desktop row.
                    if worktree.ephemeral {
                        Image(systemName: "timer")
                            .font(IonType.microLabel)
                            .foregroundStyle(theme.textTertiary)
                            .accessibilityLabel("Ephemeral: removed when its conversation closes")
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
                    if membership?.pin == .behind && !worktree.needsSync && !busy {
                        actionButton(
                            "arrow.up.circle",
                            label: "Update pin and assemble",
                            action: onUpdatePin
                        )
                    }

                    if worktree.unlandedCommitCount > 0 {
                        Text("\(worktree.unlandedCommitCount)↑")
                            .font(IonType.microLabel)
                            .foregroundStyle(theme.statusDone)
                    }
                    // Only shown when a sync would genuinely change this
                    // worktree -- never for a no-op, which would train the
                    // operator to ignore the badge.
                    if worktree.needsSync && !busy {
                        actionButton(
                            "arrow.triangle.pull",
                            label: "Sync from \(worktree.sourceBranch ?? "source")",
                            action: worktree.sourceBranch != nil && !worktree.isDirty && worktree.operationState == nil ? onSync : nil
                        )
                    }
                    // Dependency provisioning (node_modules, hooks, caches --
                    // the gitignored state git never carries). Shown only while
                    // in flight or failed: `ready` is the normal case and needs
                    // no badge, and a nil state means Ion has no record rather
                    // than that something went wrong.
                    switch worktree.provisionState {
                    case .seeding, .building, .probing:
                        Image(systemName: "shippingbox")
                            .font(IonType.microLabel)
                            .foregroundStyle(.secondary)
                    case .failed:
                        Image(systemName: "shippingbox.badge.exclamationmark")
                            .font(IonType.microLabel)
                            .foregroundStyle(theme.statusError)
                    case .idle, .ready, .none:
                        EmptyView()
                    }
                    // The action in flight on this worktree, in the slot its
                    // button occupied.
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                            .frame(width: Self.actionSize, height: Self.actionSize)
                            .accessibilityLabel("Working")
                    }
                }

                // A second line only when the worktree has something to
                // say that the marks above cannot: a membership state in
                // words, or an unknown source. The common case is one line.
                // The last commit and the bench order live in the long-press
                // menu, where there is room to read them.
                if !detailWords.isEmpty {
                    Text(detailWords.joined(separator: " · "))
                        .font(IonType.microLabel)
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                        .padding(.leading, disclosureExpanded == nil ? 0 : InboxLayout.chevronColumn + InboxLayout.iconColumn + IonSpace.compactInset * 2)
                }
            }
            .padding(.vertical, IonSpace.hairlineGap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if worktree.needsSync && worktree.sourceBranch != nil && worktree.operationState == nil {
                Button {
                    onSync()
                } label: {
                    Label("Sync", systemImage: "arrow.triangle.pull")
                }
                .tint(theme.statusWarning)
            }
        }
        .contextMenu {
            contextMenuContent
        }
    }
}
