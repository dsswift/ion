import XCTest
@testable import IonRemote

/// Which transport serves a server's settings pages, and how long a
/// dedicated one stays open.
@MainActor
final class ServerAdminSessionTests: XCTestCase {

    /// Builds transports on demand and remembers each one's connection.
    private final class Builder {
        var connections: [FakeStudioConnection] = []
        var transports: [StudioTransport] = []
        var available = true

        func build() -> StudioTransport? {
            guard available else { return nil }
            let connection = FakeStudioConnection()
            let transport = StudioTransport(deviceId: "device-1", serverId: "server-1", connection: connection)
            connections.append(connection)
            transports.append(transport)
            return transport
        }
    }

    private func session(live: StudioTransport? = nil, builder: Builder, idle: Duration = .milliseconds(50)) -> ServerAdminSession {
        ServerAdminSession(
            serverId: "server-1", serverLabel: "Studio Mac", idleCloseAfter: idle,
            live: { live }, build: { builder.build() }
        )
    }

    func testTheLiveTransportServesItsOwnServerAndNothingIsDialed() async throws {
        let liveConnection = FakeStudioConnection()
        let live = StudioTransport(deviceId: "device-1", serverId: "server-1", connection: liveConnection)
        let builder = Builder()
        let session = session(live: live, builder: builder)

        session.open()
        try await session.client.callVoid(.environmentProjectsList)

        XCTAssertTrue(session.transport === live)
        XCTAssertEqual(builder.transports.count, 0)
        XCTAssertEqual(liveConnection.submittedActions.map(\.action), ["environment.projects.list"])
        session.close()
    }

    func testAnotherServerGetsADedicatedTransportThatCallsGoThrough() async throws {
        let builder = Builder()
        let session = session(builder: builder)

        session.open()
        await waitUntil("dedicated transport started") { builder.connections.first?.startCount == 1 }
        try await session.client.callVoid(.environmentServerInfo)

        XCTAssertEqual(builder.transports.count, 1)
        XCTAssertTrue(session.transport === builder.transports.first)
        XCTAssertEqual(builder.connections.first?.submittedActions.map(\.action), ["environment.server.info"])
        session.close()
    }

    func testTheDedicatedTransportClosesOnlyAfterTheLastPageLeavesAndTheIdleTimePasses() async throws {
        let builder = Builder()
        let session = session(builder: builder)

        session.open()
        session.open()
        XCTAssertEqual(builder.transports.count, 1, "a second page shares the transport")
        session.close()
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertNotNil(session.dedicated, "one page still holds the session")

        session.close()
        await waitUntil("dedicated transport stopped") { builder.connections.first?.stopCount == 1 }
        XCTAssertNil(session.dedicated)
    }

    func testReopeningBeforeTheIdleTimeKeepsTheTransport() async throws {
        let builder = Builder()
        let session = session(builder: builder, idle: .milliseconds(100))

        session.open()
        session.close()
        session.open()
        try await Task.sleep(for: .milliseconds(200))

        XCTAssertNotNil(session.dedicated)
        XCTAssertEqual(builder.transports.count, 1)
        XCTAssertEqual(builder.connections.first?.stopCount, 0)
        session.close()
    }

    func testACallWithNoPageOpenStillConnectsAndThenIdlesOut() async throws {
        let builder = Builder()
        let session = session(builder: builder)

        try await session.client.callVoid(.environmentServerInfo)

        XCTAssertEqual(builder.transports.count, 1)
        await waitUntil("dedicated transport stopped") { builder.connections.first?.stopCount == 1 }
    }

    func testAServerWithNoStoredCredentialRefusesTheCall() async {
        let builder = Builder()
        builder.available = false
        let session = session(builder: builder)

        do {
            try await session.client.callVoid(.environmentServerInfo)
            XCTFail("expected a refusal")
        } catch let StudioActionFailure.refused(code, _) {
            XCTAssertEqual(code, "unpaired")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testScopesComeFromTheServingTransportsWelcome() async {
        let builder = Builder()
        let session = session(builder: builder)
        session.open()
        XCTAssertNil(session.scopes)
        XCTAssertFalse(session.allows(.mcpAdd))

        var welcome = StudioWelcome.fixture()
        welcome.scopes = ["admin"]
        builder.connections.first?.deliver(.welcome(welcome))

        await waitUntil("scopes arrive") { session.scopes == ["admin"] }
        XCTAssertTrue(session.allows(.mcpAdd))
        XCTAssertNil(session.denialReason(.mcpAdd))
        session.close()
    }
}
