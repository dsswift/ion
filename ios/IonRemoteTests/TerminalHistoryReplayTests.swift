import XCTest
import SwiftTerm
@testable import IonRemote

/// A terminal view must not answer the questions in replayed snapshot history.
///
/// Snapshot history is the raw pty stream, so it carries every query a program
/// sent while it ran (a Go CLI using lipgloss asks for the background color and
/// the cursor position at startup). SwiftTerm answers them as it parses. Before
/// the fix the history went through the live-output handler, and every answer
/// was forwarded to the desktop pty, where the shell showed it as
/// `11;rgb:0000/0000/0000;1R`.
@MainActor
final class TerminalHistoryReplayTests: XCTestCase {
    private let queries = "\u{1b}]11;?\u{1b}\\\u{1b}[6n"

    /// Records what the terminal view would send to the pty, through the gate.
    private final class Recorder: TerminalViewDelegate {
        let gate = TerminalReplyGate()
        var sent: [String] = []

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            guard gate.shouldForward(byteCount: data.count) else { return }
            sent.append(String(bytes: data, encoding: .utf8) ?? "")
        }
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func scrolled(source: TerminalView, position: Double) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
    }

    private func makeTerminal() -> (TerminalView, Recorder) {
        let view = TerminalView(frame: CGRect(x: 0, y: 0, width: 320, height: 240))
        let recorder = Recorder()
        view.terminalDelegate = recorder
        return (view, recorder)
    }

    func testLiveQueriesAreAnswered() {
        let (view, recorder) = makeTerminal()
        view.feed(text: queries)
        XCTAssertFalse(recorder.sent.isEmpty, "a live query must still be answered")
    }

    func testReplayedHistoryIsNotAnswered() {
        let (view, recorder) = makeTerminal()
        recorder.gate.replayHistory(key: "tab-1:inst-1") {
            view.feed(text: "$ infra --version\r\n\(queries)infra version 1\r\n")
        }
        XCTAssertEqual(recorder.sent, [])
        XCTAssertFalse(recorder.gate.isReplayingHistory)

        view.feed(text: queries)
        XCTAssertFalse(recorder.sent.isEmpty, "output after the history is answered normally")
    }

    func testSnapshotBuffersReachTheHistoryHandlerNotTheLiveOne() {
        let router = TerminalOutputRouter()
        var live: [String] = []
        var history: [String] = []

        // A snapshot that arrives before the view registers is held, then
        // flushed as history.
        router.feedBuffer(tabId: "tab-1", instanceId: "inst-1", data: "early")
        router.register(
            key: "tab-1:inst-1",
            dataHandler: { live.append($0) },
            historyHandler: { history.append($0) },
            exitHandler: { _ in },
            restartHandler: {}
        )
        router.feedBuffer(tabId: "tab-1", instanceId: "inst-1", data: "late")
        router.route(tabId: "tab-1", instanceId: "inst-1", data: "output")

        XCTAssertEqual(history, ["early", "late"])
        XCTAssertEqual(live, ["output"])
    }

    func testRestartReachesTheViewAndDropsTheReplacedShellsPendingHistory() {
        let router = TerminalOutputRouter()
        var restarts = 0
        var history: [String] = []

        router.feedBuffer(tabId: "tab-1", instanceId: "inst-1", data: "old run")
        router.routeRestart(tabId: "tab-1", instanceId: "inst-1")
        router.register(
            key: "tab-1:inst-1",
            dataHandler: { _ in },
            historyHandler: { history.append($0) },
            exitHandler: { _ in },
            restartHandler: { restarts += 1 }
        )
        XCTAssertEqual(history, [])

        router.routeRestart(tabId: "tab-1", instanceId: "inst-1")
        XCTAssertEqual(restarts, 1)
    }
}
