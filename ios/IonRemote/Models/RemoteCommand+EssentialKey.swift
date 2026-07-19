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
    /// (fire-and-forget commands and non-queueable user actions), so callers
    /// can assert on the intent classification at the call site. Note that
    /// `.prompt` — although user-initiated — IS queueable: a user message must
    /// never be silently lost, so a failed send re-enqueues it for delivery on
    /// the reconnect flush (see `send(_:intent:)`).
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
        case .gitGraph(let dir, let skip, let limit):
            // One-shot view request (GitPaneView refresh / GitGraphListView
            // load-more). Keyed on the pagination window too: a "load more"
            // for page 2 must never dedupe against the page-1 request.
            return "gitGraph:\(dir):\(skip ?? 0):\(limit ?? 0)"
        case .gitDiff(let dir, let path, let staged):
            return "gitDiff:\(dir):\(path):\(staged)"
        case .gitCommitFiles(let dir, let hash):
            return "gitCommitFiles:\(dir):\(hash)"
        case .fsListDir(let dir, let includeHidden):
            return "fsListDir:\(dir):\(includeHidden)"
        case .sync:
            return "sync"
        case .reportFocus(let tabId, _):
            // Keyed by tabId (nil = backgrounded). Each focus state is distinct.
            return "reportFocus:\(tabId ?? "nil")"
        case .diagnosticLogsResponse:
            // Bare kind — last-write-wins is correct here: a newer export
            // supersedes a queued older one (each response carries all lines
            // past the desktop's cursor, so the newest is a superset and the
            // desktop re-pulls from its persisted cursor regardless).
            //
            // CRITICAL: without this case the fallback key in
            // send(_:intent:) was "unknown:\(command)", which string-
            // interpolates the ENTIRE payload — observed 2 MB keys from a
            // single diagnosticLogsResponse — and every queue/supersede log
            // line then embedded that key, amplifying memory until jetsam.
            return "diagnosticLogsResponse"
        case .prompt(let tabId, _, _, let clientMsgId, _, _, _):
            // User prompts are eligible for the essential queue so a message
            // sent over a wedged/reconnecting transport is re-enqueued and
            // delivered on the reconnect flush instead of being silently lost
            // (the optimistic bubble stays; the queued command delivers).
            //
            // Keyed by clientMsgId — unique per submit — so two DISTINCT
            // prompts to the same tab never dedupe each other. The queue's
            // last-write-wins collapse is for idempotent reloads; a user
            // message is never idempotent with a different user message.
            // Every live submit path sets clientMsgId (see
            // SessionViewModel+Submit.swift); the nil fallback exists only so
            // a hypothetical id-less prompt still gets a stable key.
            return "prompt:\(tabId):\(clientMsgId ?? "-")"
        default:
            // All other commands are either user-initiated or fire-and-forget;
            // they do not enter the essential queue.
            return nil
        }
    }
}
