import XCTest
@testable import IonRemote

final class WorktreeProjectIdentityTests: XCTestCase {
    private let decoder = JSONDecoder()

    func testExplicitWorktreeIdentityWinsOverDirectoryAlias() throws {
        let state = try state(repo: "/repo", worktree: "/repo/.ion/worktrees/a", bench: "/bench")
        let tab = try tab(
            id: "work",
            directory: "/unlisted/worktree",
            worktree: (path: "/unlisted/worktree", repo: "/repo")
        )

        XCTAssertEqual(
            WorktreeProjectIdentity.projectPath(for: tab, states: [state.repoPath: state]),
            "/repo"
        )
    }

    func testRefreshUsesOneProjectForSourceWorktreeAndBenchTabs() throws {
        let state = try state(repo: "/repo", worktree: "/repo/.ion/worktrees/a", bench: "/bench")
        let tabs = try [
            tab(id: "source", directory: "/repo"),
            tab(id: "worktree", directory: "/repo/.ion/worktrees/a"),
            tab(id: "bench", directory: "/bench")
        ]

        XCTAssertEqual(
            WorktreeProjectIdentity.refreshProjectPaths(tabs: tabs, states: [state.repoPath: state]),
            ["/repo"]
        )
    }

    func testDuplicateAliasStatesResolveWithoutDictionaryTrap() throws {
        let sourceState = try state(repo: "/repo", worktree: "/repo/.ion/worktrees/a", bench: "/bench")
        let aliasState = try state(repo: "/repo/.ion/worktrees/a", worktree: "/repo/.ion/worktrees/a", bench: "/bench")
        let tab = try tab(id: "work", directory: "/repo/.ion/worktrees/a/packages/app")

        XCTAssertEqual(
            WorktreeProjectIdentity.projectPath(for: tab, states: [
                sourceState.repoPath: sourceState,
                aliasState.repoPath: aliasState
            ]),
            "/repo"
        )
    }

    private func tab(
        id: String,
        directory: String,
        worktree: (path: String, repo: String)? = nil
    ) throws -> RemoteTabState {
        let worktreeJSON = worktree.map {
            ",\"worktree\":{\"worktreePath\":\"\($0.path)\",\"branchName\":\"wt/a\",\"sourceBranch\":\"main\",\"repoPath\":\"\($0.repo)\"}"
        } ?? ""
        let json = """
        {"id":"\(id)","title":"Test","status":"idle","workingDirectory":"\(directory)",
        "permissionMode":"auto","permissionQueue":[]\(worktreeJSON)}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteTabState.self, from: json)
    }

    private func state(repo: String, worktree: String, bench: String) throws -> RemoteWorktreeState {
        let json = """
        {"repoPath":"\(repo)","worktrees":[{"worktreePath":"\(worktree)","branchName":"wt/a",
        "label":"a","head":"abc","lastCommitSubject":"","isDirty":false,"unlandedCommitCount":0,
        "needsSync":false,"safeToDiscard":true}],"benches":[{"repoPath":"\(repo)","sourceBranch":"main",
        "benchPath":"\(bench)","benchBranch":"ion/bench/main","baseSha":"abc","lastBuiltAt":0,
        "baseDrifted":false}]}
        """.data(using: .utf8)!
        return try decoder.decode(RemoteWorktreeState.self, from: json)
    }
}
