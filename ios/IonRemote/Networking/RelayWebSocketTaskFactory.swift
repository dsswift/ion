import Foundation

/// Creates relay WebSocket tasks and owns their backing session.
protocol RelayWebSocketTaskFactory {
    func makeTask(request: URLRequest) -> RelayWebSocketTasking
    func invalidateAndCancel()
}

/// Production relay task factory. A factory instance owns one URLSession so
/// replacing a connection also invalidates the session that carried it.
final class URLSessionRelayWebSocketTaskFactory: RelayWebSocketTaskFactory {
    private let session: URLSession

    init(configuration: URLSessionConfiguration = .default) {
        session = URLSession(configuration: configuration)
    }

    func makeTask(request: URLRequest) -> RelayWebSocketTasking {
        session.webSocketTask(with: request)
    }

    func invalidateAndCancel() {
        session.invalidateAndCancel()
    }
}
