import XCTest
@testable import IonRemote

/// The Projects screen model: loading, live updates from the admin
/// channels, verbs, and failures.
@MainActor
final class ProjectsAdminModelTests: XCTestCase {

    private let serverId = "server-projects"
    private let caller = FakeActionCaller(scopes: nil)
    private let events = ServerAdminEvents()

    private func makeModel() -> ProjectsAdminModel {
        ProjectsAdminModel(serverId: serverId, serverLabel: "Studio Mac", client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), events: events)
    }

    private func answerLists(projects: JSONValue, jobs: JSONValue = .array([])) {
        caller.answer(.environmentProjectsList, with: .success(projects))
        caller.answer(.environmentJobsList, with: .success(jobs))
    }

    func testLoadFillsProjectsAndJobsAndIsDistinctFromEmpty() async {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.appProject), jobs: ProjectsFixtures.json("[\(ProjectsFixtures.job())]"))
        let model = makeModel()
        XCTAssertNil(model.projects, "nothing is shown as empty before the server answers")

        await model.load()

        XCTAssertEqual(model.projects?.map(\.displayName), ["app"])
        XCTAssertEqual(model.jobs.map(\.id), ["job-1"])
        XCTAssertNil(model.loadError)
        XCTAssertFalse(model.loading)
    }

    func testALoadFailureIsShownInPlainWords() async {
        caller.answer(.environmentProjectsList, with: .failure(StudioActionFailure.refused(code: "forbidden", message: "Studio Mac did not grant this phone that.")))
        let model = makeModel()

        await model.load()

        XCTAssertNil(model.projects)
        XCTAssertEqual(model.loadError, "Studio Mac did not grant this phone that.")
    }

    func testFollowAppliesJobProgressAndRelistsWhenTheRegistryChanges() async {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.appProject))
        let model = makeModel()
        let following = Task { await model.follow() }
        defer { following.cancel() }
        await waitUntil("first listing") { await MainActor.run { model.projects != nil } }

        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.projectJob, payload: ProjectsFixtures.json(ProjectsFixtures.job(percent: 60))))
        await waitUntil("job applied") { await MainActor.run { model.jobs.first?.percent == 60 } }
        XCTAssertEqual(model.rows.first?.id, "job:job-1")

        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.appProject, ProjectsFixtures.clonedProject))
        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.projectsChanged, payload: .object(["reason": .string("add")])))
        await waitUntil("relisted") { await MainActor.run { model.projects?.count == 2 } }
    }

    func testAFinishedJobRelistsProjectsAndAnotherServersEventsAreIgnored() async {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.appProject))
        let model = makeModel()
        await model.load()
        let listingsBefore = caller.calls.filter { $0.action == "environment.projects.list" }.count

        await model.apply(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.projectJob, payload: ProjectsFixtures.json(ProjectsFixtures.job(phase: "done"))))

        XCTAssertEqual(caller.calls.filter { $0.action == "environment.projects.list" }.count, listingsBefore + 1)
        XCTAssertEqual(model.jobs.first?.phase, .done)

        let following = Task { await model.follow() }
        defer { following.cancel() }
        await waitUntil("following") { await MainActor.run { !model.loading } }
        events.publish(ServerAdminEvent(serverId: "other-server", channel: ServerAdminEvent.projectJob, payload: ProjectsFixtures.json(ProjectsFixtures.job(id: "elsewhere"))))
        for _ in 0..<50 { await Task.yield() }
        XCTAssertFalse(model.jobs.contains { $0.id == "elsewhere" })
    }

    func testRemoveForcesTheDeleteOnlyWhenTheAppraisalFoundUnsavedWork() async throws {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.clonedProject))
        let model = makeModel()
        await model.load()
        let tools = try XCTUnwrap(model.projects?.first)
        let risky = try ProjectsFixtures.decode(ProjectsFixtures.appraisal, as: ProjectRemovalAppraisal.self)

        let removed = await model.remove(tools, appraisal: risky, deleteFiles: true)

        XCTAssertTrue(removed)
        let remove = caller.calls.first { $0.action == "environment.projects.remove" }
        XCTAssertEqual(remove?.args, [.object(["dir": .string(tools.dir), "deleteFiles": .bool(true), "force": .bool(true)])])
        XCTAssertFalse(model.isBusy(tools.dir))
    }

    func testAFailedVerbNamesItsProjectAndClearsBusy() async throws {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.clonedProject))
        caller.answer(.environmentProjectsSetup, with: .failure(StudioActionFailure.refused(code: "project_untrusted", message: "Trust the project first.")))
        let model = makeModel()
        await model.load()
        let tools = try XCTUnwrap(model.projects?.first)

        await model.runSetup(tools)

        XCTAssertEqual(model.operationError, .init(dir: tools.dir, message: "Trust the project first."))
        XCTAssertFalse(model.isBusy(tools.dir))
    }

    func testRelocateMovesIntoTheParentKeepingTheFolderName() async throws {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.appProject))
        caller.answer(.environmentProjectsRelocate, with: .success(ProjectsFixtures.json(ProjectsFixtures.appProject)))
        let model = makeModel()
        await model.load()
        let app = try XCTUnwrap(model.projects?.first)

        let moved = await model.relocate(app, intoParent: "/Volumes/work/")

        XCTAssertNotNil(moved)
        let relocate = caller.calls.first { $0.action == "environment.projects.relocate" }
        XCTAssertEqual(relocate?.args, [.object(["from": .string(app.dir), "to": .string("/Volumes/work/app")])])
    }

    func testFetchFromOriginKeepsARefusalAsTheProjectsError() async throws {
        answerLists(projects: ProjectsFixtures.projects(ProjectsFixtures.appProject))
        caller.answer(.environmentGitTest, with: .success(ProjectsFixtures.json(#"{"url":"git@github.com:example/app.git","ok":false,"error":"Permission denied","durationMs":80}"#)))
        let model = makeModel()
        await model.load()
        let app = try XCTUnwrap(model.projects?.first)

        await model.fetchOrigin(app)

        XCTAssertEqual(model.originTests[app.dir]?.ok, false)
        XCTAssertEqual(model.operationError?.message, "Permission denied")
    }
}
