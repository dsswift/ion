import XCTest
@testable import IonRemote

/// The Fleet screen: each paired server's `fleet.report`, as `buildReport` in
/// `server/src/fleet/actions.ts` answers it, added up across servers.
@MainActor
final class FleetModelTests: XCTestCase {

    private static func report(version: String, running: Int, accounts: String) -> String {
        """
        {"generatedAt":1790000000000,
         "server":{"serverVersion":"\(version)","engineVersion":"\(version)","hostname":"host","platform":"linux","arch":"x64",
                   "home":"/home/ion","dataDir":"/home/ion/.ion","bundle":null,"uptimeSeconds":60,"runningConversations":\(running)},
         "metrics":null,"devices":{"paired":1,"connected":0},
         "providers":[{"id":"anthropic","hasAuth":true,"backend":"claude-code","modelCount":3},{"id":"openai","hasAuth":false,"modelCount":0}],
         "defaultProvider":"anthropic","modelTiers":[],"accounts":\(accounts)}
        """
    }

    private static func account(signedIn: Bool, lastSeen: Int, sessionPercent: Double, fetchedAt: Int) -> String {
        """
        {"provider":"anthropic","backend":"claude-code","email":"User@example.com","orgId":"org-1","planType":"max",
         "firstSeen":1789000000000,"lastSeen":\(lastSeen),"signedIn":\(signedIn),
         "limits":[{"kind":"weekly","percent":20,"resetsAt":"2026-10-08T00:00:00Z","fetchedAt":\(fetchedAt)},
                   {"kind":"session","percent":\(sessionPercent),"fetchedAt":\(fetchedAt)},
                   {"kind":"weekly_model","label":"Fable","percent":55.4,"resetsAt":"2026-10-08T00:00:00.000Z","fetchedAt":\(fetchedAt)}]}
        """
    }

    private func source(_ id: String, _ caller: FakeActionCaller) -> FleetSource {
        FleetSource(id: id, label: id, client: ServerAdminClient(serverLabel: id, caller: caller))
    }

    private func value(_ json: String) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    }

    func testTheSameAccountOnTwoServersIsOneRowWithTheNewestLimits() async throws {
        let mac = FakeActionCaller(scopes: ["conversations:read"])
        mac.answer(.fleetReport, with: .success(try value(Self.report(
            version: "0.9.1", running: 2,
            accounts: "[\(Self.account(signedIn: true, lastSeen: 1790000000000, sessionPercent: 40, fetchedAt: 1790000000000))]"))))
        let linux = FakeActionCaller(scopes: ["conversations:read"])
        linux.answer(.fleetReport, with: .success(try value(Self.report(
            version: "0.9.0", running: 1,
            accounts: "[\(Self.account(signedIn: false, lastSeen: 1789500000000, sessionPercent: 90, fetchedAt: 1789500000000))]"))))
        let model = FleetModel()

        await model.load([source("linux", linux), source("mac", mac)])

        XCTAssertEqual(model.accounts.count, 1)
        let row = try XCTUnwrap(model.accounts.first)
        XCTAssertTrue(row.signedIn)
        XCTAssertEqual(row.machines.map(\.label), ["mac", "linux"])
        XCTAssertEqual(row.machines.map(\.signedIn), [true, false])
        XCTAssertEqual(row.limits.map(FleetSummary.title), ["7-day Fable", "5-hour", "7-day"])
        XCTAssertEqual(row.limits.first { $0.kind == "session" }?.percent, 40)
        XCTAssertEqual(model.totals.serversReached, 2)
        XCTAssertEqual(model.totals.runningConversations, 3)
        XCTAssertEqual(model.totals.accounts, 1)
        XCTAssertEqual(model.totals.accountsSignedIn, 1)
        // The tightest limit on the Mac's account is the 55.4% model limit.
        let macReport = try XCTUnwrap(model.servers.first { $0.id == "mac" }?.report)
        let beforeReset = try Date("2026-10-07T00:00:00Z", strategy: .iso8601)
        XCTAssertEqual(try XCTUnwrap(FleetSummary.roomPercent(macReport, now: beforeReset)), 44.6, accuracy: 0.01)
        XCTAssertEqual(mac.calls.map(\.action), ["fleet.report"])
    }

    func testAServerThatDoesNotAnswerKeepsItsLastReportAndSaysWhy() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.fleetReport, with: .success(try value(Self.report(version: "0.9.1", running: 4, accounts: "[]"))))
        let model = FleetModel()
        await model.load([source("mac", caller)])

        caller.answer(.fleetReport, with: .failure(StudioActionFailure.failed(code: "x", message: "mac did not answer")))
        await model.load([source("mac", caller)])

        XCTAssertEqual(model.servers.first?.report?.server.serverVersion, "0.9.1")
        XCTAssertEqual(model.servers.first?.error, "mac did not answer")
        XCTAssertEqual(model.totals.serversReached, 0)
        XCTAssertEqual(model.totals.runningConversations, 0)
    }

    func testPullToRefreshReadsTheCliUsageFirst() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.fleetReport, with: .success(try value(Self.report(version: "0.9.1", running: 0, accounts: "[]"))))
        let model = FleetModel()

        await model.load([source("mac", caller)], refreshUsage: true)

        XCTAssertEqual(caller.calls.map(\.action), ["fleet.refreshAccounts", "fleet.report"])
    }

    func testAccountEmailIsHiddenUntilRevealed() {
        func row(email: String, label: String?) -> FleetAccountRow {
            FleetAccountRow(key: "k", provider: "anthropic", email: email, orgName: nil, planType: nil, label: label, signedIn: true, lastSeen: 0, limits: [], machines: [])
        }
        XCTAssertEqual(row(email: "user@example.com", label: nil).title(revealEmail: false), FleetAccountRow.hiddenEmail)
        XCTAssertFalse(FleetAccountRow.hiddenEmail.contains("example"))
        XCTAssertEqual(row(email: "user@example.com", label: nil).title(revealEmail: true), "user@example.com")
        XCTAssertEqual(row(email: "", label: "Claude Max").title(revealEmail: false), "Claude Max")
    }

    func testWeeklyQuotaCloseToItsResetWithEnoughUnusedIsExpiring() throws {
        let reset = try Date("2026-10-08T00:00:00Z", strategy: .iso8601)
        func row(signedIn: Bool, percent: Double) -> FleetAccountRow {
            FleetAccountRow(key: "k", provider: "anthropic", email: "user@example.com", orgName: nil, planType: nil, label: nil, signedIn: signedIn, lastSeen: 0,
                            limits: [.init(kind: "weekly", label: nil, percent: percent, resetsAt: "2026-10-08T00:00:00Z", fetchedAt: 1)], machines: [])
        }
        let sixHoursBefore = reset.addingTimeInterval(-6 * 3600)

        let found = FleetSummary.expiring(row(signedIn: true, percent: 60), now: sixHoursBefore)
        XCTAssertEqual(found.map(\.unusedPercent), [40])
        XCTAssertTrue(FleetAccountRowView.expiringText(found[0], now: sixHoursBefore).hasPrefix("40% of the 7-day limit resets unused"))
        // Too far from the reset, too little left, or signed in nowhere: nothing to lose that can be spent.
        XCTAssertTrue(FleetSummary.expiring(row(signedIn: true, percent: 60), now: reset.addingTimeInterval(-30 * 3600)).isEmpty)
        XCTAssertTrue(FleetSummary.expiring(row(signedIn: true, percent: 90), now: sixHoursBefore).isEmpty)
        XCTAssertTrue(FleetSummary.expiring(row(signedIn: false, percent: 60), now: sixHoursBefore).isEmpty)
    }

    func testALimitReadBeforeItsResetIsExpiredAfterIt() {
        let limit = FleetAccount.Limit(kind: "weekly", label: nil, percent: 80, resetsAt: "2026-10-08T00:00:00Z", fetchedAt: 1790000000000)
        let reset = try! Date("2026-10-08T00:00:00Z", strategy: .iso8601)

        XCTAssertFalse(FleetSummary.expired(limit, now: reset.addingTimeInterval(-60)))
        XCTAssertTrue(FleetSummary.expired(limit, now: reset.addingTimeInterval(60)))
    }

    /// A server this phone does not chat on has no standing connection. Its
    /// row says what the Fleet read just learned, not "Not connected".
    func testAServerTheFleetJustReadIsReachableNotDisconnected() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.fleetReport, with: .success(try value(Self.report(version: "0.9.1", running: 0, accounts: "[]"))))
        let model = FleetModel()
        XCTAssertNil(FleetView.reached(model.servers.first))

        await model.load([source("other", caller)])
        XCTAssertEqual(FleetView.reached(model.servers.first), true)
        XCTAssertEqual(ServerListRow.status(isActive: false, connection: .disconnected, transport: .disconnected, lastSeen: nil, fleetReached: true), "Reachable")

        caller.answer(.fleetReport, with: .failure(StudioActionFailure.failed(code: "x", message: "no answer")))
        await model.load([source("other", caller)])
        XCTAssertEqual(FleetView.reached(model.servers.first), false)
        XCTAssertEqual(ServerListRow.status(isActive: false, connection: .disconnected, transport: .disconnected, lastSeen: nil, fleetReached: false), "Not reachable")
        // Outside the Fleet screen nothing has asked, so the row keeps its old words.
        XCTAssertEqual(ServerListRow.status(isActive: false, connection: .disconnected, transport: .disconnected, lastSeen: nil), "Not connected")
        // The server this phone chats on always shows its live connection.
        XCTAssertEqual(ServerListRow.status(isActive: true, connection: .connected, transport: .lanPreferred, lastSeen: nil, fleetReached: true), "Connected · Local network")
    }

    /// An account is switched on a server that can run the sign-in now: one
    /// the newest read reached, whether or not the account is signed in there.
    func testAnAccountCanBeSwitchedOnlyOnTheServersThatAnswered() async throws {
        let mac = FakeActionCaller(scopes: ["conversations:read"])
        mac.answer(.fleetReport, with: .success(try value(Self.report(
            version: "0.9.1", running: 0,
            accounts: "[\(Self.account(signedIn: true, lastSeen: 1790000000000, sessionPercent: 40, fetchedAt: 1790000000000))]"))))
        let linux = FakeActionCaller(scopes: ["conversations:read"])
        linux.answer(.fleetReport, with: .success(try value(Self.report(
            version: "0.9.1", running: 0,
            accounts: "[\(Self.account(signedIn: false, lastSeen: 1789500000000, sessionPercent: 90, fetchedAt: 1789500000000))]"))))
        let model = FleetModel()
        await model.load([source("linux", linux), source("mac", mac)])
        let both = try XCTUnwrap(model.accounts.first)
        XCTAssertEqual(FleetView.switchable(both, servers: model.servers).map(\.serverId), ["mac", "linux"])

        linux.answer(.fleetReport, with: .failure(StudioActionFailure.failed(code: "x", message: "no answer")))
        await model.load([source("linux", linux), source("mac", mac)])
        let row = try XCTUnwrap(model.accounts.first)
        XCTAssertEqual(row.machines.map(\.serverId), ["mac", "linux"])
        XCTAssertEqual(FleetView.switchable(row, servers: model.servers).map(\.serverId), ["mac"])
        XCTAssertEqual(FleetSwitchTarget(serverId: "mac", providerId: row.provider).id, "mac|anthropic")
    }

    func testAccountsAreOrderedByProviderNameThenEmailWithAMissingEmailLast() throws {
        func entry(_ provider: String, _ email: String, org: String, signedIn: Bool = true) -> String {
            #"{"provider":"\#(provider)","backend":"cli","email":"\#(email)","orgId":"\#(org)","firstSeen":1789000000000,"lastSeen":1790000000000,"signedIn":\#(signedIn),"limits":[]}"#
        }
        let accounts = [
            entry("xai", "", org: "x"), entry("anthropic", "Zed@example.com", org: "a1"), entry("openai", "b@example.com", org: "o"),
            entry("anthropic", "", org: "a2"), entry("anthropic", "gone@example.com", org: "a3", signedIn: false),
        ].joined(separator: ",")
        let report = try JSONDecoder().decode(FleetReport.self, from: Data(Self.report(version: "1.0.0", running: 0, accounts: "[\(accounts)]").utf8))
        let rows = FleetSummary.accounts([FleetServer(id: "mac", label: "mac", report: report)])
        XCTAssertEqual(rows.map { "\($0.provider)|\($0.email)" },
                       ["anthropic|gone@example.com", "anthropic|Zed@example.com", "anthropic|", "openai|b@example.com", "xai|"])
    }

    func testQuotaPoolsSumEachLimitOverAProvidersAccounts() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        func limit(_ kind: String, _ percent: Double, label: String? = nil, resetsIn: TimeInterval? = nil) -> FleetAccount.Limit {
            FleetAccount.Limit(kind: kind, label: label, percent: percent,
                               resetsAt: resetsIn.map { now.addingTimeInterval($0).ISO8601Format() }, fetchedAt: now.timeIntervalSince1970 * 1000)
        }
        func row(_ provider: String, _ email: String, signedIn: Bool = true, _ limits: [FleetAccount.Limit]) -> FleetAccountRow {
            FleetAccountRow(key: "\(provider)|\(email)", provider: provider, email: email, orgName: nil, planType: nil, label: nil,
                            signedIn: signedIn, lastSeen: 0, limits: limits, machines: [])
        }
        let pools = FleetSummary.quotaPools([
            row("xai", "", []),
            row("anthropic", "a@example.com", [limit("weekly", 100, resetsIn: 86_400), limit("spend", 50), limit("session", 30, resetsIn: -60)]),
            row("anthropic", "b@example.com", signedIn: false, [limit("weekly", 76, resetsIn: 3600), limit("weekly_model", 99, label: "Fable")]),
            row("openai", "c@example.com", [limit("weekly", 3)]),
        ], now: now)
        XCTAssertEqual(pools.map(\.provider), ["anthropic", "openai", "xai"])
        XCTAssertEqual(pools.map(\.accounts), [2, 1, 1])
        let anthropic = pools[0].limits
        XCTAssertEqual(anthropic.map { FleetSummary.title(kind: $0.kind, label: $0.label) }, ["7-day Fable", "5-hour", "7-day"])
        XCTAssertEqual(anthropic.map(\.capacity), [100, 100, 200])
        XCTAssertEqual(anthropic.map(\.used), [99, 30, 176])
        XCTAssertEqual(anthropic[2].resets, [FleetQuotaReset(at: now.addingTimeInterval(3600), freed: 76),
                                             FleetQuotaReset(at: now.addingTimeInterval(86_400), freed: 100)])
        XCTAssertTrue(anthropic[0].resets.isEmpty)
        XCTAssertTrue(anthropic[1].resets.isEmpty)
        XCTAssertEqual(FleetQuotaPoolView.detail(anthropic[2]), "176% of 200% used · 24% left")
        XCTAssertTrue(pools[2].limits.isEmpty)
    }

    func testOnlyAProviderWithACliIsOfferedWhenSwitchingOnAServer() throws {
        let catalog = try ModelsFixtures.json(ModelsFixtures.catalog).decoded(as: ServerModelCatalog.self)
        let offered = FleetSwitchAccountSheet.cliProviders(catalog.providers)
        XCTAssertFalse(offered.isEmpty)
        XCTAssertTrue(offered.allSatisfy { $0.cliKind != nil })
        XCTAssertEqual(offered.count, catalog.providers.filter { ["anthropic", "openai", "xai", "cursor"].contains($0.id) }.count)
    }

    func testOnlyACustomProviderIsListedInAServersCustomProviders() throws {
        let catalog = try ModelsFixtures.json(#"""
        {"models":[],"providers":[
          {"id":"anthropic","hasAuth":true,"authSource":"filestore","baseURL":"https://gateway.example.org"},
          {"id":"corp-gateway","hasAuth":true,"baseURL":"https://gw.example.org/v1","displayName":"Corp Gateway","custom":true}
        ]}
        """#).decoded(as: ServerModelCatalog.self)
        XCTAssertEqual(FleetCustomProvidersSheet.customProviders(catalog.providers).map(\.id), ["corp-gateway"])
        XCTAssertEqual(FleetCustomProvidersTarget(serverId: "mac").id, "mac")
    }

    func testAServersRowSaysWhichHubsItReportsTo() {
        let home = FleetReport.Hub(url: "https://a.example.org", label: "Home hub", state: "connected", manage: true)
        let corp = FleetReport.Hub(url: "https://b.example.org", label: "Corp hub", state: "unreachable", manage: false)
        XCTAssertEqual(FleetView.hubLine([home]), "reports to Home hub")
        XCTAssertEqual(FleetView.hubLine([corp]), "hub Corp hub: unreachable")
        XCTAssertEqual(FleetView.hubLine([home, corp]), "reports to 1 of 2 hubs")
        XCTAssertEqual(FleetView.hubLine([home, home]), "reports to 2 hubs")
        // A server on no hub, or too old to say, adds nothing to its row.
        XCTAssertNil(FleetView.hubLine([]))
        XCTAssertNil(FleetView.hubLine(nil))
    }

    func testAddingAHubSaysThePhoneLacksAdminBeforeATokenIsTyped() {
        let limited = ServerAdminAccess(serverLabel: "Build box", scopes: ["conversations:read", "conversations:operate"])
        XCTAssertFalse(limited.allows(.fleetHubsAdd))
        XCTAssertFalse(limited.allows(.fleetHubsRemove))
        XCTAssertTrue(limited.allows(.fleetHubsList))
        XCTAssertEqual(
            FleetHubsContent.addFooter(denial: limited.denialReason(.fleetHubsAdd)),
            "Needs admin access on Build box. Pair again with a link that grants it. The enrollment token is not what is missing."
        )

        let admin = ServerAdminAccess(serverLabel: "Build box", scopes: ["conversations:read", "admin"])
        XCTAssertTrue(admin.allows(.fleetHubsAdd))
        XCTAssertTrue(FleetHubsContent.addFooter(denial: admin.denialReason(.fleetHubsAdd)).hasPrefix("The token comes from the hub's own configuration."))
    }

    func testTheHubsOfAServerDecodeWithWhichCanBeRemoved() throws {
        let list = try value("""
        {"restricted":true,"hubs":[
          {"url":"https://hub.corp.example.org","label":"Corp hub","source":"policy","manage":true,"state":"connected","lastReportAt":5},
          {"url":"https://hub.home.example.org","label":"Home hub","source":"added","manage":false,"state":"blocked","detail":"your organization does not allow this hub"}]}
        """).decoded(as: FleetHubsList.self)
        XCTAssertTrue(list.restricted)
        XCTAssertEqual(list.hubs.map(\.removable), [false, true])
        XCTAssertEqual(list.hubs.map(\.stateWord), ["Reporting", "Not allowed"])
        XCTAssertEqual(list.hubs[1].detail, "your organization does not allow this hub")
    }
}
