import Foundation
import CryptoKit

/// The direct route: a WebSocket to the server's own listener at
/// `/studio?client=<clientId>`. The query names the pairing whose secret the
/// server opens frames with, and every frame either way is then sealed. The
/// listener speaks plain `ws://`, so the envelope is what keeps a paired
/// session private on the LAN.
enum StudioTCPSocket {

    /// - Parameter serverURL: the server's base, as `http(s)://` or `ws(s)://`, with or without `/studio`.
    static func make(
        serverURL: URL,
        clientId: String,
        key: SymmetricKey,
        taskFactory: RelayWebSocketTaskFactory = URLSessionRelayWebSocketTaskFactory()
    ) -> StudioSealedSocket {
        StudioSealedSocket(
            routeKind: .tcp,
            key: key,
            options: .init(label: serverURL.host(percentEncoded: false) ?? "unknown", skipRelayControlFrames: false),
            taskFactory: taskFactory
        ) {
            guard let url = socketURL(serverURL: serverURL, clientId: clientId) else {
                throw StudioRouteError.malformedURL(serverURL.absoluteString)
            }
            return URLRequest(url: url)
        }
    }

    /// `ws(s)://host:port/studio?client=<clientId>` for a server base URL.
    static func socketURL(serverURL: URL, clientId: String) -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else { return nil }
        switch components.scheme {
        case "https", "wss": components.scheme = "wss"
        case "http", "ws": components.scheme = "ws"
        default: return nil
        }
        var path = components.path
        if path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/studio") { path.removeLast("/studio".count) }
        components.path = path + "/studio"
        components.queryItems = [URLQueryItem(name: "client", value: clientId)]
        components.fragment = nil
        return components.url
    }
}
