import XCTest
@testable import IonRemote

final class InboxNavigatorBenchOrderTests: XCTestCase {
    private let decoder = JSONDecoder()

    /// Bench members are one ordered band at the top. Worktrees outside the
    /// bench keep their input order after that band.
    func testWorktreeOrderPutsBenchMembersFirstInMergeOrder() throws {
        let state = try worktreeStateWithOrderedBenchMembers()
        let outside = try tab(id: "outside", directory: "/repo/.ion/worktrees/outside")
        let second = try tab(id: "second", directory: "/repo/.ion/worktrees/second")
        let first = try tab(id: "first", directory: "/repo/.ion/worktrees/first")

        let project = try XCTUnwrap(InboxNavigator.projects(
            tabs: [outside, second, first], states: [state.repoPath: state]
        ).first)

        XCTAssertEqual(project.worktreeOrder, [
            "/repo/.ion/worktrees/first",
            "/repo/.ion/worktrees/second",
            "/repo/.ion/worktrees/outside"
        ])
    }

    private func tab(id: String, directory: String) throws -> RemoteTabState {
        let json = """
        {"id":"\(id)","title":"\(id)","status":"idle","workingDirectory":"\(directory)",
        "permissionMode":"auto","permissionQueue":[],"inboxState":"active"}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteTabState.self, from: json)
    }

    private func worktreeStateWithOrderedBenchMembers() throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"/repo","worktrees":[
        {"worktreePath":"/repo/.ion/worktrees/outside","branchName":"wt/outside","label":"outside","head":"o",
         "lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true},
        {"worktreePath":"/repo/.ion/worktrees/second","branchName":"wt/second","label":"second","head":"s",
         "lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true,
         "membership":{"sourceBranch":"main","pin":"current","merge":"unbuilt","pinnedSha":"s","order":2}},
        {"worktreePath":"/repo/.ion/worktrees/first","branchName":"wt/first","label":"first","head":"f",
         "lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,"needsSync":false,"safeToDiscard":true,
         "membership":{"sourceBranch":"main","pin":"current","merge":"unbuilt","pinnedSha":"f","order":1}}
        ],"benches":[{"repoPath":"/repo","sourceBranch":"main","benchPath":"/bench/main",
        "benchBranch":"bench/main","baseSha":"abc","lastBuiltAt":0,"baseDrifted":false}]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }
}
