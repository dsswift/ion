import XCTest
@testable import IonRemote

/// The Projects page's results decode from the server's real shapes.
final class ProjectsModelDecodingTests: XCTestCase {

    func testAProjectDecodesWithItsCheckoutSetupAndTrust() throws {
        let app = try ProjectsFixtures.decode(ProjectsFixtures.appProject, as: EnvironmentProject.self)
        XCTAssertEqual(app.dir, "/Users/dev/source/app")
        XCTAssertEqual(app.displayName, "app")
        XCTAssertEqual(app.branch, "main")
        XCTAssertEqual(app.entry.repoRemote, "github.com/example/app")
        XCTAssertEqual(app.setup?.state, .ready)
        XCTAssertEqual(app.setupCommand, "make setup")
        XCTAssertEqual(app.usageCount, 12)
        XCTAssertTrue(app.isTrusted)
        XCTAssertFalse(app.clonedByIon)
        XCTAssertEqual(app.copySourceURL, "git@github.com:example/app.git")

        let tools = try ProjectsFixtures.decode(ProjectsFixtures.clonedProject, as: EnvironmentProject.self)
        XCTAssertFalse(tools.isTrusted)
        XCTAssertTrue(tools.clonedByIon)
        XCTAssertEqual(tools.copySourceURL, "https://github.com/example/tools.git")

        let missing = try ProjectsFixtures.decode(ProjectsFixtures.missingProject, as: EnvironmentProject.self)
        XCTAssertFalse(missing.exists)
        XCTAssertNil(missing.branch)
        XCTAssertNil(missing.setup)
    }

    func testAJobDecodesItsPhaseProgressAndURL() throws {
        let job = try ProjectsFixtures.decode(ProjectsFixtures.job(), as: EnvironmentJob.self)
        XCTAssertEqual(job.kind, .clone)
        XCTAssertEqual(job.phase, .running)
        XCTAssertEqual(job.percent, 45)
        XCTAssertEqual(job.url, "git@github.com:example/new.git")
        XCTAssertNil(job.endedAt)

        let failed = try ProjectsFixtures.decode(ProjectsFixtures.job(phase: "failed", percent: nil, error: "denied"), as: EnvironmentJob.self)
        XCTAssertEqual(failed.phase, .failed)
        XCTAssertEqual(failed.error, "denied")
        XCTAssertNotNil(failed.endedAt)
    }

    func testAFolderListingDecodesAndTheRootHasNoParent() throws {
        let listing = try ProjectsFixtures.decode(ProjectsFixtures.browse, as: EnvironmentFsBrowse.self)
        XCTAssertEqual(listing.path, "/Users/dev/source")
        XCTAssertEqual(listing.parentPath, "/Users/dev")
        XCTAssertEqual(listing.entries.map(\.name), ["app", "notes"])
        XCTAssertEqual(listing.entries.map(\.isGitRepo), [true, false])

        let root = try ProjectsFixtures.decode(ProjectsFixtures.rootBrowse, as: EnvironmentFsBrowse.self)
        XCTAssertNil(root.parentPath)
    }

    func testARemovalAppraisalWithUnsavedWorkIsRisky() throws {
        let appraisal = try ProjectsFixtures.decode(ProjectsFixtures.appraisal, as: ProjectRemovalAppraisal.self)
        XCTAssertTrue(appraisal.clonedByIon)
        XCTAssertEqual(appraisal.worktrees, 2)
        XCTAssertTrue(appraisal.isRisky)
    }

    func testACloneStartDecodes() throws {
        let started = try ProjectsFixtures.decode(#"{"jobId":"job-9","dir":"/Users/dev/source/new"}"#, as: ProjectCloneStarted.self)
        XCTAssertEqual(started, ProjectCloneStarted(jobId: "job-9", dir: "/Users/dev/source/new"))
    }
}
