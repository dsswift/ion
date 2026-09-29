import XCTest
@testable import IonRemote

final class ResourceCommandWireTests: XCTestCase {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

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
