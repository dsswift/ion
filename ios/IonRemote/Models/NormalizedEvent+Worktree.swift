import Foundation

// MARK: - Worktree + integration bench events
//
// Decode/encode for the two desktop→iOS worktree events. Kept out of
// NormalizedEvent+Git.swift so the git-response decoder stays focused and both
// files stay well under the 600-line cap.

extension RemoteEvent {

    /// Decode worktree/bench events. Returns nil for anything not owned here,
    /// so the caller can fall through to the other decoders.
    static func decodeWorktree(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .worktreeState:
            let states = try container.decode([RemoteWorktreeState].self, forKey: .states)
            return .worktreeState(states: states)

        case .worktreeOpResult:
            // The result fields live at the top level of the frame rather than
            // in a nested object, matching the desktop's flat event shape.
            let ok = try container.decode(Bool.self, forKey: .ok)
            let rawOp = try container.decode(String.self, forKey: .operation)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            let refusedDirty = try container.decodeIfPresent(Bool.self, forKey: .refusedDirty)
            let hasConflicts = try container.decodeIfPresent(Bool.self, forKey: .hasConflicts)
            let warning = try container.decodeIfPresent(String.self, forKey: .warning)
            return .worktreeOpResult(result: RemoteWorktreeOpResult(
                ok: ok,
                // An unrecognised operation from a newer desktop degrades to
                // `.assemble` rather than failing the decode: the operator still
                // sees the ok/error outcome, which is the actionable part.
                operation: RemoteWorktreeOpResult.Operation(rawValue: rawOp) ?? .assemble,
                error: error,
                refusedDirty: refusedDirty,
                hasConflicts: hasConflicts,
                warning: warning))

        default:
            return nil
        }
    }

    /// Encode worktree/bench events. iOS never sends these, but Codable
    /// conformance requires the path.
    func encodeWorktree(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .worktreeState(let states):
            try container.encode(TypeKey.worktreeState, forKey: .type)
            try container.encode(states, forKey: .states)
            return true

        case .worktreeOpResult(let result):
            try container.encode(TypeKey.worktreeOpResult, forKey: .type)
            try container.encode(result.ok, forKey: .ok)
            try container.encode(result.operation.rawValue, forKey: .operation)
            try container.encodeIfPresent(result.error, forKey: .error)
            try container.encodeIfPresent(result.refusedDirty, forKey: .refusedDirty)
            try container.encodeIfPresent(result.hasConflicts, forKey: .hasConflicts)
            try container.encodeIfPresent(result.warning, forKey: .warning)
            return true

        default:
            return false
        }
    }
}
