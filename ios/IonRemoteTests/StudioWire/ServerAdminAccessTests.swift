import XCTest
@testable import IonRemote

/// What a connection's welcome scopes let the phone do on a server, and what
/// it tells the person when they do not.
final class ServerAdminAccessTests: XCTestCase {

    func testAdminSatisfiesEveryScope() {
        let access = ServerAdminAccess(serverLabel: "Studio Mac", scopes: ["admin"])
        for action in PhoneAction.allCases {
            XCTAssertTrue(access.allows(action), action.rawValue)
            XCTAssertNil(access.denialReason(action), action.rawValue)
        }
    }

    func testAnAdminActionIsDeniedWithoutAdminAndSaysHowToGetIt() {
        let access = ServerAdminAccess(serverLabel: "Studio Mac", scopes: ["conversations:read", "conversations:operate"])
        XCTAssertFalse(access.allows(.mcpAdd))
        XCTAssertEqual(access.denialReason(.mcpAdd), "Needs admin access on Studio Mac. Pair again with a link that grants it.")
        XCTAssertTrue(access.allows(.environmentProjectsList))
        XCTAssertNil(access.denialReason(.environmentProjectsList))
    }

    func testAGitWriteActionNamesGitWriteAccess() {
        let access = ServerAdminAccess(serverLabel: "Build box", scopes: ["conversations:read"])
        XCTAssertEqual(access.denialReason(.environmentProjectsAdd), "Needs git write access on Build box. Pair again with a link that grants it.")
    }

    /// Before the welcome nothing is allowed on screen, and nothing is
    /// refused either: the server has not said yet.
    func testUnknownScopesAllowNothingAndRefuseNothing() {
        let access = ServerAdminAccess(serverLabel: "Studio Mac", scopes: nil)
        XCTAssertFalse(access.allows(.environmentProjectsList))
        XCTAssertNil(access.denialReason(.mcpAdd))
    }
}
