import XCTest
@testable import IonRemote

final class GitBranchesWireTests: XCTestCase {
    func testBranchesCommandRoundTrips() throws {
        let command = RemoteCommand.gitBranches(directory: "/repo")
        let data = try JSONEncoder().encode(command)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "desktop_git_branches")
        XCTAssertEqual(json["directory"] as? String, "/repo")
        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: data)
        guard case .gitBranches(let directory) = decoded else {
            return XCTFail("decoded to the wrong command")
        }
        XCTAssertEqual(directory, "/repo")
    }

    func testCreateTabWorktreeFieldsRoundTrip() throws {
        let command = RemoteCommand.createTab(
            workingDirectory: "/repo",
            useWorktree: true,
            sourceBranch: "main"
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try JSONEncoder().encode(command)) as? [String: Any])
        XCTAssertEqual(json["useWorktree"] as? Bool, true)
        XCTAssertEqual(json["sourceBranch"] as? String, "main")
        let decoded = try JSONDecoder().decode(RemoteCommand.self, from: try JSONEncoder().encode(command))
        guard case .createTab(_, _, _, _, _, let useWorktree, let sourceBranch) = decoded else {
            return XCTFail("decoded to the wrong command")
        }
        XCTAssertEqual(useWorktree, true)
        XCTAssertEqual(sourceBranch, "main")
    }

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
