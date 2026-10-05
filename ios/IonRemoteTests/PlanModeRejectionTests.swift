import XCTest
@testable import IonRemote

/// A refused plan-mode toggle: the snapshot carries the refusal, the
/// snapshot's mode wins over the phone's optimistic toggle, and the status
/// bar says why.
final class PlanModeRejectionTests: XCTestCase {

    private func tabJSON(mode: String, rejection: String?) -> Data {
        let field = rejection.map { #","planModeRejection":\#($0)"# } ?? ""
        return Data(#"{"id":"tab-1","title":"T","status":"idle","workingDirectory":"/tmp","permissionMode":"\#(mode)","permissionQueue":[]\#(field)}"#.utf8)
    }

    private let refusal = #"{"requestedEnabled":true,"reason":"a release is running","source":"wire","at":1759600000000}"#

    func testTabDecodesWithoutARejection() throws {
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(mode: "auto", rejection: nil))
        XCTAssertNil(tab.planModeRejection)
    }

    func testTabDecodesARejection() throws {
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(mode: "auto", rejection: refusal))
        XCTAssertEqual(tab.planModeRejection, PlanModeRejection(requestedEnabled: true, reason: "a release is running", source: "wire", at: 1_759_600_000_000))
    }

    @MainActor
    func testTheSnapshotModeWinsOverTheOptimisticToggle() throws {
        let vm = SessionViewModel()
        vm.handleSnapshot(snapshotTabs: [try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(mode: "auto", rejection: nil))], recentDirs: [])
        vm.setPermissionMode(tabId: "tab-1", mode: .plan)
        XCTAssertEqual(vm.tab(for: "tab-1")?.permissionMode, .plan, "the toggle is optimistic")

        vm.handleSnapshot(snapshotTabs: [try JSONDecoder().decode(RemoteTabState.self, from: tabJSON(mode: "auto", rejection: refusal))], recentDirs: [])
        XCTAssertEqual(vm.tab(for: "tab-1")?.permissionMode, .auto, "the refused toggle reverts")
        XCTAssertEqual(vm.tab(for: "tab-1")?.planModeRejection?.reason, "a release is running")
    }

    func testRefusalLine() {
        XCTAssertNil(ConversationStatusBar.planModeRefusalText(nil))
        XCTAssertEqual(
            ConversationStatusBar.planModeRefusalText(PlanModeRejection(requestedEnabled: true, reason: "a release is running", source: "wire", at: 0)),
            "Plan mode was refused: a release is running"
        )
        XCTAssertEqual(
            ConversationStatusBar.planModeRefusalText(PlanModeRejection(requestedEnabled: false, reason: " ", source: "extension", at: 0)),
            "Auto mode was refused."
        )
    }
}
