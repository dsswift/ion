import Foundation

/// What a `StudioSocket` reports, in order, ending with exactly one `.closed`.
enum StudioSocketEvent: Equatable, Sendable {
    /// The WebSocket is open; a hello may be sent.
    case opened
    /// One JSON text frame, already opened from its envelope.
    case text(String)
    /// One binary frame, already opened from its envelope.
    case binary(Data)
    case closed(StudioSocketClosure)
}

/// Why a socket ended.
struct StudioSocketClosure: Equatable, Sendable {
    /// The WebSocket close code, when the peer sent one.
    var closeCode: Int?
    /// The HTTP status of a refused upgrade, when there was one.
    var httpStatus: Int?
    var reason: String
}

/// One dialed connection that carries Studio wire frames. A socket is used
/// once: after `.closed` it is discarded and a new one is dialed.
///
/// `StudioConnection` drives this surface and knows nothing about sealing or
/// about which route the frames take.
protocol StudioSocket: AnyObject, Sendable {
    /// Names the route in logs and connection state: `tcp` or `relay`.
    var routeKind: StudioRouteKind { get }
    var events: AsyncStream<StudioSocketEvent> { get }
    /// Starts dialing. Events follow on `events`.
    func open()
    /// Sends one text frame. `traceparent`, when set, rides the frame's outer
    /// envelope (plaintext, beside the sealed bytes) for a relay to read.
    func send(text: String, traceparent: String?) async throws
    func send(binary: Data) async throws
    /// Closes the socket. `.closed` is still delivered, once.
    func close()
}

extension StudioSocket {
    /// Sends one text frame with no trace context on its envelope.
    func send(text: String) async throws {
        try await send(text: text, traceparent: nil)
    }
}

/// Which way a connection reaches its server.
enum StudioRouteKind: String, Equatable, Sendable {
    case tcp
    case relay
}

enum StudioSocketError: Error, LocalizedError, Equatable {
    case notOpen
    case sendTimedOut

    var errorDescription: String? {
        switch self {
        case .notOpen: return "Studio socket is not open"
        case .sendTimedOut: return "Studio socket send timed out"
        }
    }
}
