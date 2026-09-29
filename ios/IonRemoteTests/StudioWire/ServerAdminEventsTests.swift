import XCTest
@testable import IonRemote

/// Admin channel events are kept per server: a subscriber sees only its
/// server's events, and a page that opens late can read the newest payload.
final class ServerAdminEventsTests: XCTestCase {

    func testASubscriberSeesOnlyItsServersEvents() async {
        let store = ServerAdminEvents()
        let stream = store.events(for: "server-a")
        let seen = Collected<ServerAdminEvent>()
        let reader = Task {
            for await event in stream {
                seen.append(event)
                if seen.values.count == 2 { return }
            }
        }

        store.publish(ServerAdminEvent(serverId: "server-b", channel: ServerAdminEvent.projectsChanged, payload: .null))
        store.publish(ServerAdminEvent(serverId: "server-a", channel: ServerAdminEvent.projectsChanged, payload: .null))
        store.publish(ServerAdminEvent(serverId: "server-a", channel: ServerAdminEvent.projectJob, payload: .object(["id": .string("job-1")])))

        await waitUntil("two events for server-a") { seen.values.count == 2 }
        XCTAssertEqual(seen.values.map(\.serverId), ["server-a", "server-a"])
        XCTAssertEqual(seen.values.map(\.channel), ["ion:projects-changed", "ion:project-job"])
        reader.cancel()
    }

    func testTheNewestPayloadIsKeptPerServerAndChannel() {
        let store = ServerAdminEvents()
        store.publish(ServerAdminEvent(serverId: "server-a", channel: ServerAdminEvent.discovery, payload: .object(["mode": .string("off")])))
        store.publish(ServerAdminEvent(serverId: "server-a", channel: ServerAdminEvent.discovery, payload: .object(["mode": .string("open")])))
        store.publish(ServerAdminEvent(serverId: "server-b", channel: ServerAdminEvent.discovery, payload: .object(["mode": .string("off")])))

        XCTAssertEqual(store.latest(serverId: "server-a", channel: "ion:discovery")?["mode"]?.stringValue, "open")
        XCTAssertEqual(store.latest(serverId: "server-b", channel: "ion:discovery")?["mode"]?.stringValue, "off")
        XCTAssertNil(store.latest(serverId: "server-a", channel: "ion:clients-changed"))
    }

    /// The channel names are the server's; a typo here would route nothing.
    func testEveryRoutedChannelIsRegisteredOnTheServer() throws {
        let file: StaticString = #filePath
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        var registry: String?
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("packages/shared/src/studio-wire/channels.ts")
            if FileManager.default.fileExists(atPath: candidate.path) {
                registry = try String(contentsOf: candidate, encoding: .utf8)
                break
            }
            dir = dir.deletingLastPathComponent()
        }
        guard let registry else { throw XCTSkip("channels.ts not found above \(file)") }
        for channel in ServerAdminEvent.channels {
            XCTAssertTrue(registry.contains("name: '\(channel)'"), "\(channel) is not a registered channel")
        }
    }
}
