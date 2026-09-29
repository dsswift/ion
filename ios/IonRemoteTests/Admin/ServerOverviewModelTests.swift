import XCTest
@testable import IonRemote

/// The Overview page: the server's facts, restart and update, and the
/// uninstall flow, against the server's real result shapes.
@MainActor
final class ServerOverviewModelTests: XCTestCase {

    /// `environment.server.info` from a bundle install, as `serverInfo()` in
    /// `server/src/environment/host-info.ts` builds it.
    static let infoJSON = """
    {"serverVersion":"0.9.1","engineVersion":"0.9.1","hostname":"studio-host","platform":"linux","arch":"x64",
     "home":"/home/ion","dataDir":"/home/ion/.ion","uptimeSeconds":7260.5,
     "bundle":{"root":"/home/ion/.ion/studio-server","version":{"server":"0.9.1","engine":"0.9.1","node":"22.11.0"}},
     "engineMinVersion":"0.9.0","engineMeetsMin":true,"hostApp":null,"runningConversations":2,
     "formats":[{"id":"transfer-archive","owner":"server","version":"2"}]}
    """

    static let appraisalJSON = """
    {"conversations":14,"dataBytes":52428800,
     "clonedProjects":[{"dir":"/home/ion/src/api","dirty":false,"bytes":1048576},{"dir":"/home/ion/src/web","dirty":true,"bytes":2097152}],
     "gitCredentialHosts":["github.com"],"bundle":{"root":"/home/ion/.ion/studio-server","version":"0.9.1"}}
    """

    private func value(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    private func client(_ caller: FakeActionCaller) -> ServerAdminClient {
        ServerAdminClient(serverLabel: "Studio", caller: caller)
    }

    func testLoadDecodesTheServerFacts() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentServerInfo, with: .success(try value(Self.infoJSON)))
        let model = ServerOverviewModel(client: client(caller))

        await model.load()

        XCTAssertEqual(model.info?.bundle?.version.node, "22.11.0")
        XCTAssertEqual(model.info?.runningConversations, 2)
        XCTAssertNil(model.info?.hostApp)
        XCTAssertTrue(model.isBundleInstall)
        XCTAssertNil(model.error)
        XCTAssertEqual(ServerFactsRows.uptime(7260.5), Duration.seconds(7260.5).formatted(.units(allowed: [.days, .hours, .minutes], width: .abbreviated, maximumUnitCount: 2)))
        XCTAssertEqual(ServerFactsRows.running(1), "1 conversation")
    }

    /// A server launched by a desktop answers null for the bundle and omits the newer fields.
    func testOlderServerWithoutBundleDecodes() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.environmentServerInfo, with: .success(try value("""
        {"serverVersion":"0.8.0","engineVersion":null,"hostname":"mac","platform":"darwin","arch":"arm64","home":"/Users/a","dataDir":"/Users/a/.ion","bundle":null,"uptimeSeconds":60}
        """)))
        let model = ServerOverviewModel(client: client(caller))

        await model.load()

        XCTAssertNotNil(model.info)
        XCTAssertFalse(model.isBundleInstall)
        XCTAssertEqual(ServerFactsRows.installedAs(model.info!), "Not a bundle install")
    }

    func testLoadFailureIsShownInPlainWords() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentServerInfo, with: .failure(StudioActionFailure.failed(code: "x", message: "engine is starting")))
        let model = ServerOverviewModel(client: client(caller))

        await model.load()

        XCTAssertNil(model.info)
        XCTAssertEqual(model.error, "engine is starting")
    }

    func testRestartSendsTheActionAndReportsIt() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentServerRestart, with: .success(.object(["scheduled": .bool(true)])))
        let model = ServerOverviewModel(client: client(caller))

        await model.restart()

        XCTAssertEqual(caller.calls.map(\.action), ["environment.server.restart"])
        XCTAssertEqual(model.lifecycleNotice, "Restart scheduled. Studio will drop and reconnect in a moment.")
        XCTAssertNil(model.lifecycleError)
    }

    /// Without admin the call never leaves the phone, and the reason is shown.
    func testUpdateWithoutAdminIsRefusedOnThePhone() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        let model = ServerOverviewModel(client: client(caller))

        await model.update()

        XCTAssertTrue(caller.calls.isEmpty)
        XCTAssertEqual(model.lifecycleError, "Needs admin access on Studio. Pair again with a link that grants it.")
    }

    func testPurgeAppraisesThenRunsTheChosenLevels() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentPurgeAppraise, with: .success(try value(Self.appraisalJSON)))
        caller.answer(.environmentPurgeRun, with: .success(try value("""
        {"removedClones":["/home/ion/src/api"],"keptDirtyClones":["/home/ion/src/web"],"removedGitCredentialHosts":[],"uninstallScheduled":true}
        """)))
        let model = ServerPurgeModel(client: client(caller))

        await model.appraise()
        XCTAssertEqual(model.appraisal?.dirtyClones.map(\.dir), ["/home/ion/src/web"])
        XCTAssertEqual(model.appraisal?.clonedBytes, 3_145_728)
        XCTAssertTrue(model.canRun)

        model.levels.clones = true
        await model.run()

        XCTAssertEqual(caller.calls.last, .init(action: "environment.purge.run", args: [.object([
            "gitCredentials": .bool(false), "clones": .bool(true), "data": .bool(false), "force": .bool(false),
        ])]))
        XCTAssertEqual(model.result?.uninstallScheduled, true)
        XCTAssertEqual(model.result?.keptDirtyClones, ["/home/ion/src/web"])
        XCTAssertFalse(model.canRun)
    }

    /// Force only means something while clones are being removed.
    func testForceIsSentOnlyWithClones() {
        var levels = EnvironmentPurgeLevels()
        levels.force = true
        XCTAssertEqual(levels.fields["force"], .bool(false))
        levels.clones = true
        XCTAssertEqual(levels.fields["force"], .bool(true))
    }

    func testPurgeIsNotOfferedWithoutABundle() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentPurgeAppraise, with: .success(try value("""
        {"conversations":0,"dataBytes":0,"clonedProjects":[],"gitCredentialHosts":[],"bundle":null}
        """)))
        let model = ServerPurgeModel(client: client(caller))

        await model.appraise()
        await model.run()

        XCTAssertFalse(model.canRun)
        XCTAssertEqual(caller.calls.map(\.action), ["environment.purge.appraise"])
    }
}
