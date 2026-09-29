import Foundation

/// The integrations pages' shared reading of the answer most of their actions
/// give: `{ ok: true, ... }`, or `{ ok: false, error }` for a refusal.
extension ServerAdminClient {

    /// Runs `action` and returns its `{ ok, ... }` answer once `ok` holds.
    /// A refusal throws with the server's own reason.
    func callOkEnvelope(_ action: PhoneAction, args: [JSONValue] = [], timeoutSeconds: Double? = nil) async throws -> JSONValue {
        let value = try await callValue(action, args: args, timeoutSeconds: timeoutSeconds)
        guard value["ok"]?.boolValue == true else {
            let reason = value["error"]?.stringValue ?? "\(serverLabel) did not complete \(action.rawValue)."
            DiagnosticLog.log("admin client: action answered not ok", tag: "admin.client", level: .warn, fields: [
                "server": serverLabel, "action": action.rawValue, "error": String(reason.prefix(300))
            ])
            throw StudioActionFailure.failed(code: "declined", message: reason)
        }
        return value
    }

    /// Decodes member `key` of an answer as `T`.
    func member<T: Decodable>(_ key: String, of value: JSONValue, from action: PhoneAction, as type: T.Type = T.self) throws -> T {
        try decodeAnswer(value[key] ?? .null, from: action, as: type)
    }

    /// Decodes an answer as `T`, or throws a sentence naming the action.
    func decodeAnswer<T: Decodable>(_ value: JSONValue, from action: PhoneAction, as type: T.Type = T.self) throws -> T {
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
}
