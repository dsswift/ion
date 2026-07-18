import XCTest
@testable import IonRemote

/// RC-19 / RC-28: dismissedLiveSpecialTabs means "this card instance was
/// dismissed", not "never show a special card on this tab again". It must be
/// cleared when a new run starts or a new permission request arrives, and both
/// dismissal sets must be wiped on a pairing switch/unpair (wipeTransientState).
@MainActor
final class SpecialCardDismissalResetTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String, status: TabStatus = .idle) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: status,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    func testNewRunClearsDismissal() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.dismissedLiveSpecialTabs.insert("t")

        vm.handleTabStatus(tabId: "t", status: .running)

        XCTAssertFalse(vm.dismissedLiveSpecialTabs.contains("t"),
            "a new run must clear the tab's prior special-card dismissal so a new card can render")
    }

    func testNewPermissionRequestClearsDismissal() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.dismissedLiveSpecialTabs.insert("t")

        vm.handlePermissionRequest(
            tabId: "t", questionId: "q-new", toolName: "ExitPlanMode",
            toolInput: nil, options: []
        )

        XCTAssertFalse(vm.dismissedLiveSpecialTabs.contains("t"),
            "a new permission request must clear the prior dismissal so the new card is not stripped")
    }

    func testWipeClearsBothDismissalSets() {
        let vm = SessionViewModel()
        vm.dismissedLiveSpecialTabs.insert("t")
        vm.dismissedRestoredCards.insert("restored-x")

        vm.wipeTransientState()

        XCTAssertTrue(vm.dismissedLiveSpecialTabs.isEmpty,
            "wipeTransientState must clear dismissedLiveSpecialTabs (per-pairing state)")
        XCTAssertTrue(vm.dismissedRestoredCards.isEmpty,
            "wipeTransientState must clear dismissedRestoredCards (per-pairing state)")
    }
}
