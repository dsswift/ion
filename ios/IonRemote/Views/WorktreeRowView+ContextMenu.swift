import SwiftUI

// MARK: - WorktreeRowView long-press menu
//
// Every verb a worktree has, and the facts the one-line row leaves out.
// Split from WorktreeRowView.swift at the file-size cap; the row attaches
// this as its context menu.

extension WorktreeRowView {

    @ViewBuilder
    var contextMenuContent: some View {
        // What the row itself no longer spells out: the branch, the last
        // commit, and the bench position.
        Section(contextSummary) {}
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
                    Text(verificationFailure.command).font(IonType.mono)
                    Text(verificationFailure.outputTail).font(IonType.microLabel).lineLimit(4)
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

            // "Land and retire" also covers the discard case: a worktree
            // with nothing to land (a mistake, or abandoned before the
            // first commit) still needs a way to go away. The label and
            // disabled gate match the desktop's canLandWorktree /
            // landRefusalReason (WorktreeRowMenu.items.tsx) — dirty or an
            // unknown source branch still refuses; zero unlanded commits
            // does not.
            Button(role: worktree.unlandedCommitCount == 0 ? .destructive : nil) {
                onLandAndRetire()
            } label: {
                Label(
                    worktree.unlandedCommitCount > 0
                        ? "Land and retire into \(worktree.sourceBranch ?? "source")"
                        : "Retire (nothing to land)",
                    systemImage: "arrow.down.to.line"
                )
            }
            .disabled(worktree.isDirty || worktree.operationState != nil)
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
        // Discard removes the worktree without merging it. The desktop
        // appraises and preserves recoverable work before removal.
        if let onRetire {
            Button(role: .destructive) {
                onRetire()
            } label: {
                Label("Discard worktree", systemImage: "trash")
            }
            .disabled(worktree.operationState != nil)
        }
    }
}
