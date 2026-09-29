import Foundation
@testable import IonRemote

/// A `StudioActionCalling` that answers from a table and records each call.
final class FakeActionCaller: StudioActionCalling, @unchecked Sendable {

    struct Call: Equatable {
        let action: String
        let args: [JSONValue]
    }

    private let lock = NSLock()
    private var scopes: [String]?
    private var answers: [String: Result<JSONValue, Error>] = [:]
    private var recorded: [Call] = []

    init(scopes: [String]?) { self.scopes = scopes }

    var grantedScopes: [String]? { lock.withLock { scopes } }
    var calls: [Call] { lock.withLock { recorded } }

    func answer(_ action: PhoneAction, with outcome: Result<JSONValue, Error>) {
        lock.withLock { answers[action.rawValue] = outcome }
    }

    func call(_ action: String, args: [JSONValue], timeoutSeconds: Double?) async throws -> JSONValue {
        try lock.withLock {
            recorded.append(Call(action: action, args: args))
            return answers[action] ?? .success(.null)
        }.get()
    }
}
