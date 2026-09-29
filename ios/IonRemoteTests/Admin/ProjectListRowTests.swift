import XCTest
@testable import IonRemote

/// What the Projects list shows, in which order, with which status.
final class ProjectListRowTests: XCTestCase {

    private func project(_ text: String) throws -> EnvironmentProject { try ProjectsFixtures.decode(text, as: EnvironmentProject.self) }
    private func job(_ text: String) throws -> EnvironmentJob { try ProjectsFixtures.decode(text, as: EnvironmentJob.self) }

    func testJobsWithoutAProjectComeFirstThenProjectsByName() throws {
        let app = try project(ProjectsFixtures.appProject)
        let tools = try project(ProjectsFixtures.clonedProject)
        let missing = try project(ProjectsFixtures.missingProject)
        let newClone = try job(ProjectsFixtures.job(id: "a"))
        let failedClone = try job(ProjectsFixtures.job(id: "b", dir: "/Users/dev/source/bad", phase: "failed", percent: nil, error: "denied"))
        let setupOnApp = try job(ProjectsFixtures.job(id: "c", kind: "setup", dir: app.dir, percent: nil, url: nil))
        let doneClone = try job(ProjectsFixtures.job(id: "d", dir: "/Users/dev/source/done", phase: "done"))

        let rows = ProjectListRow.build(projects: [tools, missing, app], jobs: [failedClone, newClone, setupOnApp, doneClone])

        XCTAssertEqual(rows.map(\.id), ["job:a", "job:b", app.dir, missing.dir, tools.dir])
        XCTAssertEqual(rows[2], .project(app, job: setupOnApp), "a running job on a project rides its row")
    }

    func testStatusNamesTheOneThingThatMatters() throws {
        let app = try project(ProjectsFixtures.appProject)
        XCTAssertEqual(ProjectRowStatus.of(app, job: nil), ProjectRowStatus(text: nil, tone: .muted, dot: .ok, dotLabel: "Ready"))
        let tools = try project(ProjectsFixtures.clonedProject)
        XCTAssertEqual(ProjectRowStatus.of(tools, job: nil).text, "Not trusted")
        XCTAssertEqual(ProjectRowStatus.of(tools, job: nil).dot, .warn)
        let missing = try project(ProjectsFixtures.missingProject)
        XCTAssertEqual(ProjectRowStatus.of(missing, job: nil).text, "Missing")
        XCTAssertEqual(ProjectRowStatus.of(missing, job: nil).dot, .error)
        let cloning = try job(ProjectsFixtures.job())
        XCTAssertEqual(ProjectRowStatus.of(cloning).text, "Cloning 45%")
        let failed = try job(ProjectsFixtures.job(phase: "failed", percent: nil))
        XCTAssertEqual(ProjectRowStatus.of(failed).text, "Clone failed")
    }

    func testSearchMatchesNamePathBranchAndJobURL() throws {
        let app = ProjectListRow.project(try project(ProjectsFixtures.appProject), job: nil)
        XCTAssertTrue(app.matches("APP"))
        XCTAssertTrue(app.matches("source/app"))
        XCTAssertTrue(app.matches("main"))
        XCTAssertFalse(app.matches("tools"))
        XCTAssertTrue(app.matches("  "))
        let clone = ProjectListRow.job(try job(ProjectsFixtures.job()))
        XCTAssertTrue(clone.matches("example/new"))
        XCTAssertEqual(clone.name, "new")
    }

    func testRepoNameComesFromTheURLsLastSegment() {
        XCTAssertEqual(ProjectListRow.repoName(fromURL: "git@github.com:org/repo.git"), "repo")
        XCTAssertEqual(ProjectListRow.repoName(fromURL: "https://host/org/repo/"), "repo")
        XCTAssertEqual(ProjectListRow.repoName(fromURL: "git@host:repo"), "repo")
        XCTAssertEqual(ProjectListRow.repoName(fromURL: ""), "")
    }

    func testTheCloneBaseFolderIsKeptPerServerWithADefault() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "ProjectListRowTests.\(UUID().uuidString)"))
        XCTAssertEqual(CloneBaseDirectory.read(serverId: "s1", defaults: defaults), "~/source")
        CloneBaseDirectory.write("~/work/", serverId: "s1", defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: "cloneBaseDirectory.s1"), "~/work")
        XCTAssertEqual(CloneBaseDirectory.read(serverId: "s1", defaults: defaults), "~/work")
        XCTAssertEqual(CloneBaseDirectory.read(serverId: "s2", defaults: defaults), "~/source")
        CloneBaseDirectory.write("  ", serverId: "s1", defaults: defaults)
        XCTAssertEqual(CloneBaseDirectory.read(serverId: "s1", defaults: defaults), "~/source")
    }
}
