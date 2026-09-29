import XCTest
@testable import IonRemote

/// Add project: folder, Git URL, and Copy from another server.
@MainActor
final class AddProjectModelTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)

    private func makeModel(baseDir: String = "~/source/") -> AddProjectModel {
        AddProjectModel(serverId: "server-1", serverLabel: "Studio Mac", client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), baseDir: baseDir)
    }

    private func source(_ id: String, _ projects: JSONValue) -> PairedServerSource {
        let other = FakeActionCaller(scopes: nil)
        other.answer(.environmentProjectsList, with: .success(projects))
        return PairedServerSource(serverId: id, label: "Server \(id)", client: ServerAdminClient(serverLabel: "Server \(id)", caller: other))
    }

    func testTheURLPreviewAndCloneUseTheBaseFolder() async {
        let model = makeModel()
        XCTAssertEqual(model.clonePreview, "~/source/<name>")
        XCTAssertFalse(model.canClone)
        model.url = " git@github.com:example/app.git "
        XCTAssertEqual(model.clonePreview, "~/source/app")
        caller.answer(.environmentProjectsClone, with: .success(ProjectsFixtures.json(#"{"jobId":"j","dir":"/d"}"#)))

        let done = await model.cloneURL()

        XCTAssertTrue(done)
        XCTAssertEqual(caller.calls, [.init(action: "environment.projects.clone", args: [.object([
            "url": .string("git@github.com:example/app.git"), "parentDir": .string("~/source")
        ])])])
    }

    func testAFolderAddFailureStaysOpenWithTheReason() async {
        caller.answer(.environmentProjectsAdd, with: .failure(StudioActionFailure.failed(code: "add_failed", message: "/nope is not a directory on this host")))
        let model = makeModel()

        let done = await model.addFolder("/nope")

        XCTAssertFalse(done)
        XCTAssertEqual(model.error, "/nope is not a directory on this host")
        XCTAssertFalse(model.busy)
    }

    func testCopyOffersEachRemoteThisServerLacksOnceAndClonesTheTickedOnes() async throws {
        let here = try ProjectsFixtures.decode(ProjectsFixtures.appProject, as: EnvironmentProject.self)
        let first = source("a", ProjectsFixtures.projects(ProjectsFixtures.appProject, ProjectsFixtures.clonedProject, ProjectsFixtures.missingProject))
        let second = source("b", ProjectsFixtures.projects(ProjectsFixtures.clonedProject))
        let model = makeModel()

        await model.loadCandidates(from: [first, second], existing: [here])

        XCTAssertEqual(model.candidates?.map(\.remote), ["github.com/example/tools"], "app is already here; tools is offered once; a project with no remote is not")
        XCTAssertEqual(model.candidates?.first?.sourceLabel, "Server a")
        XCTAssertEqual(model.ticked, ["github.com/example/tools"])

        caller.answer(.environmentProjectsClone, with: .success(ProjectsFixtures.json(#"{"jobId":"j","dir":"/d"}"#)))
        let done = await model.cloneTicked()

        XCTAssertTrue(done)
        XCTAssertEqual(caller.calls, [.init(action: "environment.projects.clone", args: [.object([
            "url": .string("https://github.com/example/tools.git"), "parentDir": .string("~/source"), "name": .string("tools")
        ])])])
    }

    func testAnUnreachableServerIsNamedAndTheOthersStillCount() async {
        let broken = FakeActionCaller(scopes: nil)
        broken.answer(.environmentProjectsList, with: .failure(StudioActionFailure.connectionLost(action: "environment.projects.list")))
        let down = PairedServerSource(serverId: "down", label: "Laptop", client: ServerAdminClient(serverLabel: "Laptop", caller: broken))
        let model = makeModel()

        await model.loadCandidates(from: [down, source("a", ProjectsFixtures.projects(ProjectsFixtures.clonedProject))], existing: [])

        XCTAssertEqual(model.candidates?.count, 1)
        XCTAssertEqual(model.sourceFailures.count, 1)
        XCTAssertTrue(model.sourceFailures[0].hasPrefix("Laptop: "))
    }
}
