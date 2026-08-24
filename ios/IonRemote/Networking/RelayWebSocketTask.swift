import Foundation

/// The WebSocket operations used by `RelayClient`.
///
/// `URLSessionWebSocketTask` conforms in production. Tests supply a controlled
/// task so timeout and replacement behavior can be pinned without a live relay.
protocol RelayWebSocketTasking: AnyObject, Sendable {
    var state: URLSessionTask.State { get }
    var maximumMessageSize: Int { get set }
    var closeCode: URLSessionWebSocketTask.CloseCode { get }
    var response: URLResponse? { get }

    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    )
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void)
}

extension URLSessionWebSocketTask: RelayWebSocketTasking {}
