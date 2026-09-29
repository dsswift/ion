import XCTest
@testable import IonRemote

/// `StudioTransport.call`: one action out, its value or a typed failure back;
/// the welcome's scopes kept; admin channel events handed to their sink.
final class StudioTransportCallTests: XCTestCase {

    func testCallReturnsTheActionsValue() async throws {
        let connection = FakeStudioConnection()
        connection.answer("environment.server.info", with: .success(.object(["version": .string("1.2.3")])))
        let transport = StudioTransport(deviceId: "device-1", connection: connection)

        let value = try await transport.call("environment.server.info", args: [.object(["verbose": .bool(true)])])

        XCTAssertEqual(value["version"]?.stringValue, "1.2.3")
        XCTAssertEqual(connection.submittedActions, [
            .init(action: "environment.server.info", args: [.object(["verbose": .bool(true)])], activeTabId: nil)
        ])
    }

    func testCallThrowsTheServersRefusalTyped() async {
        let connection = FakeStudioConnection()
        connection.answer("mcp.add", with: .failure(StudioActionFailure.refused(code: "forbidden", message: "needs admin")))
        let transport = StudioTransport(deviceId: "device-1", connection: connection)

        do {
            _ = try await transport.call("mcp.add")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error as? StudioActionFailure, .refused(code: "forbidden", message: "needs admin"))
        }
    }

    func testAnUntypedErrorBecomesAFailure() async {
        let connection = FakeStudioConnection()
        connection.answer("mcp.add", with: .failure(URLError(.notConnectedToInternet)))
        let transport = StudioTransport(deviceId: "device-1", connection: connection)

        do {
            _ = try await transport.call("mcp.add")
            XCTFail("expected a failure")
        } catch let StudioActionFailure.failed(code, _) {
            XCTAssertEqual(code, "unexpected")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testAStoppedTransportAbandonsTheCallWithoutSendingIt() async {
        let connection = FakeStudioConnection()
        let transport = StudioTransport(deviceId: "device-1", connection: connection)
        transport.stop()

        do {
            _ = try await transport.call("mcp.list")
            XCTFail("expected the call to be abandoned")
        } catch {
            XCTAssertEqual(error as? StudioActionFailure, .abandoned(action: "mcp.list"))
        }
        XCTAssertEqual(connection.submittedActions, [])
    }

    func testTheWelcomesScopesAreKept() async {
        let connection = FakeStudioConnection()
        let transport = StudioTransport(deviceId: "device-1", connection: connection)
        XCTAssertNil(transport.grantedScopes)
        await transport.start()

        var welcome = StudioWelcome.fixture()
        welcome.scopes = ["conversations:read", "admin"]
        connection.deliver(.welcome(welcome))

        await waitUntil("scopes stored") { transport.grantedScopes == ["conversations:read", "admin"] }
        transport.stop()
    }

    func testAdminChannelEventsReachTheSinkAndNotTheEventStream() async {
        let connection = FakeStudioConnection()
        let admin = Collected<StudioEvent>()
        let transport = StudioTransport(deviceId: "device-1", serverId: "server-1", connection: connection, onAdminEvent: { admin.append($0) })
        await transport.start()

        let payload: JSONValue = .object(["servers": .array([])])
        connection.deliver(.event(StudioEvent(channel: ServerAdminEvent.mcpServersChanged, payload: payload)))

        await waitUntil("admin event delivered") { admin.values.count == 1 }
        XCTAssertEqual(admin.values, [StudioEvent(channel: "ion:mcp-servers-changed", payload: payload)])
        XCTAssertEqual(transport.serverId, "server-1")
        transport.stop()
    }
}
