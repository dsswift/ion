import XCTest
@testable import IonRemote

/// The drift guard between `PhoneAction` and the shared list of actions the
/// phone calls directly.
///
/// `packages/shared/src/studio-wire/phone-actions.json` names each action and
/// the scope the server requires for it; the server pins that file against its
/// own registry. This pins it against the Swift table, so the phone never
/// offers an action the server does not have, or gates one on the wrong scope.
final class PhoneActionTableTests: XCTestCase {

    private struct Entry: Decodable {
        let action: String
        let scope: String
    }

    private struct List: Decodable {
        let actions: [Entry]
    }

    /// `phone-actions.json`, found by walking up from this source file.
    private func loadList(file: StaticString = #filePath) throws -> [Entry] {
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("packages/shared/src/studio-wire/phone-actions.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(List.self, from: Data(contentsOf: candidate)).actions
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("phone-actions.json not found above \(file)")
    }

    func testTheSwiftTableEqualsTheSharedList() throws {
        let entries = try loadList()
        let shared = Dictionary(entries.map { ($0.action, $0.scope) }, uniquingKeysWith: { first, _ in first })
        XCTAssertEqual(shared.count, entries.count, "phone-actions.json lists an action twice")
        let swift = Dictionary(uniqueKeysWithValues: PhoneAction.allCases.map { ($0.rawValue, $0.requiredScope.rawValue) })
        XCTAssertEqual(Set(shared.keys).subtracting(swift.keys).sorted(), [], "in phone-actions.json, missing from PhoneAction")
        XCTAssertEqual(Set(swift.keys).subtracting(shared.keys).sorted(), [], "in PhoneAction, missing from phone-actions.json")
        for (action, scope) in shared {
            guard let swiftScope = swift[action] else { continue }
            XCTAssertEqual(swiftScope, scope, "scope of \(action)")
        }
    }

    func testEveryListedScopeIsOneThisClientKnows() throws {
        let unknown = try loadList().map(\.scope).filter { StudioScope(rawValue: $0) == nil }
        XCTAssertEqual(unknown, [])
    }
}
