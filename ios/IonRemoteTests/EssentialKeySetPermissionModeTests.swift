import XCTest
@testable import IonRemote

// MARK: - EssentialKeySetPermissionModeTests
//
// Pins the contract that .setPermissionMode is eligible for the essential
// queue and therefore survives transport outages. The motivating incident
// (2026-07-19, conversation 1784462599956-cf7777fd7e04): the user tapped
// plan→auto on iOS while the transport was torn down; without an essentialKey
// the command was dropped with an error toast and never replayed on reconnect,
// leaving the mode switch permanently lost.

final class EssentialKeySetPermissionModeTests: XCTestCase {

    // MARK: - Test 1: command is eligible for the essential queue

    func testSetPermissionModeHasEssentialKey() {
        let cmd = RemoteCommand.setPermissionMode(tabId: "tab-1", mode: PermissionMode.auto)
        XCTAssertNotNil(cmd.essentialKey,
            "setPermissionMode must have an essentialKey so it is queued for the reconnect flush, not dropped")
    }

    // MARK: - Test 2: key format encodes tabId correctly

    func testSetPermissionModeKeyFormat() {
        let tabId = "ba761e4e-2476-4b7e-a683-bc315dc91f9f"
        let cmd = RemoteCommand.setPermissionMode(tabId: tabId, mode: PermissionMode.plan)
        XCTAssertEqual(cmd.essentialKey, "setPermissionMode:\(tabId)",
            "essentialKey must be 'setPermissionMode:<tabId>' for last-write-wins dedup to work correctly")
    }

    // MARK: - Test 3: same tab + different modes → same key (last-write-wins)

    func testSameTabDifferentModesProduceSameKey() {
        let autoCmd = RemoteCommand.setPermissionMode(tabId: "tab-1", mode: PermissionMode.auto)
        let planCmd = RemoteCommand.setPermissionMode(tabId: "tab-1", mode: PermissionMode.plan)
        XCTAssertEqual(autoCmd.essentialKey, planCmd.essentialKey,
            "plan→auto→plan flips on the same tab while disconnected must collapse to the final intent via last-write-wins")
    }

    // MARK: - Test 4: different tabs → different keys (no cross-tab collapse)

    func testDifferentTabsProduceDifferentKeys() {
        let cmdA = RemoteCommand.setPermissionMode(tabId: "tab-a", mode: PermissionMode.auto)
        let cmdB = RemoteCommand.setPermissionMode(tabId: "tab-b", mode: PermissionMode.auto)
        XCTAssertNotEqual(cmdA.essentialKey, cmdB.essentialKey,
            "setPermissionMode for different tabs must never collapse into a single queue entry")
    }

    // MARK: - Test 5: no namespace collision with other commands on the same tabId

    func testNoNamespaceCollisionWithOtherCommands() {
        let tabId = "tab-1"
        let modeKey = RemoteCommand.setPermissionMode(tabId: tabId, mode: PermissionMode.auto).essentialKey
        let promptKey = RemoteCommand.prompt(tabId: tabId, text: "hello", clientMsgId: "msg-1").essentialKey
        let focusKey = RemoteCommand.reportFocus(tabId: tabId, interceptEnabled: true).essentialKey

        XCTAssertNotEqual(modeKey, promptKey,
            "setPermissionMode key must not collide with prompt key for the same tabId")
        XCTAssertNotEqual(modeKey, focusKey,
            "setPermissionMode key must not collide with reportFocus key for the same tabId")
    }
}
