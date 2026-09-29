import Foundation
import Observation

/// The MCP servers one server's engine is configured with, and the verbs the
/// MCP screens run on them.
///
/// `follow()` loads the list, then replaces it with every
/// `ion:mcp-servers-changed` snapshot, which the server sends after any MCP
/// change from any client.
@MainActor
@Observable
final class McpAdminModel {

    /// A sign-in the provider would not return to the app for: the person
    /// finishes it by pasting the address the browser landed on.
    struct PendingPaste: Equatable, Identifiable {
        let name: String
        let flowId: String
        let authorizationUrl: URL
        var id: String { flowId }
    }

    let serverId: String
    let serverLabel: String
    /// Nil until the first list lands.
    private(set) var servers: [McpServerStatus]?
    private(set) var loadError: String?
    /// The server a verb is running on.
    private(set) var busyName: String?
    private(set) var adding = false
    /// Why the last verb failed, in plain words.
    var operationError: String?
    /// The outcome of the last edit worth telling the person about.
    var notice: String?
    var pendingPaste: PendingPaste?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let events: ServerAdminEvents
    /// Opens the provider page and returns where it landed. Replaced in tests.
    @ObservationIgnored private let signIn: @MainActor (URL) async throws -> URL

    init(
        serverId: String,
        serverLabel: String,
        client: ServerAdminClient,
        events: ServerAdminEvents = .shared,
        signIn: @escaping @MainActor (URL) async throws -> URL = { try await WebSignIn.run($0) }
    ) {
        self.serverId = serverId
        self.serverLabel = serverLabel
        self.client = client
        self.events = events
        self.signIn = signIn
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, serverLabel: session.serverLabel, client: session.client)
    }

    func server(named name: String) -> McpServerStatus? { servers?.first { $0.name == name } }

    // MARK: - Loading

    func follow() async {
        let stream = events.events(for: serverId)
        await load()
        for await event in stream where event.channel == ServerAdminEvent.mcpServersChanged {
            apply(event.payload)
        }
    }

    func load() async {
        do {
            let listed = try await client.listMcpServers()
            servers = listed
            loadError = nil
            DiagnosticLog.log("mcp: listed", tag: "admin.mcp", level: .debug, fields: ["server_id": serverId, "count": String(listed.count)])
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
            DiagnosticLog.log("mcp: listing failed", tag: "admin.mcp", level: .warn, fields: ["server_id": serverId, "error": error.localizedDescription])
        }
    }

    /// A snapshot replaces the list, never merges, and clears a stale load error.
    func apply(_ payload: JSONValue) {
        do {
            let snapshot = try payload.decoded(as: [McpServerStatus].self)
            servers = snapshot
            loadError = nil
            DiagnosticLog.log("mcp: snapshot applied", tag: "admin.mcp", level: .debug, fields: ["server_id": serverId, "count": String(snapshot.count)])
        } catch {
            DiagnosticLog.log("mcp: snapshot did not decode", tag: "admin.mcp", level: .warn, fields: [
                "server_id": serverId, "error": String(String(describing: error).prefix(300))
            ])
        }
    }

    // MARK: - Verbs

    /// Adds a server; true when it was added.
    func add(_ request: McpAddRequest) async -> Bool {
        adding = true
        operationError = nil
        defer { adding = false }
        do {
            try await client.addMcpServer(name: request.name, url: request.url, command: request.command, args: request.args, oauth: request.oauth)
            DiagnosticLog.log("mcp: server added", tag: "admin.mcp", fields: [
                "server_id": serverId, "name": request.name, "kind": request.url == nil ? "local" : "remote",
                "oauth_configured": String(request.oauth != nil)
            ])
            await load()
            return true
        } catch {
            fail("add", name: request.name, error)
            return false
        }
    }

    /// Saves an edit; true when it was saved. When the URL or OAuth client
    /// changed, the old sign-in no longer applies and `notice` says so.
    func update(_ request: McpUpdateRequest) async -> Bool {
        busyName = request.name
        operationError = nil
        notice = nil
        defer { busyName = nil }
        do {
            let outcome = try await client.updateMcpServer(request)
            DiagnosticLog.log("mcp: server updated", tag: "admin.mcp", fields: [
                "server_id": serverId, "name": request.name,
                "changed": String(outcome.changed == true), "credentials_cleared": String(outcome.credentialsCleared == true)
            ])
            if outcome.credentialsCleared == true {
                notice = "\(request.name) was updated. Its old sign-in no longer applies, so sign in again."
            }
            await load()
            return true
        } catch {
            fail("update", name: request.name, error)
            return false
        }
    }

    func remove(_ name: String) async -> Bool {
        await run("removed", name: name) { try await $0.removeMcpServer(name: name) }
    }

    func signOut(_ name: String) async {
        _ = await run("signed out", name: name) { try await $0.signOutMcpServer(name: name) }
    }

    /// Signs in to `name` from this phone: the provider page opens in a sheet,
    /// returns to the app, and the landing address goes back to the server.
    /// When the provider will not return to the app, `pendingPaste` asks the
    /// person for the address instead.
    func authorize(_ name: String) async {
        busyName = name
        operationError = nil
        defer { busyName = nil }
        let start: McpSignInStart
        do {
            start = try await client.beginMcpSignIn(name: name, redirectUri: WebSignIn.redirectURI)
        } catch {
            fail("sign-in start", name: name, error)
            return
        }
        guard let url = URL(string: start.authorizationUrl), let flowId = start.flowId else {
            operationError = "\(serverLabel) did not return a sign-in page this phone can open for \(name)."
            DiagnosticLog.log("mcp: sign-in start unusable", tag: "admin.mcp", level: .error, fields: [
                "server_id": serverId, "name": name, "has_flow": String(start.flowId != nil)
            ])
            return
        }
        DiagnosticLog.log("mcp: sign-in opened", tag: "admin.mcp", fields: ["server_id": serverId, "name": name, "host": url.host ?? ""])
        let callback: URL
        do {
            callback = try await signIn(url)
        } catch WebSignIn.Failure.cancelled {
            DiagnosticLog.log("mcp: sign-in cancelled", tag: "admin.mcp", fields: ["server_id": serverId, "name": name])
            return
        } catch {
            // The provider refused the app's return address, or the sheet
            // failed: the person finishes by pasting where the browser landed.
            DiagnosticLog.log("mcp: sign-in did not return, asking for the address", tag: "admin.mcp", level: .warn, fields: [
                "server_id": serverId, "name": name, "error": String(describing: error)
            ])
            pendingPaste = PendingPaste(name: name, flowId: flowId, authorizationUrl: url)
            return
        }
        await complete(name: name, flowId: flowId, callbackUrl: callback.absoluteString)
    }

    /// Finishes a sign-in with the address the person pasted.
    func completePaste(_ paste: PendingPaste, address: String) async -> Bool {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            operationError = "Paste the address of the last page the sign-in reached."
            return false
        }
        busyName = paste.name
        defer { busyName = nil }
        let done = await complete(name: paste.name, flowId: paste.flowId, callbackUrl: trimmed)
        if done { pendingPaste = nil }
        return done
    }

    @discardableResult
    private func complete(name: String, flowId: String, callbackUrl: String) async -> Bool {
        do {
            try await client.completeSignIn(flowId: flowId, callbackUrl: callbackUrl)
            DiagnosticLog.log("mcp: signed in", tag: "admin.mcp", fields: ["server_id": serverId, "name": name, "flow_id": flowId])
            await load()
            return true
        } catch {
            fail("sign-in finish", name: name, error)
            return false
        }
    }

    private func run(_ outcome: String, name: String, _ body: (ServerAdminClient) async throws -> Void) async -> Bool {
        busyName = name
        operationError = nil
        defer { busyName = nil }
        do {
            try await body(client)
            DiagnosticLog.log("mcp: server operation done", tag: "admin.mcp", fields: ["server_id": serverId, "name": name, "operation": outcome])
            await load()
            return true
        } catch {
            fail(outcome, name: name, error)
            return false
        }
    }

    private func fail(_ verb: String, name: String, _ error: Error) {
        operationError = error.localizedDescription
        DiagnosticLog.log("mcp: verb failed", tag: "admin.mcp", level: .warn, fields: [
            "server_id": serverId, "name": name, "verb": verb, "error": error.localizedDescription
        ])
    }
}
