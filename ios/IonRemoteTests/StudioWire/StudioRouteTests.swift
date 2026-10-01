import XCTest
import CryptoKit
@testable import IonRemote

/// Route choice: direct when the address answers, a stored relay when it does
/// not, and back to direct when it answers again.
final class StudioRouteTests: XCTestCase {

    private let secret = SymmetricKey(data: Data((1...32).map { UInt8($0) }))
    private let serverURL = URL(string: "http://192.168.1.20:7331")!
    private let relay = StudioEnvironmentRelay(url: "wss://relay.example.org", auth: .psk(key: "psk-1"))
    /// The nonce and proof of the sealed fixture, which uses the same key.
    private let nonce = "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA="
    private let nonceProof = "COEFcEZDU8sCbWLOMsbWS2g4DwxVSNqJkMS2oSUEWc0="
    private let relayProof = "o+5CEgQ7oLaKsPSHtBMgGWfg9dv+plvVCjsUahtuk3I="

    /// A probe whose answer the test flips, plus a record of what was dialed.
    private final class World: @unchecked Sendable {
        private let lock = NSLock()
        private var answer: StudioRoute.AuthConfig?
        /// Per-address answers. When any are set, an address not listed is silent.
        private var answers: [URL: StudioRoute.AuthConfig] = [:]
        private var probes = 0
        private var bearers: [String] = []
        private var relayJoins: [URL] = []
        private var tcpDials: [(url: URL, clientId: String)] = []

        func setAnswer(_ next: StudioRoute.AuthConfig?) { lock.withLock { answer = next } }
        func setAnswer(_ next: StudioRoute.AuthConfig, for url: URL) { lock.withLock { answers[url] = next } }
        var probeCount: Int { lock.withLock { probes } }
        var relayJoinList: [URL] { lock.withLock { relayJoins } }
        var tcpDialList: [(url: URL, clientId: String)] { lock.withLock { tcpDials } }

        func dependencies(reprobeSeconds: Double = 60, oidcToken: (@Sendable (StudioEnvironmentRelay) async throws -> String)? = nil) -> StudioRoute.Dependencies {
            var deps = StudioRoute.Dependencies()
            deps.probe = { [self] url in
                lock.withLock {
                    probes += 1
                    return answers.isEmpty ? answer : answers[url]
                }
            }
            deps.makeTCPSocket = { [self] url, clientId, _ in
                lock.withLock { tcpDials.append((url, clientId)) }
                return FakeStudioSocket(routeKind: .tcp)
            }
            deps.makeRelaySocket = { [self] url, _, _ in
                lock.withLock { relayJoins.append(url) }
                return FakeStudioSocket(routeKind: .relay)
            }
            deps.oidcToken = oidcToken
            deps.reprobeIntervalSeconds = reprobeSeconds
            return deps
        }
    }

    private func config(sealed: Bool = true) -> StudioRoute.AuthConfig {
        StudioRoute.AuthConfig(nonce: nonce, environmentId: "env-1", label: "Host", sealedTcp: sealed)
    }

    func testAnAnsweringAddressDialsTCPWithAProofOverItsNonce() async throws {
        let world = World()
        world.setAnswer(config())
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [relay], dependencies: world.dependencies())
        let plan = try await route.dialPlan()
        XCTAssertEqual(plan.socket.routeKind, .tcp)
        XCTAssertEqual(plan.credential, .paired(clientId: "client-1", proof: nonceProof))
        XCTAssertEqual(world.tcpDialList.map(\.clientId), ["client-1"])
        XCTAssertTrue(world.relayJoinList.isEmpty)
        let last = await route.lastResolution
        XCTAssertEqual(last, .tcp(config()))
    }

    /// Field failure: a phone whose server answered with a nonce it could not
    /// read dialled the same address ten times in a row, backing off to eight
    /// seconds, and never once tried the relay it had stored. It sat offline
    /// on a network where the server was up and reachable.
    func testAnAddressThatAnswersButCannotBeDialledFallsBackToTheRelay() async throws {
        let world = World()
        world.setAnswer(StudioRoute.AuthConfig(nonce: "!!not base64!!", environmentId: "env-1", label: "Host", sealedTcp: true))
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [relay], dependencies: world.dependencies())

        let plan = try await route.dialPlan()

        XCTAssertEqual(plan.socket.routeKind, .relay, "an undialable direct route must degrade to the relay, not fail")
        XCTAssertEqual(world.relayJoinList.count, 1)
        XCTAssertTrue(world.tcpDialList.isEmpty, "the direct socket must not be built from a plan that could not be completed")
    }

    /// With no relay there is nothing to degrade to, so the direct route's own
    /// failure is what the caller must see.
    func testAnUndialableAddressWithNoRelayStillFails() async {
        let world = World()
        world.setAnswer(StudioRoute.AuthConfig(nonce: "!!not base64!!", environmentId: "env-1", label: "Host", sealedTcp: true))
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [], dependencies: world.dependencies())

        do {
            _ = try await route.dialPlan()
            XCTFail("expected the direct route's failure")
        } catch {
            XCTAssertTrue(error is StudioRouteError)
        }
    }

    func testASilentAddressFallsBackToTheStoredRelay() async throws {
        let world = World()
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [relay], dependencies: world.dependencies())
        let plan = try await route.dialPlan()
        XCTAssertEqual(plan.socket.routeKind, .relay)
        XCTAssertEqual(plan.credential, .paired(clientId: "client-1", proof: relayProof))
        XCTAssertEqual(world.relayJoinList.map(\.absoluteString), ["wss://relay.example.org"])
        XCTAssertTrue(world.tcpDialList.isEmpty)
        await route.stop()
    }

    func testASilentAddressWithNoRelayIsAnError() async {
        let world = World()
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [], dependencies: world.dependencies())
        do {
            _ = try await route.dialPlan()
            XCTFail("resolved a route with nothing reachable")
        } catch {
            XCTAssertEqual(error as? StudioRouteError, .unreachable(host: "192.168.1.20"))
        }
    }

    func testAServerThatDoesNotOpenSealedFramesIsNotDialedDirectly() async throws {
        let world = World()
        world.setAnswer(config(sealed: false))
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [relay], dependencies: world.dependencies())
        let resolution = try await route.resolve()
        XCTAssertEqual(resolution, .relay(relay))
        await route.stop()
    }

    func testARouteWithNoAddressGoesStraightToTheRelayWithoutProbing() async throws {
        let world = World()
        world.setAnswer(StudioRoute.AuthConfig(nonce: nonce, environmentId: "env-1", label: nil, sealedTcp: true))
        let route = StudioRoute(serverURL: nil, clientId: "client-1", secret: secret, relays: [relay], dependencies: world.dependencies())

        let plan = try await route.dialPlan()
        XCTAssertEqual(plan.socket.routeKind, .relay)
        XCTAssertEqual(world.probeCount, 0)

        await route.setServerURL(serverURL)
        let direct = try await route.dialPlan()
        XCTAssertEqual(direct.socket.routeKind, .tcp)
        XCTAssertEqual(world.tcpDialList.first?.url, serverURL)
        await route.stop()
    }

    func testARouteWithNoAddressAndNoRelayIsUnreachable() async {
        let route = StudioRoute(serverURL: nil, clientId: "client-1", secret: secret, relays: [], dependencies: World().dependencies())
        do {
            _ = try await route.dialPlan()
            XCTFail("dialed with nowhere to go")
        } catch {
            XCTAssertEqual(error as? StudioRouteError, .unreachable(host: "unknown"))
        }
    }

    func testAnOIDCRelayNeedsATokenSource() async throws {
        let oidcRelay = StudioEnvironmentRelay(url: "wss://relay.example.org", auth: .relayOIDC(issuer: nil, clientId: nil))
        let world = World()
        let without = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [oidcRelay], dependencies: world.dependencies())
        do {
            _ = try await without.dialPlan()
            XCTFail("dialed an OIDC relay with no identity")
        } catch {
            XCTAssertEqual(error as? StudioRouteError, .relayNeedsIdentity(relayURL: "wss://relay.example.org"))
        }
        await without.stop()

        let with = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [oidcRelay],
                               dependencies: world.dependencies(oidcToken: { _ in "token-1" }))
        let plan = try await with.dialPlan()
        XCTAssertEqual(plan.socket.routeKind, .relay)
        await with.stop()
    }

    func testWhileOnARelayTheAddressIsProbedAgainAndItsAnswerAsksForARedial() async throws {
        let world = World()
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [relay],
                                dependencies: world.dependencies(reprobeSeconds: 0.03))
        let redials = Collected<Int>()
        await route.setOnDirectRouteReturned { redials.append(1) }

        let first = try await route.resolve()
        XCTAssertEqual(first.kind, .relay)
        await waitUntil("the address is probed again on the timer") { world.probeCount >= 3 }
        XCTAssertTrue(redials.values.isEmpty, "a silent address must not ask for a redial")

        world.setAnswer(config())
        await waitUntil("the answer asks the owner to redial") { redials.values.count == 1 }
        let second = try await route.resolve()
        XCTAssertEqual(second.kind, .tcp)

        // On the direct route the timer is off: no more probes, no more redials.
        let settled = world.probeCount
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(world.probeCount, settled)
        XCTAssertEqual(redials.values.count, 1)
    }

    func testTheDialClosureDrivesAConnectionFromRelayBackToTCP() async throws {
        let world = World()
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [relay],
                                dependencies: world.dependencies(reprobeSeconds: 0.03))
        let connection = StudioConnection(clientId: "client-1", dial: route.dial)
        await route.setOnDirectRouteReturned { await connection.restart() }
        await connection.start()
        await waitUntil("joined the relay") { world.relayJoinList.count == 1 }
        world.setAnswer(config())
        await waitUntil("moved to tcp") { world.tcpDialList.count == 1 }
        await connection.stop()
        await route.stop()
    }

    func testRelaysFromAWelcomeReplaceTheStoredList() async throws {
        let world = World()
        let route = StudioRoute(serverURL: serverURL, clientId: "client-1", secret: secret, relays: [], dependencies: world.dependencies())
        let changed = await route.updateRelays([relay])
        let unchanged = await route.updateRelays([relay])
        XCTAssertTrue(changed)
        XCTAssertFalse(unchanged)
        let resolution = try await route.resolve()
        XCTAssertEqual(resolution, .relay(relay))
        await route.stop()
    }

    func testAuthConfigParsing() {
        let body = #"{"oidc":null,"transports":["local","paired","bearer"],"environmentId":"env-9","label":"Studio","protocolVersion":1,"serverVersion":"0.1.0","nonce":"bm9uY2U=","sealedTcp":true}"#
        XCTAssertEqual(
            StudioRoute.parseAuthConfig(Data(body.utf8)),
            StudioRoute.AuthConfig(nonce: "bm9uY2U=", environmentId: "env-9", label: "Studio", sealedTcp: true)
        )
        XCTAssertNil(StudioRoute.parseAuthConfig(Data(#"{"oidc":null}"#.utf8)), "a body with no nonce is not a Studio server")
        XCTAssertNil(StudioRoute.parseAuthConfig(Data("<html>".utf8)))
        XCTAssertEqual(StudioRoute.parseAuthConfig(Data(#"{"nonce":"bm9uY2U="}"#.utf8))?.sealedTcp, false)
        let signedIn = #"{"nonce":"bm9uY2U=","oidc":{"issuer":"https://issuer.example.org","audience":"api-app","scope":"Studio.Access","clientId":"web-app"}}"#
        XCTAssertEqual(
            StudioRoute.parseAuthConfig(Data(signedIn.utf8))?.oidc,
            StudioServerSignIn(issuer: "https://issuer.example.org", audience: "api-app", scope: "Studio.Access", clientId: "web-app")
        )
        XCTAssertNil(StudioRoute.parseAuthConfig(Data(#"{"nonce":"bm9uY2U=","oidc":{"issuer":"https://issuer.example.org"}}"#.utf8))?.oidc, "a sign-in missing its audience is not usable")
    }

    // MARK: - A server that moved to another network

    private let homeURL = URL(string: "http://192.168.1.211:7331")!
    private let nameURL = URL(string: "http://macbook.local:7331")!

    private final class Adopted: @unchecked Sendable {
        private let lock = NSLock()
        private var urls: [URL] = []
        func add(_ url: URL) { lock.withLock { urls.append(url) } }
        var list: [URL] { lock.withLock { urls } }
    }

    /// A laptop carried from home to the office: its stored home address is
    /// silent, and its last welcome reported its `.local` name. The phone
    /// dials the name directly instead of needing the relay, and keeps it.
    func testASilentStoredAddressFallsToAReportedAddressThatAnswersAsThisServer() async throws {
        let world = World()
        world.setAnswer(config(), for: nameURL)
        let adopted = Adopted()
        let route = StudioRoute(
            serverURL: homeURL, clientId: "client-1", secret: secret, relays: [relay],
            directAddresses: [homeURL, nameURL], environmentId: "env-1", dependencies: world.dependencies()
        )
        await route.setOnServerURLAdopted { adopted.add($0) }

        let plan = try await route.dialPlan()

        XCTAssertEqual(plan.socket.routeKind, .tcp)
        XCTAssertEqual(world.tcpDialList.map(\.url), [nameURL])
        XCTAssertTrue(world.relayJoinList.isEmpty)
        XCTAssertEqual(adopted.list, [nameURL])
        await route.stop()
    }

    /// An address someone else's server now answers on is not this server.
    func testAReportedAddressThatAnswersAsAnotherServerIsSkipped() async throws {
        let world = World()
        world.setAnswer(StudioRoute.AuthConfig(nonce: nonce, environmentId: "someone-else", label: "Other", sealedTcp: true), for: nameURL)
        let route = StudioRoute(
            serverURL: homeURL, clientId: "client-1", secret: secret, relays: [relay],
            directAddresses: [nameURL], environmentId: "env-1", dependencies: world.dependencies()
        )
        let plan = try await route.dialPlan()
        XCTAssertEqual(plan.socket.routeKind, .relay)
        XCTAssertTrue(world.tcpDialList.isEmpty)
        await route.stop()
    }

    /// Addresses learned from a welcome are used by the next dial.
    func testAddressesFromAWelcomeAreProbedOnTheNextDial() async throws {
        let world = World()
        world.setAnswer(config(), for: nameURL)
        let route = StudioRoute(serverURL: homeURL, clientId: "client-1", secret: secret, relays: [relay], dependencies: world.dependencies())
        await route.setEnvironmentId("env-1")
        let changed = await route.updateDirectAddresses([nameURL])
        let unchanged = await route.updateDirectAddresses([nameURL])
        XCTAssertTrue(changed)
        XCTAssertFalse(unchanged)
        let resolution = try await route.resolve()
        XCTAssertEqual(resolution, .tcp(config()))
        await route.stop()
    }

    /// A record stored before the field existed still decodes.
    func testARecordWithoutDirectAddressesStillDecodes() throws {
        let json = #"{"clientId":"c1","secret":"AAECAw==","label":"Mac","relays":[]}"#
        let record = try JSONDecoder().decode(StudioServerRecord.self, from: Data(json.utf8))
        XCTAssertNil(record.directAddresses)
    }
}
