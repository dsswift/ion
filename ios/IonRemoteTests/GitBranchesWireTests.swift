import XCTest
@testable import IonRemote

final class GitBranchesWireTests: XCTestCase {
    func testBranchesResponseDecodes() throws {
        let json = #"{"type":"desktop_git_branches_response","directory":"/repo","branches":["main","feature/test"],"current":"main"}"#
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
        guard case .gitBranchesResponse(let directory, let response) = event else {
            return XCTFail("decoded to the wrong event")
        }
        XCTAssertEqual(directory, "/repo")
        XCTAssertEqual(response.branches, ["main", "feature/test"])
        XCTAssertEqual(response.current, "main")
    }
}
