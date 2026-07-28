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
// keeps the vocabulary identical across the overlay, the ATV mirror, and here.

/// One worktree for a project.
struct RemoteWorktree: Codable, Identifiable, Hashable {
    var worktreePath: String
    var branchName: String
    var label: String
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
    /// Where this worktree is in the dependency-provisioning lifecycle
    /// (node_modules, hooks, build caches -- the gitignored state git never
    /// carries). Nil means Ion has no record: a worktree created before
    /// provisioning existed, or one whose in-memory record did not survive a
    /// desktop restart. Nil is "unknown", NOT "failed", so it renders as nothing.
    var provisionState: ProvisionState?
    /// Operator-facing reason when `provisionState` is `.failed`.
    var provisionError: String?
    /// Set when a conversation is already open here, so tapping focuses it
    /// rather than stacking a duplicate.
    var openTabId: String?

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

    var id: String { worktreePath }
}

/// One worktree layered onto the bench.
struct RemoteBenchMember: Codable, Identifiable, Hashable {
    enum Status: String, Codable {
        /// `pending` — enrolled but the pin carries no commits of its own, so
        /// there is nothing to merge yet. Not an error and not terminal: the
        /// member becomes `stale` as soon as the worktree commits.
        case integrated, pending, landed, stale, conflicted, missing, excluded
    }

    var worktreePath: String
    var branchName: String
    var label: String
    var enabled: Bool
    /// The contribution currently integrated. Shown separately from staleness:
    /// what the bench HOLDS and what the worktree HAS are different facts.
    var pinnedSha: String
    var status: Status
    var conflictPaths: [String]?
    var conflictsWith: [String]?

    var id: String { worktreePath }

    /// Decode defensively: an unknown status from a newer desktop degrades to
    /// `.stale` rather than failing the whole payload decode.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        worktreePath = try c.decode(String.self, forKey: .worktreePath)
        branchName = try c.decode(String.self, forKey: .branchName)
        label = try c.decode(String.self, forKey: .label)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        pinnedSha = try c.decode(String.self, forKey: .pinnedSha)
        let raw = try c.decode(String.self, forKey: .status)
        status = Status(rawValue: raw) ?? .stale
        conflictPaths = try c.decodeIfPresent([String].self, forKey: .conflictPaths)
        conflictsWith = try c.decodeIfPresent([String].self, forKey: .conflictsWith)
    }
}

/// One integration workspace (bench).
struct RemoteBench: Codable, Identifiable, Hashable {
    var repoPath: String
    var sourceBranch: String
    var benchPath: String
    var benchBranch: String
    var members: [RemoteBenchMember]
    var baseSha: String
    var lastBuiltAt: Double
    /// The feature branch has moved past the bench's base, so a rebuild would
    /// pick up work that landed since.
    var baseDrifted: Bool
    var openTabId: String?

    var id: String { benchPath }

    var enabledMemberCount: Int { members.filter(\.enabled).count }
    var staleMemberCount: Int { members.filter { $0.status == .stale }.count }
    var conflictedMemberCount: Int { members.filter { $0.status == .conflicted }.count }
    var hasBeenBuilt: Bool { lastBuiltAt > 0 }
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
}

/// Result of a worktree/bench verb, so a toast can attribute the outcome.
struct RemoteWorktreeOpResult: Codable, Hashable {
    enum Operation: String, Codable {
        case sync, land, rebuild, update
        case updateAll = "update_all"
    }

    var ok: Bool
    var operation: Operation
    var error: String?
    /// A refusal the operator can resolve (commit or stash), distinct from a
    /// hard failure -- the message and the recovery differ.
    var refusedDirty: Bool?
    var hasConflicts: Bool?
}
