import XCTest
@testable import IonRemote

/// Each Projects call sends the action and the arguments the server's
/// handler reads (`server/src/environment/actions.ts`).
final class ProjectsClientCallTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private func only(_ action: String, _ fields: [String: JSONValue]) -> [FakeActionCaller.Call] {
        [.init(action: action, args: [.object(fields)])]
    }

    func testCloneSendsURLAndParentAndANameOnlyWhenGiven() async throws {
        caller.answer(.environmentProjectsClone, with: .success(ProjectsFixtures.json(#"{"jobId":"j","dir":"/d"}"#)))
        _ = try await client.cloneProject(url: "git@github.com:example/app.git", parentDir: "~/source")
        _ = try await client.cloneProject(url: "u", parentDir: "~/src", name: "app")
        XCTAssertEqual(caller.calls, [
            .init(action: "environment.projects.clone", args: [.object(["url": .string("git@github.com:example/app.git"), "parentDir": .string("~/source")])]),
            .init(action: "environment.projects.clone", args: [.object(["url": .string("u"), "parentDir": .string("~/src"), "name": .string("app")])]),
        ])
    }

    func testRemoveSendsDeleteAndForceOnlyWhenAsked() async throws {
        try await client.removeProject(dir: "/a")
        try await client.removeProject(dir: "/b", deleteFiles: true, force: true)
        XCTAssertEqual(caller.calls, [
            .init(action: "environment.projects.remove", args: [.object(["dir": .string("/a")])]),
            .init(action: "environment.projects.remove", args: [.object(["dir": .string("/b"), "deleteFiles": .bool(true), "force": .bool(true)])]),
        ])
    }

    func testRelocateSendsFromAndTo() async throws {
        caller.answer(.environmentProjectsRelocate, with: .success(ProjectsFixtures.json(ProjectsFixtures.appProject)))
        _ = try await client.relocateProject(from: "/old/app", to: "/new/app")
        XCTAssertEqual(caller.calls, only("environment.projects.relocate", ["from": .string("/old/app"), "to": .string("/new/app")]))
    }

    func testBrowseSendsPathAndHiddenFlag() async throws {
        caller.answer(.environmentFsBrowse, with: .success(ProjectsFixtures.json(ProjectsFixtures.browse)))
        _ = try await client.browse(path: "~/source", showHidden: true)
        XCTAssertEqual(caller.calls, only("environment.fs.browse", ["path": .string("~/source"), "showHidden": .bool(true)]))
    }

    func testDirVerbsAndJobCancelSendTheirKeys() async throws {
        caller.answer(.environmentProjectsAdd, with: .success(ProjectsFixtures.json(ProjectsFixtures.appProject)))
        caller.answer(.environmentProjectsTrust, with: .success(ProjectsFixtures.json(ProjectsFixtures.appProject)))
        caller.answer(.environmentProjectsAppraiseRemoval, with: .success(ProjectsFixtures.json(ProjectsFixtures.appraisal)))
        _ = try await client.addProject(dir: "/x")
        _ = try await client.trustProject(dir: "/x")
        try await client.setupProject(dir: "/x")
        _ = try await client.appraiseRemoval(dir: "/x")
        try await client.cancelJob(id: "job-1")
        XCTAssertEqual(caller.calls, [
            .init(action: "environment.projects.add", args: [.object(["dir": .string("/x")])]),
            .init(action: "environment.projects.trust", args: [.object(["dir": .string("/x")])]),
            .init(action: "environment.projects.setup", args: [.object(["dir": .string("/x")])]),
            .init(action: "environment.projects.appraiseRemoval", args: [.object(["dir": .string("/x")])]),
            .init(action: "environment.jobs.cancel", args: [.object(["jobId": .string("job-1")])]),
        ])
    }

    func testListsTakeNoArguments() async throws {
        caller.answer(.environmentProjectsList, with: .success(.array([])))
        caller.answer(.environmentJobsList, with: .success(.array([])))
        _ = try await client.listProjects()
        _ = try await client.listJobs()
        XCTAssertEqual(caller.calls, [.init(action: "environment.projects.list", args: []), .init(action: "environment.jobs.list", args: [])])
    }
}
