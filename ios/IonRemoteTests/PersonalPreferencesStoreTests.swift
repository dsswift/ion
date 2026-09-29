import XCTest
@testable import IonRemote

/// A Personal preference lives on this phone and is declared to each server.
final class PersonalPreferencesStoreTests: XCTestCase {
    private var defaults: UserDefaults!
    private let suite = "PersonalPreferencesStoreTests"

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suite)
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suite)
        super.tearDown()
    }

    /// The keys must be the ones the server consumes. The server registry is
    /// the source of truth; this reads it from disk so a key added there
    /// without being added here fails.
    func testTravellingKeysMatchTheServerRegistry() throws {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        var registry: String?
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("packages/shared/src/settings-registry.ts")
            if let text = try? String(contentsOf: candidate, encoding: .utf8) { registry = text; break }
            dir = dir.deletingLastPathComponent()
        }
        guard let registry else { throw XCTSkip("settings-registry.ts not found above \(#filePath)") }
        // An entry reads `  key: travels('page'),`; the key is what precedes it.
        let travelling = registry.split(separator: "\n")
            .compactMap { line -> String? in
                guard let marker = line.range(of: ": travels(") else { return nil }
                return line[..<marker.lowerBound].trimmingCharacters(in: .whitespaces)
            }
        XCTAssertFalse(travelling.isEmpty, "found no travelling keys; the registry's shape changed")
        XCTAssertEqual(Set(travelling), Set(PersonalPreferencesStore.travellingKeys))
    }

    func testDeclaresOnlyWhatThisPhoneHolds() {
        XCTAssertEqual(PersonalPreferencesStore.declared(defaults: defaults), [:])
        PersonalPreferencesStore.set("enableClaudeCompat", AnyCodable(true), defaults: defaults)
        PersonalPreferencesStore.set("defaultThinkingEffort", AnyCodable("high"), defaults: defaults)
        XCTAssertEqual(PersonalPreferencesStore.declared(defaults: defaults), [
            "enableClaudeCompat": .bool(true),
            "defaultThinkingEffort": .string("high"),
        ])
    }

    /// Values a server still holds from before the move are taken once, and a
    /// value this phone already holds is never replaced by a server's.
    func testAdoptsEarlierServerValuesOnceAndNeverOverwritesLocal() {
        let owned = ["aiGeneratedTitles", "defaultPermissionMode", "showTodoList"]
        PersonalPreferencesStore.set("aiGeneratedTitles", AnyCodable(false), defaults: defaults)
        let server: [String: AnyCodable] = [
            "aiGeneratedTitles": AnyCodable(true),
            "defaultPermissionMode": AnyCodable("auto"),
            "showTodoList": AnyCodable(false),
            "gitOpsMode": AnyCodable("worktree"),
        ]
        XCTAssertEqual(PersonalPreferencesStore.adopt(from: server, clientOwnedKeys: owned, defaults: defaults), ["defaultPermissionMode", "showTodoList"])
        XCTAssertEqual(PersonalPreferencesStore.declared(defaults: defaults), [
            "aiGeneratedTitles": .bool(false),
            "defaultPermissionMode": .string("auto"),
        ])
        XCTAssertEqual(PersonalPreferencesStore.adopt(from: server, clientOwnedKeys: owned, defaults: defaults), [])
        XCTAssertNil(PersonalPreferencesStore.value(for: "gitOpsMode", defaults: defaults), "a server setting is never stored on the phone")
    }

    /// A list-valued setting (the notification blocklist) round-trips.
    func testStoresAListValue() {
        PersonalPreferencesStore.set("excludedResourceKinds", AnyCodable([AnyCodable("briefing")]), defaults: defaults)
        let stored = PersonalPreferencesStore.value(for: "excludedResourceKinds", defaults: defaults)?.value as? [AnyCodable]
        XCTAssertEqual(stored?.first?.value as? String, "briefing")
    }

    func testOverlayShowsThisPhonesValueOverTheServers() {
        PersonalPreferencesStore.set("aiGeneratedTitles", AnyCodable(false), defaults: defaults)
        let shown = PersonalPreferencesStore.overlay(
            ["aiGeneratedTitles": AnyCodable(true), "gitOpsMode": AnyCodable("manual")],
            clientOwnedKeys: ["aiGeneratedTitles"], defaults: defaults)
        XCTAssertEqual(shown["aiGeneratedTitles"]?.value as? Bool, false)
        XCTAssertEqual(shown["gitOpsMode"]?.value as? String, "manual")
    }

    func testClientOwnedScopes() {
        XCTAssertTrue(PersonalPreferencesStore.isClientOwned(scope: "personal"))
        XCTAssertTrue(PersonalPreferencesStore.isClientOwned(scope: "device"))
        XCTAssertFalse(PersonalPreferencesStore.isClientOwned(scope: "account"))
        XCTAssertFalse(PersonalPreferencesStore.isClientOwned(scope: "environment"))
        XCTAssertFalse(PersonalPreferencesStore.isClientOwned(scope: nil))
    }
}
