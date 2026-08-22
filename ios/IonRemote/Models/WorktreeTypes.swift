import Foundation

// MARK: - Worktree + integration bench models
//
// Mirrors the desktop wire types in
// `desktop/src/main/remote/protocol-worktree.ts`. The desktop owns this wire
// (ADR-008) and it is lockstep: these types ship in the same change as the TS
// side.
//
// The desktop computes every derived fact -- staleness, safety, drift -- so
// iOS renders main-process truth rather than deriving its own. That is what
// keeps the vocabulary identical across the overlay, the Studio mirror, and here.

/// One conversation open inside a worktree or bench directory.
///
/// Replaces the earlier single `openTabId`, which could say only "something is
/// open here" -- never which conversations, nor how many. A worktree routinely
/// hosts several, and collapsing them lost exactly the information that tells
/// one worktree's work apart from another's.
struct RemoteOpenConversation: Codable, Identifiable, Hashable {
    var tabId: String
    /// Display name: the operator's custom title when set, else the tab title.
    var title: String
    var status: String
    /// 1-based position in the tab list, matching the desktop's row hint.
    var index: Int
    /// Lifecycle role supplied by desktop. Keep raw String so a newer desktop's
    /// role still decodes and remains navigable on an older phone.
    var tabRole: String?

    var id: String { tabId }

    /// Compact truth about machine-owned bench work. Unknown roles deliberately
    /// stay unlabeled rather than being misidentified as operator work.
    var roleLabel: String? {
        switch tabRole {
        case "conflict-auto-fix": "Auto-fix"
        case "verification-analysis": "Analysis"
        case .some: "Other"
        case .none: nil
        }
    }
}

/// One worktree for a project.
struct RemoteWorktree: Codable, Identifiable, Hashable {
    var worktreePath: String
    var branchName: String
    var label: String
    /// Human-readable description of what this worktree is FOR, generated from
    /// the first prompt sent inside it. Nil until it has been named -- render
    /// `label` (the directory slug) then, and never invent a placeholder.
    var title: String?
    /// Nil when Ion did not create this worktree and cannot know its origin.
    /// Land and sync are unanswerable then, so the UI must not offer them --
    /// guessing a source branch would land work in the wrong place.
    var sourceBranch: String?
    var head: String
    var lastCommitSubject: String
    var isDirty: Bool
    var unlandedCommitCount: Int
    /// The feature branch moved ahead AND a sync would genuinely change this
    /// worktree. Never set when a sync would be a no-op: a badge nothing can
    /// clear teaches the operator to ignore every badge.
    var needsSync: Bool
    var safeToDiscard: Bool
    /// When this worktree's commits reached its source branch, or nil when they
    /// have not.
    ///
    /// The only honest signal for "finished". `safeToDiscard` means "nothing to
    /// lose", which is equally true of a worktree that has never committed
    /// anything -- grouping on it files every fresh empty worktree as if work had
    /// shipped. Set by the land verb; it cannot be recovered afterwards.
    var landedAt: Double?
    /// The operator's workflow stage, or nil when none is set. Registry-scoped
    /// on the desktop (it describes the worktree's lifecycle, not one bench
    /// pin), so unenrolled worktrees carry it too. The desktop owns the one
    /// automatic transition (`bug` moves to `test` when the bench pin
    /// advances); this app only renders and sets.
    var stage: WorkStage?
    /// Where this worktree is in the dependency-provisioning lifecycle
    /// (node_modules, hooks, build caches -- the gitignored state git never
    /// carries). Nil means Ion has no record: a worktree created before
    /// provisioning existed, or one whose in-memory record did not survive a
    /// desktop restart. Nil is "unknown", NOT "failed", so it renders as nothing.
    var provisionState: ProvisionState?
    /// Operator-facing reason when `provisionState` is `.failed`.
    var provisionError: String?
    /// Every conversation currently open in this worktree, in tab order. Empty
    /// when none are: tapping then opens a new one rather than focusing.
    ///
    /// Defaulted so a payload from an older desktop decodes to "none open"
    /// instead of failing the whole worktree list.
    var openConversations: [RemoteOpenConversation] = []
    /// Set while a rebase/merge/cherry-pick is in progress in this worktree —
    /// the state a conflicted sync leaves behind. The appraisal fields above
    /// are conservative defaults in that state, not live answers. Resolution
    /// is desktop-only; iOS renders the state so the worktree does not look
    /// healthy or vanish.
    var operationState: OperationState?
    /// Number of conflicted files when the operation is conflicted.
    var conflictedCount: Int?
    /// This worktree's bench membership, when it belongs to one. Nil for an
    /// unenrolled worktree.
    var membership: RemoteMembership?

    /// The name to show: the human title when there is one, else the slug.
    var displayName: String { title?.isEmpty == false ? title! : label }

    /// The compact parenthesized count shown beside this worktree. Nil keeps
    /// rows with no open conversation free of redundant status text.
    var openConversationCountLabel: String? {
        guard !openConversations.isEmpty else { return nil }
        return "(\(openConversations.count))"
    }

    var id: String { worktreePath }

    /// Mirrors GitOperationState in desktop/src/shared/types-git.ts.
    ///
    /// Decoded leniently like ProvisionState: an unrecognised value from a
    /// newer desktop becomes `.rebasing` (the generic "an operation is in
    /// progress" rendering) rather than failing the whole worktree decode.
    enum OperationState: String, Codable, Hashable {
        case rebasing, merging
        case cherryPicking = "cherry-picking"

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = OperationState(rawValue: raw) ?? .rebasing
        }
    }

    /// Mirrors WorktreeProvisionState in desktop/src/shared/types-git.ts.
    ///
    /// Decoded leniently: an unrecognised value from a newer desktop becomes
    /// nil rather than failing the whole worktree decode, so one new state
    /// cannot blank the entire worktree list on an older build.
    enum ProvisionState: String, Codable, Hashable {
        case idle, probing, seeding, building, ready, failed

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = ProvisionState(rawValue: raw) ?? .idle
        }
    }

    /// A placeholder record for a worktree the desktop's inventory has not
    /// reported yet, built from the identity the desktop already stamped on the
    /// conversation. Mirrors `fallbackWorktree` in the desktop's
    /// inbox-navigator.ts.
    ///
    /// Every appraisal field is the conservative "nothing known" value, so a row
    /// built from this offers no verb that needs an answer this app does not
    /// have. It exists because the inventory crawl can lag a freshly created
    /// worktree: without it, the worktree's header and every conversation filed
    /// under it disappear until the next crawl reports the path.
    static func placeholder(
        worktreePath: String,
        branchName: String,
        label: String,
        sourceBranch: String?,
        landedAt: Double?
    ) -> RemoteWorktree {
        var worktree = RemoteWorktree(unreportedPath: worktreePath)
        worktree.branchName = branchName
        worktree.label = label
        worktree.sourceBranch = sourceBranch
        worktree.landedAt = landedAt
        return worktree
    }

    /// Conservative zero record. Private so a placeholder can only be built
    /// through `placeholder(...)`, which documents why it exists.
    private init(unreportedPath: String) {
        worktreePath = unreportedPath
        branchName = ""
        label = unreportedPath
        head = ""
        lastCommitSubject = ""
        isDirty = false
        unlandedCommitCount = 0
        needsSync = false
        safeToDiscard = false
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        worktreePath = try c.decode(String.self, forKey: .worktreePath)
        branchName = try c.decode(String.self, forKey: .branchName)
        label = try c.decode(String.self, forKey: .label)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        sourceBranch = try c.decodeIfPresent(String.self, forKey: .sourceBranch)
        head = try c.decode(String.self, forKey: .head)
        lastCommitSubject = try c.decode(String.self, forKey: .lastCommitSubject)
        isDirty = try c.decode(Bool.self, forKey: .isDirty)
        unlandedCommitCount = try c.decode(Int.self, forKey: .unlandedCommitCount)
        needsSync = try c.decode(Bool.self, forKey: .needsSync)
        safeToDiscard = try c.decode(Bool.self, forKey: .safeToDiscard)
        landedAt = try c.decodeIfPresent(Double.self, forKey: .landedAt)
        // Lenient like ProvisionState: an unknown stage from a newer desktop
        // decodes to nil (no marker) rather than failing the worktree list.
        stage = (try c.decodeIfPresent(String.self, forKey: .stage)).flatMap(WorkStage.init(rawValue:))
        provisionState = try c.decodeIfPresent(ProvisionState.self, forKey: .provisionState)
        provisionError = try c.decodeIfPresent(String.self, forKey: .provisionError)
        openConversations = try c.decodeIfPresent([RemoteOpenConversation].self, forKey: .openConversations) ?? []
        operationState = try c.decodeIfPresent(OperationState.self, forKey: .operationState)
        conflictedCount = try c.decodeIfPresent(Int.self, forKey: .conflictedCount)
        membership = try c.decodeIfPresent(RemoteMembership.self, forKey: .membership)
    }

    /// True when this worktree's work has landed and nothing new is waiting.
    ///
    /// Enrollment deliberately does NOT veto this. A member's pin is an
    /// obligation only while it holds unlanded work; once the work is in the
    /// source branch the bench takes that content from its base, and the desktop's
    /// assembly retires the member outright.
    var isLanded: Bool { landedAt != nil }

    /// Membership is binary: a worktree is either in a bench or it is not.
    var isBenchMember: Bool { membership != nil }
}

/// One worktree's bench membership.
///
/// Carries NO worktree fields. This used to be a whole `RemoteBenchMember` that
/// re-sent `worktreePath`, `branchName`, `label`, and a `title` the desktop had
/// to resolve by joining against the inventory -- so an enrolled worktree
/// crossed the wire twice, in two shapes, and this app drew it in two sections
/// with two vocabularies. Membership now decorates the worktree it belongs to.
struct RemoteMembership: Codable, Hashable {
    /// How the bench's pinned contribution relates to the worktree's content.
    ///
    /// - `empty` — the pin carries no commits of its own, so there is nothing to
    ///   merge yet. Not an error and not terminal: it becomes `behind` as soon
    ///   as the worktree commits.
    /// - `absorbed` — the contribution landed into the source branch, so it is
    ///   part of the bench's base permanently.
    enum Pin: String, Codable {
        case empty, current, behind, absorbed, gone
    }

    /// What the last assembly did with this contribution.
    enum Merge: String, Codable {
        case unbuilt, merged, conflicted, skipped
    }

    /// Which bench: the source branch this integrates into.
    var sourceBranch: String
    /// Pin freshness and merge outcome are independent. A member can be behind
    /// and conflicted at once; the single `status` they replaced could report
    /// only one of those facts.
    var pin: Pin
    var merge: Merge
    /// The contribution currently integrated. Shown separately from the pin
    /// state: what the bench HOLDS and what the worktree HAS are different facts.
    var pinnedSha: String
    /// 1-based merge position, so the bench reads as the ordered stack it is.
    var order: Int
    var conflictPaths: [String]?
    var conflictsWith: [String]?
    /// Set when the merge succeeded only by replaying a recorded conflict
    /// resolution (git rerere on the desktop). Deterministic, but a different
    /// fact from a clean merge; nil from an older desktop reads as absent.
    var mergeResolution: String?

    /// Decode defensively: an unknown value from a newer desktop degrades to the
    /// conservative reading rather than failing the whole payload decode.
    /// `current` + `unbuilt` cannot be mistaken for a successful integration.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sourceBranch = try c.decode(String.self, forKey: .sourceBranch)
        pin = Pin(rawValue: try c.decode(String.self, forKey: .pin)) ?? .current
        merge = Merge(rawValue: try c.decode(String.self, forKey: .merge)) ?? .unbuilt
        pinnedSha = try c.decode(String.self, forKey: .pinnedSha)
        order = try c.decodeIfPresent(Int.self, forKey: .order) ?? 0
        conflictPaths = try c.decodeIfPresent([String].self, forKey: .conflictPaths)
        conflictsWith = try c.decodeIfPresent([String].self, forKey: .conflictsWith)
        mergeResolution = try c.decodeIfPresent(String.self, forKey: .mergeResolution)
    }
}

/// One integration workspace (bench).
struct RemoteBench: Codable, Identifiable, Hashable {
    var repoPath: String
    var sourceBranch: String
    var benchPath: String
    var benchBranch: String
    /// Memberships whose worktree is no longer in the inventory (absorbed into
    /// the source branch, or retired). They have no directory to open, so they
    /// are a footnote rather than rows -- but letting them vanish is what made
    /// absorption look like the bench eating a worktree.
    var orphans: [RemoteMembership]
    var baseSha: String
    var lastBuiltAt: Double
    /// Outcome of the last assembly. `failed` means the desktop wiped the bench
    /// to an empty tree (atomic assembly) and it holds NO member content until
    /// the conflict is resolved. Nil from an older desktop reads as unknown,
    /// never as a failure.
    var lastAssembly: String?
    /// Operator-facing reason when `lastAssembly` is `failed`.
    var lastAssemblyError: String?
    /// Which gate produced the failure. `"conflict"` means a member's pinned
    /// contribution would not merge; `"verification"` means every merge
    /// succeeded but the project's own verify command rejected the resulting
    /// tree. Nil on a record written before this split, or on an older
    /// desktop -- read as unclassified, never defaulted to `"conflict"`.
    var lastAssemblyFailure: String?
    /// Evidence for a `"verification"` failure. Nil otherwise, and nil from an
    /// older desktop. The recovery verbs (dismiss, discard-and-reassemble,
    /// analyse) are desktop-only -- this is read-only detail for the footer.
    var lastAssemblyVerification: RemoteBenchVerification?
    /// The feature branch has moved past the bench's base, so an assembly would
    /// pick up work that landed since.
    var baseDrifted: Bool
    /// Conversations open in the bench directory, in tab order.
    var openConversations: [RemoteOpenConversation] = []
    /// Singleton conversation tab rooted in this bench, when one is open.
    /// Absent on older desktops and before first creation.
    var benchConversationTabId: String?
    /// The bench's dedicated terminal tab, when one is open.
    ///
    /// One tab per bench, so this is a single id rather than a list. The desktop
    /// derives it from the tab's own persisted state rather than storing an id,
    /// so it is absent exactly when no such tab exists -- and absent on an older
    /// desktop that does not send it, which reads as "not open" rather than as
    /// an error.
    var benchTerminalTabId: String?

    var id: String { benchPath }

    var hasBeenBuilt: Bool { lastBuiltAt > 0 }

    /// Role-aware label for bench Conversation actions. Machine work is visible
    /// because it runs against shared integration state, unlike hidden machine
    /// worktree conversations.
    var conversationActionTitle: String {
        guard !openConversations.isEmpty else { return "Talk" }
        let labels = Array(Set(openConversations.compactMap(\.roleLabel))).sorted()
        guard !labels.isEmpty else { return "Go to" }
        let roleText = labels.joined(separator: " + ")
        return openConversations.count == 1 ? "\(roleText) open" : "Go to · \(roleText)"
    }

    /// The running auto-fix is the only machine conversation that needs an
    /// attention signal. Its identity stays in the desktop projection; iOS only
    /// focuses the projected tab and never creates or infers a replacement.
    var activeAutoFixTabId: String? {
        openConversations.first {
            $0.tabRole == "conflict-auto-fix" &&
                ($0.status == "running" || $0.status == "connecting")
        }?.tabId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        repoPath = try c.decode(String.self, forKey: .repoPath)
        sourceBranch = try c.decode(String.self, forKey: .sourceBranch)
        benchPath = try c.decode(String.self, forKey: .benchPath)
        benchBranch = try c.decode(String.self, forKey: .benchBranch)
        orphans = try c.decodeIfPresent([RemoteMembership].self, forKey: .orphans) ?? []
        baseSha = try c.decode(String.self, forKey: .baseSha)
        lastBuiltAt = try c.decode(Double.self, forKey: .lastBuiltAt)
        lastAssembly = try c.decodeIfPresent(String.self, forKey: .lastAssembly)
        lastAssemblyError = try c.decodeIfPresent(String.self, forKey: .lastAssemblyError)
        lastAssemblyFailure = try c.decodeIfPresent(String.self, forKey: .lastAssemblyFailure)
        lastAssemblyVerification = try c.decodeIfPresent(RemoteBenchVerification.self, forKey: .lastAssemblyVerification)
        baseDrifted = try c.decode(Bool.self, forKey: .baseDrifted)
        openConversations = try c.decodeIfPresent([RemoteOpenConversation].self, forKey: .openConversations) ?? []
        benchConversationTabId = try c.decodeIfPresent(String.self, forKey: .benchConversationTabId)
        benchTerminalTabId = try c.decodeIfPresent(String.self, forKey: .benchTerminalTabId)
    }
}

/// Evidence for a bench verification failure: what ran, what it said, and
/// which members' merges came from a replayed rerere recording (the
/// suspects). Read-only on iOS -- desktop-only recovery verbs act on it.
struct RemoteBenchVerification: Codable, Hashable {
    var command: String
    var outputTail: String
    var replayedBranches: [String]
}

/// Live projection of the desktop's worktree sync pipeline
/// (`desktop_worktree_pipeline`). The desktop pushes one on every phase or
/// progress change; `phase == nil` means the pipeline was dismissed and the
/// banner clears. All wording (summary) is desktop-authored so every client
/// renders the same sentence.
struct RemoteWorktreePipeline: Codable, Hashable {
    /// Mirrors WorktreePipelineState.phase plus the nil dismissal.
    enum Phase: String, Codable {
        case syncing
        case awaitingAiConfirm = "awaiting-ai-confirm"
        case resolving, assembling, done, failed

        /// Lenient like the other worktree enums: an unknown phase from a
        /// newer desktop renders as the generic in-progress state rather than
        /// failing the event decode.
        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Phase(rawValue: raw) ?? .syncing
        }
    }

    var repoPath: String
    var sourceBranch: String?
    /// Nil when the pipeline was dismissed (clear the banner).
    var phase: Phase?
    /// Conflicted worktree paths awaiting AI confirmation / resolution.
    var queue: [String]
    /// Worktree path the current agent is resolving, when phase == .resolving.
    var current: String?
    /// Worktree paths parked for manual resolution.
    var needsManual: [String]
    var resolvedByAi: Int
    /// Terminal one-line summary (done/failed), desktop-worded.
    var summary: String?
}

/// Worktree + bench state for one project.
struct RemoteWorktreeState: Codable, Identifiable, Hashable {
    var repoPath: String
    var worktrees: [RemoteWorktree]
    var benches: [RemoteBench]

    var id: String { repoPath }

    /// Worktrees whose base has drifted -- surfaced on the tab row so the
    /// operator does not have to drill into the git pane to discover they are
    /// building against stale code.
    var staleBaseCount: Int { worktrees.filter(\.needsSync).count }

    // Bench counts are derived from the WORKTREES now, because membership rides
    // the worktree record. There is no separate member list to count, which is
    // the point: one object, counted once.

    /// Worktrees enrolled in `bench`, in merge order.
    func members(of bench: RemoteBench) -> [RemoteWorktree] {
        worktrees
            .filter { $0.membership?.sourceBranch == bench.sourceBranch }
            .sorted { ($0.membership?.order ?? 0) < ($1.membership?.order ?? 0) }
    }

    func memberCount(of bench: RemoteBench) -> Int {
        members(of: bench).count
    }

    /// Members holding work newer than the bench's pin.
    func behindMemberCount(of bench: RemoteBench) -> Int {
        members(of: bench).filter { $0.membership?.pin == .behind }.count
    }

    func conflictedMemberCount(of bench: RemoteBench) -> Int {
        members(of: bench).filter { $0.membership?.merge == .conflicted }.count
    }

    /// Worktrees in no bench at all, for the enrollment picker.
    func unenrolled() -> [RemoteWorktree] {
        worktrees.filter { $0.membership == nil }
    }
}

/// Result of a worktree/bench verb, so a toast can attribute the outcome.
struct RemoteWorktreeOpResult: Codable, Hashable {
    enum Operation: String, Codable {
        case open, sync, assemble, update
        /// The combined land verb. Raw value matches the desktop's
        /// `land_and_retire` — an earlier `land` case never matched what the
        /// desktop sends, so every successful land decoded through the
        /// `.assemble` fallback and toasted "Bench assembled."
        case landAndRetire = "land_and_retire"
        case retire
        case updateAll = "update_all"
        case syncAll = "sync_all"
        case retireAll = "retire_all"
        case create, convert, rename, reprovision
        case recoverConflict = "recover_conflict"
        /// AI-assisted conflict resolution launched (worktree or bench chain).
        case conflictAssist = "conflict_assist"
        case analyseVerification = "analyse_verification"
        case discardRecordings = "discard_recordings"
        /// Acknowledgement (or refusal) of a remote pipeline start.
        case pipelineStart = "pipeline_start"
    }

    var ok: Bool
    var operation: Operation
    var error: String?
    /// Tab opened or focused by an `open` result.
    var tabId: String?
    /// Recovery ref created by a forced retire that preserved dirty work.
    var recoveryRef: String?
    /// Benches removed because the worktree's departure left them empty.
    var prunedBenchPaths: [String]?
    /// A refusal the operator can resolve (commit or stash), distinct from a
    /// hard failure -- the message and the recovery differ.
    var refusedDirty: Bool?
    var hasConflicts: Bool?
    /// Non-blocking collision prediction from the desktop's pin-update dry-run:
    /// the operation SUCCEEDED, but the next assembly will conflict. Nil from
    /// an older desktop reads as no prediction.
    var warning: String?
    /// Per-worktree counts for `sync_all`, pre-worded by the desktop so every
    /// client renders the same sentence ("3 synced, 1 conflicted, ..."). Nil
    /// on the single-target verbs and from an older desktop.
    var summary: String?
    /// `retire_all`'s count of worktrees actually retired before it stopped —
    /// either at the end (`ok`) or at the first failure (partial, `!ok`). Nil
    /// on every other operation and from an older desktop.
    var retired: Int?
}
