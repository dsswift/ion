import XCTest
@testable import IonRemote

@MainActor
final class ProjectSnapshotTests: XCTestCase {
    func testSnapshotReplacesDesktopProjects() {
        let viewModel = SessionViewModel()
        let first = RemoteProject(
            directory: "/one",
            displayName: "One",
            isDefault: true,
            managed: false,
            profileAction: "plain",
            profileId: nil,
            profileSource: nil,
            hasOverride: false
        )
        let second = RemoteProject(
            directory: "/two",
            displayName: "Two",
            isDefault: false,
            managed: true,
            profileAction: "ask",
            profileId: nil,
            profileSource: "managed",
            hasOverride: true
        )

        viewModel.handleSnapshot(
            snapshotTabs: [],
            recentDirs: [],
            groupMode: nil,
            groups: nil,
            projects: [first, second]
        )
        XCTAssertEqual(viewModel.projects, [first, second])

        viewModel.handleSnapshot(
            snapshotTabs: [],
            recentDirs: [],
            groupMode: nil,
            groups: nil,
            projects: [second]
        )
        XCTAssertEqual(viewModel.projects, [second])
    }
}
