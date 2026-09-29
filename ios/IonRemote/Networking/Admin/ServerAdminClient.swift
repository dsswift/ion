import Foundation

/// Typed `studio_action` calls to one paired server, for the settings pages
/// that administer it. Each settings area adds its calls in its own
/// `ServerAdminClient+<Area>.swift` extension.
///
/// Every call is checked against the connection's scopes first: an action the
/// welcome did not grant is refused here with a sentence that says why,
/// rather than sent to bounce off the server. Before the first welcome the
/// scopes are unknown and the server decides.
struct ServerAdminClient: Sendable {

    let serverLabel: String
    /// The connection to call on, found at call time: which transport serves a
    /// server can change while a page is open.
    private let resolve: @Sendable () async throws -> any StudioActionCalling

    init(serverLabel: String, resolve: @escaping @Sendable () async throws -> any StudioActionCalling) {
        self.serverLabel = serverLabel
        self.resolve = resolve
    }

    init(serverLabel: String, caller: any StudioActionCalling) {
        self.init(serverLabel: serverLabel, resolve: { caller })
    }

    // MARK: - Calls

    /// Runs `action` and decodes its value as `T`.
    func call<T: Decodable>(_ action: PhoneAction, args: [JSONValue] = [], timeoutSeconds: Double? = nil, as type: T.Type = T.self) async throws -> T {
        let value = try await callValue(action, args: args, timeoutSeconds: timeoutSeconds)
        do {
            return try value.decoded(as: type)
        } catch {
            DiagnosticLog.log("admin client: result did not decode", tag: "admin.client", level: .error, fields: [
                "server": serverLabel, "action": action.rawValue, "type": String(describing: type),
                "error": String(String(describing: error).prefix(500))
            ])
            throw StudioActionFailure.failed(code: "bad_result", message: "\(serverLabel) answered \(action.rawValue) with a result this app cannot read.")
        }
    }

    /// Runs `action` with one object argument and decodes its value as `T`.
    func call<T: Decodable>(_ action: PhoneAction, fields: [String: JSONValue], timeoutSeconds: Double? = nil, as type: T.Type = T.self) async throws -> T {
        try await call(action, args: [.object(fields)], timeoutSeconds: timeoutSeconds, as: type)
    }

    /// Runs `action` for its effect; whatever value it returns is not read.
    func callVoid(_ action: PhoneAction, args: [JSONValue] = [], timeoutSeconds: Double? = nil) async throws {
        _ = try await callValue(action, args: args, timeoutSeconds: timeoutSeconds)
    }

    /// Runs `action` with one object argument, for its effect.
    func callVoid(_ action: PhoneAction, fields: [String: JSONValue], timeoutSeconds: Double? = nil) async throws {
        try await callVoid(action, args: [.object(fields)], timeoutSeconds: timeoutSeconds)
    }

    /// Runs `action` and returns its value uninterpreted.
    func callValue(_ action: PhoneAction, args: [JSONValue] = [], timeoutSeconds: Double? = nil) async throws -> JSONValue {
        let caller = try await resolve()
        let access = ServerAdminAccess(serverLabel: serverLabel, scopes: caller.grantedScopes)
        if let reason = access.denialReason(action) {
            DiagnosticLog.log("admin client: call refused, scope not granted", tag: "admin.client", level: .warn, fields: [
                "server": serverLabel, "action": action.rawValue, "required_scope": action.requiredScope.rawValue
            ])
            throw StudioActionFailure.refused(code: "forbidden", message: reason)
        }
        return try await caller.call(action.rawValue, args: args, timeoutSeconds: timeoutSeconds)
    }
}
