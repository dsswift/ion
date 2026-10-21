import XCTest
@testable import IonRemote

/// Pins that backgrounding the app does not forget which conversation is on
/// screen.
///
/// `focusedTabId` decides whose composer owns its draft: a snapshot never
/// replaces the focused conversation's text. Backgrounding used to clear it,
/// and the resume re-report sent that cleared value back, so after one trip
/// to the background the open conversation looked unfocused. The next
/// snapshot carrying the host's older draft then overwrote the words being
/// typed.
@MainActor
final class ComposerFocusAcrossBackgroundTests: XCTestCase {

    private func makeTab(id: String, draft: String?) -> RemoteTabState {
        var tab = RemoteTabState(
            id: id, title: id, customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: true
        )
        tab.draftInput = draft
        return tab
    }

    /// `sendReportFocus` applies the new focus on a main-actor hop.
    private func settle() async {
        for _ in 0..<5 { await Task.yield() }
    }

    func testBackgroundKeepsTheConversationOnScreen() async {
        let vm = SessionViewModel()
        vm.sendReportFocus(tabId: "tab-1")
        await settle()

        vm.reportBackgroundFocus()
        await settle()

        XCTAssertEqual(vm.focusedTabId, "tab-1",
            "backgrounding must not forget the conversation still on screen")
    }

    func testSnapshotAfterResumeKeepsTheTypedDraft() async {
        let vm = SessionViewModel()
        vm.tabs = [makeTab(id: "tab-1", draft: nil)]
        vm.sendReportFocus(tabId: "tab-1")
        await settle()

        // Typed, and the debounced write already went out, so no local send
        // is pending to shield the composer.
        vm.setTabDraft("tab-1", "hello there world")
        vm.flushDraftSend("tab-1")

        // Background, then resume with the re-report the app sends.
        vm.reportBackgroundFocus()
        await settle()
        vm.sendReportFocus(tabId: vm.focusedTabId)
        await settle()

        // A snapshot built before the host saw the latest write.
        vm.reconcileDraftsWithSnapshot([makeTab(id: "tab-1", draft: "hello")], liveTabIds: ["tab-1"])

        XCTAssertEqual(vm.tabDraft("tab-1"), "hello there world",
            "a snapshot must never replace the focused conversation's draft")
    }

    func testNewerFocusReportSupersedesAQueuedOne() async {
        let vm = SessionViewModel()

        // Offline, so both reports queue for the reconnect flush.
        vm.reportBackgroundFocus()
        vm.sendReportFocus(tabId: "tab-1")
        await settle()

        let focusReports = vm.pendingEssentialQueue.compactMap { entry -> String?? in
            if case .reportFocus(let tabId, _) = entry.command { return .some(tabId) }
            return nil
        }
        XCTAssertEqual(focusReports, [.some("tab-1")],
            "only the newest focus report may reach the host after reconnect")
    }
}
