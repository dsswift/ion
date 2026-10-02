import XCTest
@testable import IonRemote

/// Pins the Swift Provider Subscription types to the Go contract manifest:
/// the phone decodes the engine's snapshot as the server passes it through.
final class ContractSyncProviderSubscriptionTests: XCTestCase {

    private struct Manifest: Decodable {
        let sharedTypes: [String: [String]]
    }

    private func sharedTypes() throws -> [String: [String]] {
        let here = URL(fileURLWithPath: #filePath)
        let url = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("engine/internal/types/testdata/contracts.json")
        return try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: url)).sharedTypes
    }

    func testProviderSubscriptionStatusMatchesGo() throws {
        let swiftFields: Set<String> = ["state", "provider", "providerDisplayName", "selected", "options", "source", "resolvedAt", "error", "policyFailure", "message"]
        XCTAssertEqual(Set(try XCTUnwrap(sharedTypes()["ProviderSubscriptionStatus"])), swiftFields)
    }

    func testSubscriptionOptionMatchesGo() throws {
        XCTAssertEqual(Set(try XCTUnwrap(sharedTypes()["SubscriptionOption"])), ["id", "label"])
    }
}
