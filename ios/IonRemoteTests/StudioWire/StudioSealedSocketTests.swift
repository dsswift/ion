import XCTest
import CryptoKit
@testable import IonRemote

/// The sealed socket over a WebSocket task a test controls: what it dials,
/// what it puts on the wire, and what it refuses to deliver.
final class StudioSealedSocketTests: XCTestCase {

    private let key = SymmetricKey(data: Data(repeating: 3, count: 32))

    func testTCPSocketURLNamesThePairingAndMapsTheScheme() {
        XCTAssertEqual(
            StudioTCPSocket.socketURL(serverURL: URL(string: "http://192.168.1.20:7331")!, clientId: "abc123")?.absoluteString,
            "ws://192.168.1.20:7331/studio?client=abc123"
        )
        XCTAssertEqual(
            StudioTCPSocket.socketURL(serverURL: URL(string: "wss://host.example.org/studio/")!, clientId: "abc123")?.absoluteString,
            "wss://host.example.org/studio?client=abc123"
        )
        XCTAssertNil(StudioTCPSocket.socketURL(serverURL: URL(string: "ftp://host")!, clientId: "abc123"))
    }

    // The join names the channel and role only. The push address goes to the
    // server (`device.registerPush`), never to the relay on join.
    func testRelayJoinURLCarriesRoleOnly() {
        XCTAssertEqual(
            StudioRelaySocket.joinURL(relayURL: URL(string: "https://relay.example.org/")!, channelId: "chan")?.absoluteString,
            "wss://relay.example.org/v1/channel/chan?role=mobile"
        )
        XCTAssertEqual(
            StudioRelaySocket.joinURL(relayURL: URL(string: "ws://relay.local:8080/base")!, channelId: "chan")?.absoluteString,
            "ws://relay.local:8080/base/v1/channel/chan?role=mobile"
        )
    }

    func testPushEnvironmentComesFromTheBuildsSigning() {
        func profile(_ entitlements: String) -> Data {
            // A signed envelope around a plain plist: bytes before and after the XML.
            Data([0x30, 0x82, 0x01]) + Data("""
            <?xml version="1.0" encoding="UTF-8"?>
            <plist version="1.0"><dict><key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>
            """.utf8) + Data([0x00, 0xA0])
        }
        XCTAssertEqual(APNsEnvironment.fromProvisioningProfile(profile("<key>aps-environment</key><string>development</string>")), .sandbox)
        XCTAssertEqual(APNsEnvironment.fromProvisioningProfile(profile("<key>aps-environment</key><string>production</string>")), .production)
        // TestFlight and App Store builds carry no embedded profile.
        XCTAssertEqual(APNsEnvironment.fromProvisioningProfile(nil), .production)
        XCTAssertEqual(APNsEnvironment.fromProvisioningProfile(profile("")), .sandbox)
    }

    // The phone registers its push address with the server, not the relay:
    // one action carrying the token and the build's environment, queued
    // until the connection is up, the latest address superseding an older one.
    func testPushAddressRegistersWithTheServer() {
        let command = RemoteCommand.registerPush(token: "ab12", env: APNsEnvironment.sandbox.rawValue)
        XCTAssertEqual(
            StudioTransportCommandMapping().request(for: command),
            .action(StudioActionCall(action: "device.registerPush", args: [.object(["token": .string("ab12"), "env": .string("sandbox")])]))
        )
        XCTAssertEqual(command.essentialKey, "registerPush")
        XCTAssertEqual(command.essentialKey, RemoteCommand.registerPush(token: "cd34", env: "production").essentialKey)
    }

    func testRelayDialJoinsTheDerivedChannelWithTheBearer() async throws {
        let task = ScriptedWebSocketTask()
        let factory = ScriptedWebSocketTaskFactory(task: task)
        let socket = StudioRelaySocket.make(relayURL: URL(string: "https://relay.example.org")!, key: key, taskFactory: factory) { "psk-1" }
        socket.open()
        await waitUntil("the relay join is dialed") { factory.request != nil }
        let request = try XCTUnwrap(factory.request)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer psk-1")
        XCTAssertEqual(
            request.url?.absoluteString,
            "wss://relay.example.org/v1/channel/\(E2ECrypto.deriveChannelId(sharedSecret: key))?role=mobile"
        )
        socket.close()
    }

    func testEveryOutboundFrameIsSealedAndInboundIsOpened() async throws {
        let task = ScriptedWebSocketTask()
        let socket = StudioTCPSocket.make(serverURL: URL(string: "http://host:7331")!, clientId: "c", key: key, taskFactory: ScriptedWebSocketTaskFactory(task: task))
        let received = Collected<StudioSocketEvent>()
        let consumer = Task { for await event in socket.events { received.append(event) } }
        socket.open()
        await waitUntil("the socket reports open") { received.values.first == .opened }

        try await socket.send(text: #"{"type":"studio_snapshot_request"}"#)
        let sent = try XCTUnwrap(task.sentStrings.first)
        XCTAssertFalse(sent.contains("studio_snapshot_request"), "the frame left in cleartext")
        XCTAssertEqual(SealedEnvelope.open(sent, key: key)?.bytes, Data(#"{"type":"studio_snapshot_request"}"#.utf8))

        // A relay control frame on a TCP socket is not skipped, it just fails to open.
        task.deliver(.string(#"{"type":"relay:peer_status"}"#))
        task.deliver(.string(try SealedEnvelope.seal(text: "hello", key: SymmetricKey(data: Data(repeating: 8, count: 32)))))
        task.deliver(.data(Data([1, 2, 3])))
        task.deliver(.string(try SealedEnvelope.seal(text: "frame-1", key: key)))
        task.deliver(.string(try SealedEnvelope.seal(binary: Data([5]), key: key)))
        await waitUntil("both sealed frames arrive") { received.values.count == 3 }
        XCTAssertEqual(received.values, [.opened, .text("frame-1"), .binary(Data([5]))])

        task.fail(URLError(.networkConnectionLost))
        await waitUntil("the close is reported") { received.values.count == 4 }
        guard case .closed = received.values[3] else { return XCTFail("last event is not a close") }
        await consumer.value
        do {
            try await socket.send(text: "late")
            XCTFail("a closed socket accepted a frame")
        } catch {
            XCTAssertEqual(error as? StudioSocketError, .notOpen)
        }
    }

    func testRelayControlFramesAreSkippedOnARelaySocket() {
        XCTAssertTrue(StudioSealedSocket.isRelayControlFrame(#"{"type":"relay:peer_joined","role":"ion"}"#))
        XCTAssertTrue(StudioSealedSocket.isRelayControlFrame(#"  { "type" : "relay:x"}"#))
        XCTAssertFalse(StudioSealedSocket.isRelayControlFrame(#"{"v":1,"nonce":"n","ciphertext":"relay:"}"#))
    }

    /// A server that restarts rejoins with a Connection that drops every frame
    /// until it gets a hello, so its leaving or rejoining ends the session.
    func testTheServerLeavingOrRejoiningIsAPresenceChange() {
        XCTAssertTrue(StudioSealedSocket.isServerPresenceChange(#"{"type":"relay:peer-reconnected"}"#))
        XCTAssertTrue(StudioSealedSocket.isServerPresenceChange(#"{"type":"relay:peer-disconnected"}"#))
        XCTAssertFalse(StudioSealedSocket.isServerPresenceChange(#"{"type":"relay:push-failed","reason":"no_token"}"#))
    }
}

/// A WebSocket task a test scripts: it records what is sent and delivers what the test hands it.
final class ScriptedWebSocketTask: RelayWebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running
    var maximumMessageSize = 0
    var closeCode: URLSessionWebSocketTask.CloseCode = .invalid
    var response: URLResponse?

    private let lock = NSLock()
    private var handler: (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
    private var backlog: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var strings: [String] = []

    var sentStrings: [String] { lock.withLock { strings } }

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        lock.withLock { state = .canceling }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        if case .string(let text) = message { lock.withLock { strings.append(text) } }
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        let ready = lock.withLock { () -> Result<URLSessionWebSocketTask.Message, Error>? in
            if backlog.isEmpty {
                handler = completionHandler
                return nil
            }
            return backlog.removeFirst()
        }
        if let ready { completionHandler(ready) }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func deliver(_ message: URLSessionWebSocketTask.Message) { complete(.success(message)) }
    func fail(_ error: Error) { complete(.failure(error)) }

    private func complete(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        let waiting = lock.withLock { () -> (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)? in
            guard let current = handler else {
                backlog.append(result)
                return nil
            }
            handler = nil
            return current
        }
        waiting?(result)
    }
}

final class ScriptedWebSocketTaskFactory: RelayWebSocketTaskFactory, @unchecked Sendable {
    private let task: ScriptedWebSocketTask
    private let lock = NSLock()
    private var lastRequest: URLRequest?

    init(task: ScriptedWebSocketTask) { self.task = task }

    var request: URLRequest? { lock.withLock { lastRequest } }

    func makeTask(request: URLRequest) -> RelayWebSocketTasking {
        lock.withLock { lastRequest = request }
        return task
    }

    func invalidateAndCancel() {}
}
