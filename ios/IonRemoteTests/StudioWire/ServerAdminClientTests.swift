import XCTest
@testable import IonRemote

/// Typed calls to a server: arguments go out as given, results decode into
/// the caller's type, and an action the connection may not run is refused
/// before it is sent.
final class ServerAdminClientTests: XCTestCase {

    private struct Project: Decodable, Equatable {
        let path: String
        let trusted: Bool
    }

    func testAResultDecodesIntoTheRequestedType() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.environmentProjectsList, with: .success(.array([
            .object(["path": .string("/srv/app"), "trusted": .bool(true)])
        ])))
        let client = ServerAdminClient(serverLabel: "Studio Mac", caller: caller)

        let projects: [Project] = try await client.call(.environmentProjectsList)

        XCTAssertEqual(projects, [Project(path: "/srv/app", trusted: true)])
        XCTAssertEqual(caller.calls, [.init(action: "environment.projects.list", args: [])])
    }

    func testFieldsTravelAsOneObjectArgument() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        let client = ServerAdminClient(serverLabel: "Studio Mac", caller: caller)

        try await client.callVoid(.mcpRemove, fields: ["name": .string("github")])

        XCTAssertEqual(caller.calls, [.init(action: "mcp.remove", args: [.object(["name": .string("github")])])])
    }

    func testAnActionOutsideTheGrantedScopesIsRefusedWithoutBeingSent() async {
        let caller = FakeActionCaller(scopes: ["conversations:read", "conversations:operate"])
        let client = ServerAdminClient(serverLabel: "Studio Mac", caller: caller)

        do {
            try await client.callVoid(.environmentServerRestart)
            XCTFail("expected a refusal")
        } catch let failure as StudioActionFailure {
            XCTAssertEqual(failure, .refused(code: "forbidden", message: "Needs admin access on Studio Mac. Pair again with a link that grants it."))
        } catch {
            XCTFail("unexpected error \(error)")
        }
        XCTAssertEqual(caller.calls, [])
    }

    /// Before the welcome the scopes are unknown, so the server decides.
    func testUnknownScopesSendTheCall() async throws {
        let caller = FakeActionCaller(scopes: nil)
        let client = ServerAdminClient(serverLabel: "Studio Mac", caller: caller)

        try await client.callVoid(.environmentServerRestart)

        XCTAssertEqual(caller.calls.map(\.action), ["environment.server.restart"])
    }

    func testAServerFailurePassesThroughTyped() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.mcpLogin, with: .failure(StudioActionFailure.failed(code: "engine", message: "no such server")))
        let client = ServerAdminClient(serverLabel: "Studio Mac", caller: caller)

        do {
            try await client.callVoid(.mcpLogin, fields: ["name": .string("x")])
            XCTFail("expected a failure")
        } catch {
            XCTAssertEqual(error as? StudioActionFailure, .failed(code: "engine", message: "no such server"))
        }
    }

    func testAResultOfTheWrongShapeIsABadResult() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.environmentProjectsList, with: .success(.string("not a list")))
        let client = ServerAdminClient(serverLabel: "Studio Mac", caller: caller)

        do {
            let _: [Project] = try await client.call(.environmentProjectsList)
            XCTFail("expected a bad result")
        } catch let StudioActionFailure.failed(code, _) {
            XCTAssertEqual(code, "bad_result")
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
