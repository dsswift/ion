import XCTest
@testable import IonRemote

/// Branch defaults: read from the person's settings, and a removal saves the
/// map without that directory.
@MainActor
final class GitWorkflowAdminTests: XCTestCase {

    func testRemovingADefaultSavesTheRestOfTheMap() async {
        let caller = FakeActionCaller(scopes: nil)
        caller.answer(.settingsLoad, with: .success(.object([
            "gitOpsMode": .string("worktree"),
            "worktreeBranchDefaults": .object(["/Users/someone/src/app": .string("main"), "/srv/api": .string("develop")]),
        ])))
        caller.answer(.settingsSave, with: .success(.object(["ok": .bool(true)])))
        let model = BranchDefaultsModel(serverId: "s", client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller))
        XCTAssertNil(model.entries)
        await model.load()
        XCTAssertEqual(model.entries?.map(\.directory), ["/Users/someone/src/app", "/srv/api"])
        await model.remove(directory: "/srv/api")
        XCTAssertEqual(model.entries?.map(\.branch), ["main"])
        XCTAssertEqual(caller.calls.last, .init(action: "settings.save", args: [.object([
            "worktreeBranchDefaults": .object(["/Users/someone/src/app": .string("main")])
        ])]))
    }

    func testAnAbsentMapReadsEmpty() async {
        let caller = FakeActionCaller(scopes: nil)
        caller.answer(.settingsLoad, with: .success(.object([:])))
        let model = BranchDefaultsModel(serverId: "s", client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller))
        await model.load()
        XCTAssertEqual(model.entries, [])
    }

    func testHomePathsShorten() {
        XCTAssertEqual(BranchDefaultsModel.shortened("/Users/someone/src/app"), "~/src/app")
        XCTAssertEqual(BranchDefaultsModel.shortened("/srv/api"), "/srv/api")
    }
}
