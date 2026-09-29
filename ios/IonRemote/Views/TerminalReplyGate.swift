import Foundation

/// Keeps a terminal view from answering the questions in replayed history.
///
/// Snapshot history is the raw pty stream, so it still holds every query a
/// program sent the terminal while it ran: the background color (OSC 11), the
/// cursor position (DSR 6n). SwiftTerm answers each one through its delegate's
/// `send` as it parses. During a history replay that answer is for a program
/// that already exited, and forwarding it types text like
/// `11;rgb:0000/0000/0000;1R` into the live shell.
///
/// SwiftTerm parses `feed` synchronously on the main thread, so every `send`
/// that fires inside `replayHistory` came from the history itself: no keystroke
/// can interleave, and nothing the operator types is ever dropped.
final class TerminalReplyGate {
    private(set) var isReplayingHistory = false
    private var droppedBytes = 0

    /// Run `feed` with every terminal answer it produces suppressed.
    func replayHistory(key: String, _ feed: () -> Void) {
        isReplayingHistory = true
        droppedBytes = 0
        feed()
        isReplayingHistory = false
        DiagnosticLog.log(
            "terminal history replayed with answers suppressed",
            tag: "terminal",
            level: .debug,
            fields: ["key": key, "dropped_bytes": String(droppedBytes)]
        )
    }

    /// Whether bytes the terminal wants to send should reach the pty.
    func shouldForward(byteCount: Int) -> Bool {
        if isReplayingHistory {
            droppedBytes += byteCount
            return false
        }
        return true
    }
}
