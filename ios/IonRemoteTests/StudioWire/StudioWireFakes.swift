import XCTest
@testable import IonRemote

/// A `StudioSocket` a test drives by hand.
final class FakeStudioSocket: StudioSocket, @unchecked Sendable {
    let routeKind: StudioRouteKind
    let events: AsyncStream<StudioSocketEvent>
    private let continuation: AsyncStream<StudioSocketEvent>.Continuation
    private let lock = NSLock()
    private var texts: [String] = []
    private var traceparents: [String?] = []
    private var didOpen = false
    private var didClose = false

    init(routeKind: StudioRouteKind = .tcp) {
        self.routeKind = routeKind
        var continuation: AsyncStream<StudioSocketEvent>.Continuation!
        self.events = AsyncStream { continuation = $0 }
        self.continuation = continuation
    }

    func open() {
        lock.withLock { didOpen = true }
        continuation.yield(.opened)
    }

    func send(text: String, traceparent: String?) async throws {
        guard !isClosed else { throw StudioSocketError.notOpen }
        lock.withLock {
            texts.append(text)
            traceparents.append(traceparent)
        }
    }

    /// The envelope traceparent each text frame was sent with, in send order.
    var sentTraceparents: [String?] { lock.withLock { traceparents } }

    func send(binary: Data) async throws {}

    func close() { end(reason: "closed by caller") }

    // Test controls

    var isOpen: Bool { lock.withLock { didOpen } }
    var isClosed: Bool { lock.withLock { didClose } }

    var sentFrames: [StudioFrame] {
        lock.withLock { texts }.compactMap { text in
            do {
                return try StudioFrame.decode(text: text)
            } catch {
                XCTFail("the connection sent a frame that does not decode: \(text)")
                return nil
            }
        }
    }

    func receive(_ frame: StudioFrame) throws {
        continuation.yield(.text(try frame.encodedText()))
    }

    /// The far end went away.
    func drop(reason: String = "network lost") { end(reason: reason) }

    private func end(reason: String) {
        let first = lock.withLock { () -> Bool in
            guard !didClose else { return false }
            didClose = true
            return true
        }
        guard first else { return }
        continuation.yield(.closed(StudioSocketClosure(closeCode: nil, httpStatus: nil, reason: reason)))
        continuation.finish()
    }
}

/// Hands a connection one prepared socket per dial and counts the dials.
final class FakeDialer: @unchecked Sendable {
    private let lock = NSLock()
    private var sockets: [FakeStudioSocket]
    private var dialed = 0
    let credential: StudioCredential

    init(sockets: [FakeStudioSocket], credential: StudioCredential = .paired(clientId: "phone-1", proof: "cHJvb2Y=")) {
        self.sockets = sockets
        self.credential = credential
    }

    var dialCount: Int { lock.withLock { dialed } }

    var dial: StudioConnection.Dial {
        { [self] in
            let next = lock.withLock { () -> FakeStudioSocket? in
                dialed += 1
                return sockets.isEmpty ? nil : sockets.removeFirst()
            }
            guard let next else { throw StudioRouteError.unreachable(host: "test") }
            return StudioDialPlan(socket: next, credential: credential)
        }
    }
}

extension StudioWelcome {
    /// A thin-view welcome with nothing in it but who and where.
    static func fixture(environmentId: String = "env-1", relays: [StudioEnvironmentRelay]? = nil) -> StudioWelcome {
        StudioWelcome(
            protocolVersion: 1,
            environmentId: environmentId,
            label: "Test host",
            platform: "darwin",
            serverVersion: "0.1.0",
            engineVersion: "1.0.0",
            capabilities: [],
            principal: StudioPrincipalSummary(subject: "paired:phone-1", displayName: "Phone"),
            scopes: ["conversations:read", "conversations:operate"],
            pairedClientId: "phone-1",
            relays: relays,
            enterprisePolicy: .null,
            settingsHiddenGroups: [],
            snapshot: .object(["engine": .object(["connected": .bool(true)])])
        )
    }
}
