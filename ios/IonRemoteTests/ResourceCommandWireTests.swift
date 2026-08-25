import XCTest
@testable import IonRemote

final class ResourceCommandWireTests: XCTestCase {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    func testProducerAwareResourceCommandsRoundTrip() throws {
        let commands: [RemoteCommand] = [
            .requestResourceContent(kind: "briefing", producer: "producer-a", resourceId: "shared"),
            .markResourceRead(kind: "briefing", producer: "producer-a", resourceId: "shared"),
            .deleteResource(kind: "briefing", producer: "producer-a", resourceId: "shared"),
        ]

        for command in commands {
            let data = try encoder.encode(command)
            let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
            XCTAssertEqual(payload["producer"], "producer-a")
            let decoded = try decoder.decode(RemoteCommand.self, from: data)
            switch (command, decoded) {
            case (.requestResourceContent(let kind, let producer, let resourceId),
                  .requestResourceContent(let decodedKind, let decodedProducer, let decodedResourceId)),
                 (.markResourceRead(let kind, let producer, let resourceId),
                  .markResourceRead(let decodedKind, let decodedProducer, let decodedResourceId)),
                 (.deleteResource(let kind, let producer, let resourceId),
                  .deleteResource(let decodedKind, let decodedProducer, let decodedResourceId)):
                XCTAssertEqual(decodedKind, kind)
                XCTAssertEqual(decodedProducer, producer)
                XCTAssertEqual(decodedResourceId, resourceId)
            default:
                XCTFail("Resource command round trip changed its case")
            }
        }
    }

    func testResourceContentCarriesProducer() throws {
        let json = #"{"type":"desktop_resource_content","resourceId":"shared","kind":"briefing","producer":"producer-a","content":"body"}"#.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .resourceContent(let resourceId, let kind, let producer, let content) = event else {
            return XCTFail("Expected resourceContent")
        }
        XCTAssertEqual(resourceId, "shared")
        XCTAssertEqual(kind, "briefing")
        XCTAssertEqual(producer, "producer-a")
        XCTAssertEqual(content, "body")
    }
}
