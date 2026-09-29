import XCTest
@testable import IonRemote

/// The MCP section: its result decoding, the exact arguments each call sends
/// (`server/src/protocol/auth-flow-actions.ts`), the Add validation, and the
/// screen model's sign-in paths.
@MainActor
final class McpAdminTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private func listAnswer() -> JSONValue {
        .object(["ok": .bool(true), "servers": IntegrationsFixtures.json(IntegrationsFixtures.mcpServers)])
    }

    func testListDecodesBothTransportsAndKeepsStateApart() async throws {
        caller.answer(.mcpList, with: .success(listAnswer()))
        let servers = try await client.listMcpServers()
        XCTAssertEqual(servers.map(\.name), ["linear", "files"])
        XCTAssertEqual(servers[0].toolCount, 23)
        XCTAssertEqual(McpServerText.endpoint(servers[0]), "https://mcp.linear.app/mcp")
        XCTAssertEqual(McpServerText.endpoint(servers[1]), "npx")
        XCTAssertEqual(McpServerText.toolCount(servers[0]), "23 tools")
        XCTAssertNil(McpServerText.toolCount(servers[1]))
        XCTAssertEqual(McpServerText.connection(servers[1]), "Not connected: last attempt failed")
    }

    func testANotOkAnswerThrowsTheServersReason() async {
        caller.answer(.mcpAdd, with: .success(.object(["ok": .bool(false), "error": .string("enterprise policy blocks this server")])))
        do {
            try await client.addMcpServer(name: "x", url: "https://x.example.org")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "enterprise policy blocks this server")
        }
    }

    func testEachCallSendsTheArgumentsTheHandlerReads() async throws {
        for action in [PhoneAction.mcpAdd, .mcpRemove, .mcpLogout, .authCompleteSignIn] {
            caller.answer(action, with: .success(.object(["ok": .bool(true)])))
        }
        caller.answer(.mcpLogin, with: .success(.object(["ok": .bool(true), "authorizationUrl": .string("https://auth.example.org/a"), "flowId": .string("f1")])))
        try await client.addMcpServer(name: "linear", url: "https://mcp.linear.app/mcp")
        try await client.addMcpServer(name: "files", command: "npx", args: ["-y", "@scope/server"])
        try await client.removeMcpServer(name: "linear")
        try await client.signOutMcpServer(name: "linear")
        let start = try await client.beginMcpSignIn(name: "linear", redirectUri: WebSignIn.redirectURI)
        try await client.completeSignIn(flowId: "f1", callbackUrl: "ion-studio://oauth/callback?code=c&state=s")
        XCTAssertEqual(start, McpSignInStart(authorizationUrl: "https://auth.example.org/a", flowId: "f1"))
        XCTAssertEqual(caller.calls, [
            .init(action: "mcp.add", args: [.object(["name": .string("linear"), "url": .string("https://mcp.linear.app/mcp")])]),
            .init(action: "mcp.add", args: [.object(["name": .string("files"), "command": .string("npx"), "args": .array([.string("-y"), .string("@scope/server")])])]),
            .init(action: "mcp.remove", args: [.string("linear")]),
            .init(action: "mcp.logout", args: [.string("linear")]),
            .init(action: "mcp.login", args: [.string("linear"), .null, .object(["redirectUri": .string("ion-studio://oauth/callback")])]),
            .init(action: "auth.completeSignIn", args: [.object(["flowId": .string("f1"), "callbackUrl": .string("ion-studio://oauth/callback?code=c&state=s")])]),
        ])
    }

    func testAddValidationMatchesTheServersRules() {
        let cases: [(McpAddRequest.Kind, String, String, String?)] = [
            (.remote, " ", "https://x", "Enter a name for the server."),
            (.remote, "my server", "https://x", "The name cannot contain spaces."),
            (.remote, "a__b", "https://x", "The name cannot contain \"__\" (it separates server and tool names)."),
            (.remote, "a", "", "Enter the server URL."),
            (.local, "a", " ", "Enter the command to run."),
            (.remote, "a", "ftp://x", "The URL must start with http:// or https://"),
            (.remote, "a", "HTTPS://x.example.org/mcp", nil),
        ]
        for (kind, name, endpoint, expected) in cases {
            switch McpAddRequest.validate(kind: kind, name: name, endpoint: endpoint) {
            case .failure(let invalid): XCTAssertEqual(invalid.message, expected, "\(name) \(endpoint)")
            case .success: XCTAssertNil(expected, "\(name) \(endpoint)")
            }
        }
        XCTAssertEqual(
            try McpAddRequest.validate(kind: .local, name: " files ", endpoint: "npx  -y @scope/server").get(),
            McpAddRequest(name: "files", url: nil, command: "npx", args: ["-y", "@scope/server"])
        )
    }

    func testTheModelLoadsThenASnapshotReplacesTheList() async {
        caller.answer(.mcpList, with: .success(listAnswer()))
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        XCTAssertNil(model.servers)
        await model.load()
        XCTAssertEqual(model.servers?.count, 2)
        model.apply(IntegrationsFixtures.json(#"[{"name":"only","connected":true,"authenticated":false}]"#))
        XCTAssertEqual(model.servers?.map(\.name), ["only"])
        model.apply(.string("not a list"))
        XCTAssertEqual(model.servers?.map(\.name), ["only"], "an unreadable snapshot leaves the list alone")
    }

    func testTheModelFollowsTheServersChannel() async {
        caller.answer(.mcpList, with: .success(listAnswer()))
        let events = ServerAdminEvents()
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client, events: events)
        let task = Task { await model.follow() }
        defer { task.cancel() }
        await waitUntil("listed") { await MainActor.run { model.servers?.count == 2 } }
        events.publish(ServerAdminEvent(serverId: "s", channel: ServerAdminEvent.mcpServersChanged, payload: .array([])))
        await waitUntil("snapshot applied") { await MainActor.run { model.servers?.isEmpty == true } }
    }

    func testSignInOnThePhoneHandsTheLandingAddressBack() async {
        answerSignIn()
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client) { _ in
            URL(string: "ion-studio://oauth/callback?code=c")!
        }
        await model.authorize("linear")
        XCTAssertNil(model.pendingPaste)
        XCTAssertNil(model.operationError)
        XCTAssertTrue(caller.calls.contains(.init(action: "auth.completeSignIn", args: [.object([
            "flowId": .string("f1"), "callbackUrl": .string("ion-studio://oauth/callback?code=c")
        ])])))
    }

    func testAProviderThatRefusesTheAppAsksForTheAddress() async {
        answerSignIn()
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client) { _ in
            throw WebSignIn.Failure.failed("invalid redirect_uri")
        }
        await model.authorize("linear")
        let paste = model.pendingPaste
        XCTAssertEqual(paste?.flowId, "f1")
        XCTAssertFalse(caller.calls.contains { $0.action == "auth.completeSignIn" })
        guard let paste else { return }
        let emptyDone = await model.completePaste(paste, address: "  ")
        XCTAssertFalse(emptyDone)
        let done = await model.completePaste(paste, address: " http://localhost/callback?code=c ")
        XCTAssertTrue(done)
        XCTAssertNil(model.pendingPaste)
        XCTAssertEqual(caller.calls.filter { $0.action == "auth.completeSignIn" }, [.init(action: "auth.completeSignIn", args: [.object([
            "flowId": .string("f1"), "callbackUrl": .string("http://localhost/callback?code=c")
        ])])], "the blank address never reaches the server")
    }

    func testClosingTheSheetEndsTheSignInQuietly() async {
        answerSignIn()
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client) { _ in throw WebSignIn.Failure.cancelled }
        await model.authorize("linear")
        XCTAssertNil(model.pendingPaste)
        XCTAssertNil(model.operationError)
    }

    func testWithoutAdminTheAddIsRefusedBeforeItIsSent() async {
        let reader = FakeActionCaller(scopes: ["conversations:read"])
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: ServerAdminClient(serverLabel: "Studio Mac", caller: reader))
        let added = await model.add(McpAddRequest(name: "a", url: "https://a.example.org", command: nil, args: []))
        XCTAssertFalse(added)
        XCTAssertNotNil(model.operationError)
        XCTAssertEqual(reader.calls, [])
    }

    func testAddCarriesOnlyTheOAuthFieldsThePersonSet() async throws {
        var draft = McpOAuthDraft()
        draft.enabled = true
        draft.clientId = " client-1 "
        let request = try McpAddRequest.validate(kind: .remote, name: "exchange", endpoint: "https://api.example.org/mcp", oauth: draft).get()
        XCTAssertEqual(request.oauth, McpOAuthSettings(clientId: "client-1"))
        caller.answer(.mcpAdd, with: .success(.object(["ok": .bool(true)])))
        try await client.addMcpServer(name: request.name, url: request.url, oauth: request.oauth)
        XCTAssertEqual(caller.calls, [.init(action: "mcp.add", args: [.object([
            "name": .string("exchange"), "url": .string("https://api.example.org/mcp"),
            "oauth": .object(["clientId": .string("client-1")]),
        ])])])
    }

    func testOAuthValidationMatchesTheEnginesRules() {
        var draft = McpOAuthDraft()
        draft.enabled = true
        draft.tokenUrl = "https://login.example.org/token"
        XCTAssertEqual(draft.problem(), "Enter the client ID. An authorization URL, token URL, or secret belongs to a client.")
        draft.clientId = "c"
        draft.authUrl = "login.example.org/authorize"
        XCTAssertEqual(draft.problem(), "The authorization URL must start with http:// or https://")
        draft.enabled = false
        XCTAssertNil(draft.problem(), "a client that is switched off is not checked")
        XCTAssertNil(McpOAuthDraft().settings(editing: false), "an add with the client off sends none")
    }

    func testEditKeepsTheStoredSecretUnlessRemovedAndClearsWhenSwitchedOff() throws {
        let server = McpServerStatus(
            name: "exchange", transport: "http", url: "https://api.example.org/mcp", command: nil,
            oauth: McpOAuthStatus(clientId: "client-1", authUrl: nil, tokenUrl: nil, scope: "s1", resource: nil, hasClientSecret: true),
            connected: false, authenticated: true, toolCount: nil, lastError: nil
        )
        var draft = McpOAuthDraft(status: server.oauth)
        draft.clientId = "client-2"
        XCTAssertEqual(
            try McpUpdateRequest.validate(server: server, endpoint: "https://api.example.org/mcp", oauth: draft).get(),
            McpUpdateRequest(name: "exchange", oauth: McpOAuthSettings(clientId: "client-2", scope: "s1"))
        )
        draft.secretRemoved = true
        XCTAssertEqual(try McpUpdateRequest.validate(server: server, endpoint: "https://api.example.org/mcp", oauth: draft).get().oauth?.clientSecret, "")
        draft.enabled = false
        XCTAssertEqual(
            try McpUpdateRequest.validate(server: server, endpoint: "https://api.example.org/mcp", oauth: draft).get().oauth,
            McpOAuthSettings(clientSecret: "")
        )
    }

    func testEditOfALocalServerSendsOnlyTheChangedArguments() throws {
        let server = McpServerStatus(name: "files", transport: "stdio", url: nil, command: "npx", args: ["-y", "srv"], connected: false, authenticated: false, toolCount: nil, lastError: nil)
        XCTAssertEqual(
            try McpUpdateRequest.validate(server: server, endpoint: "npx -y srv --verbose", oauth: McpOAuthDraft()).get(),
            McpUpdateRequest(name: "files", args: ["-y", "srv", "--verbose"])
        )
    }

    func testUpdateSendsTheRequestAndTellsThePersonWhenTheSignInWasDropped() async {
        caller.answer(.mcpList, with: .success(listAnswer()))
        caller.answer(.mcpUpdate, with: .success(.object(["ok": .bool(true), "changed": .bool(true), "credentialsCleared": .bool(true)])))
        let model = McpAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        let saved = await model.update(McpUpdateRequest(name: "linear", oauth: McpOAuthSettings(clientId: "client-2")))
        XCTAssertTrue(saved)
        XCTAssertEqual(model.notice, "linear was updated. Its old sign-in no longer applies, so sign in again.")
        XCTAssertTrue(caller.calls.contains(.init(action: "mcp.update", args: [.object([
            "name": .string("linear"), "oauth": .object(["clientId": .string("client-2")]),
        ])])))
    }

    func testTheSnapshotDecodesTheOAuthClientAndArguments() throws {
        let servers = try IntegrationsFixtures.json(#"[{"name":"x","transport":"stdio","command":"npx","args":["-y"],"connected":false,"authenticated":false},{"name":"y","url":"https://y.example.org","oauth":{"clientId":"c","hasClientSecret":true},"connected":false,"authenticated":false}]"#).decoded(as: [McpServerStatus].self)
        XCTAssertEqual(servers[0].args, ["-y"])
        XCTAssertEqual(servers[1].oauth?.clientId, "c")
        XCTAssertEqual(servers[1].oauth?.hasClientSecret, true)
    }

    private func answerSignIn() {
        caller.answer(.mcpList, with: .success(listAnswer()))
        caller.answer(.mcpLogin, with: .success(.object(["ok": .bool(true), "authorizationUrl": .string("https://auth.example.org/a"), "flowId": .string("f1")])))
        caller.answer(.authCompleteSignIn, with: .success(.object(["ok": .bool(true)])))
    }
}
