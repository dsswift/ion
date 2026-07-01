import Foundation

// MARK: - RemoteCommand essential-queue identity key

extension RemoteCommand {

    /// A stable string that uniquely identifies this command's *intent* for the
    /// purposes of the `.automaticEssential` deferred queue.
    ///
    /// The essential queue deduplicates by this key (last-write-wins): if the same
    /// key is enqueued twice while not-connected, the second supersedes the first.
    /// This prevents a burst of `.onAppear`/`.task` re-fires during reconnect from
    /// producing duplicate loads once the transport is proven usable.
    ///
    /// Key format: `"<commandKind>:<primaryScopeId>"`.
    /// Commands without a natural scope id use the bare command kind as the key.
    ///
    /// Returns `nil` for commands that should never enter the essential queue
    /// (user-initiated and fire-and-forget commands), so callers can assert on
    /// the intent classification at the call site.
    var essentialKey: String? {
        switch self {
        case .loadConversation(let tabId, _):
            return "loadConversation:\(tabId)"
        case .loadAttachments(let tabId):
            return "loadAttachments:\(tabId)"
        case .discoverCommands(let dir):
            return "discoverCommands:\(dir)"
        case .requestTerminalSnapshot(let tabId):
            return "requestTerminalSnapshot:\(tabId)"
        case .gitChanges(let dir):
            return "gitChanges:\(dir)"
        case .sync:
            return "sync"
        case .reportFocus(let tabId, _):
            // Keyed by tabId (nil = backgrounded). Each focus state is distinct.
            return "reportFocus:\(tabId ?? "nil")"
        default:
            // All other commands are either user-initiated or fire-and-forget;
            // they do not enter the essential queue.
            return nil
        }
    }
}
