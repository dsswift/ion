import Foundation

// MARK: - SendIntent

/// Classifies why a `send(_:intent:)` is being called.
///
/// The classification drives queueing and error-visibility:
///
///   - `.userInitiated`          The user explicitly tapped or typed something.
///                               Failure toasts (no transport → "Not connected";
///                               send error → "Send failed"). Never queued.
///
///   - `.automaticEssential`     Background send the screen requires to render
///                               correctly (load conversation, load attachments,
///                               command discovery, sync, terminal snapshot, git
///                               refresh, report-focus). If not connected at call
///                               time, the command is enqueued in the keyed
///                               essential queue (deduplicated by command identity,
///                               last-write-wins). The queue drains once when the
///                               first snapshot confirms `.connected`. No toast.
///                               **This is the safe default for `send()`.** A
///                               future automatic send that isn't tagged gets
///                               deferred-and-deduped rather than dropped.
///
///   - `.automaticFireAndForget` Background send that self-heals by construction:
///                               the same command will re-fire on the next natural
///                               trigger (image re-render, next snapshot, next gap).
///                               If not connected, dropped silently (logged only).
///                               No toast, no queue. Must be tagged explicitly at
///                               the call site with a one-line reason comment.
///
/// Safe-by-default rule: `send(_:)` defaults to `.automaticEssential`. Every
/// user-initiated call site passes `.userInitiated` explicitly. The handful of
/// fire-and-forget sites pass `.automaticFireAndForget` with a reason comment.
enum SendIntent {
    /// User explicitly initiated this send (tap, type, gesture). Toast on failure.
    case userInitiated
    /// Background/automatic send the screen needs; defer + dedupe if not connected.
    case automaticEssential
    /// Background send that regenerates on its own; drop silently if not connected.
    case automaticFireAndForget
}
