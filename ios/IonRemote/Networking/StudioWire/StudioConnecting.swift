import Foundation

/// The part of `StudioConnection` that `StudioTransport` uses, as a protocol so
/// a test can stand in for the connection.
protocol StudioConnecting: AnyObject, Sendable {
    var inbound: AsyncStream<StudioInbound> { get }
    var states: AsyncStream<StudioConnectionState> { get }

    func start() async
    func stop() async
    func restart() async
    /// Runs one action and returns its value. `traceparent` rides the outer envelope of the frame that carries it.
    func sendAction(_ action: String, args: [JSONValue], activeTabId: String?, timeoutSeconds: Double?, traceparent: String?) async throws -> JSONValue
    /// Hands the action to the wire and returns; `completion` gets the value or a `StudioActionFailure`, once.
    /// `traceparent`, when set, rides the outer envelope of the frame that carries the action.
    func submitAction(
        _ action: String, args: [JSONValue], activeTabId: String?, timeoutSeconds: Double?, traceparent: String?,
        completion: @escaping @Sendable (Result<JSONValue, Error>) -> Void
    ) async
    func requestSnapshot() async
    func requestBody(_ request: StudioBodyRequest) async
}

extension StudioConnection: StudioConnecting {}
