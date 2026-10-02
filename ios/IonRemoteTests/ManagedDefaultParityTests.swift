import XCTest
@testable import IonRemote

/// Managed-default parity — iOS side.
///
/// The shared fixture (repo-root `assets/managed-default-parity.json`) pins
/// how a client treats an unlocked enterprise policy value. This suite
/// asserts the Swift rule against it; the other half is
/// `packages/shared/src/__tests__/managed-defaults.test.ts`. It then drives
/// the same sequences through `ThemeManager`, the one preference in the
/// class the phone owns, to pin that the managed default lands on the
/// selection and never on the enforced slot.
final class ManagedDefaultParityTests: XCTestCase {

    // MARK: - Fixture

    private struct DecisionCase: Decodable {
        let name: String
        let policyValue: String?
        let locked: Bool
        let applied: String?
        let decision: String
    }
    private struct Policy: Decodable {
        let value: String
        let locked: Bool
    }
    private struct Step: Decodable {
        let policy: Policy?
        let userSets: String?
        let preference: String
    }
    private struct Sequence: Decodable {
        let name: String
        let initialPreference: String
        let steps: [Step]
    }
    private struct Fixture: Decodable {
        let decisions: [DecisionCase]
        let sequences: [Sequence]
    }
    private enum FixtureError: Error { case notFound }

    private func loadFixture() throws -> Fixture {
        let name = "assets/managed-default-parity.json"
        var candidates = [URL(fileURLWithPath: "../\(name)"), URL(fileURLWithPath: name)]
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<5 {
            dir = dir.deletingLastPathComponent()
            candidates.append(dir.appendingPathComponent(name))
        }
        guard let url = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            throw FixtureError.notFound
        }
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    // MARK: - Isolated storage

    private let suiteName = "ManagedDefaultParityTests"
    private var defaults: UserDefaults!
    private var savedSelected: String?
    private var savedEnforced: String?

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        // ThemeManager persists its two slots in the standard defaults.
        savedSelected = UserDefaults.standard.string(forKey: "selectedTheme")
        savedEnforced = UserDefaults.standard.string(forKey: "enforcedThemeId")
        UserDefaults.standard.removeObject(forKey: "enforcedThemeId")
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        restore(savedSelected, forKey: "selectedTheme")
        restore(savedEnforced, forKey: "enforcedThemeId")
        super.tearDown()
    }

    private func restore(_ value: String?, forKey key: String) {
        if let value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    // MARK: - The rule

    func testDecisionsMatchFixture() throws {
        for testCase in try loadFixture().decisions {
            let decision = ManagedDefault.decide(policyValue: testCase.policyValue, locked: testCase.locked, applied: testCase.applied)
            XCTAssertEqual(decision.rawValue, testCase.decision, testCase.name)
        }
    }

    // MARK: - The theme, over time

    func testThemeSequencesMatchFixture() throws {
        for sequence in try loadFixture().sequences {
            defaults.removePersistentDomain(forName: suiteName)
            UserDefaults.standard.set(sequence.initialPreference, forKey: "selectedTheme")
            UserDefaults.standard.removeObject(forKey: "enforcedThemeId")
            let manager = ThemeManager()
            let watermarks = ManagedDefault.Watermarks(defaults: defaults)

            for (index, step) in sequence.steps.enumerated() {
                if let userSets = step.userSets {
                    manager.selectedThemeId = userSets
                } else {
                    manager.applyThemePolicy(
                        themeId: step.policy?.value,
                        locked: step.policy?.locked ?? false,
                        source: "server-1",
                        watermarks: watermarks
                    )
                    // The enforced slot is the lock channel and nothing else.
                    let expectedEnforced = step.policy?.locked == true ? step.policy?.value : nil
                    XCTAssertEqual(manager.enforcedThemeId, expectedEnforced, "\(sequence.name), step \(index): enforced slot")
                }
                XCTAssertEqual(manager.selectedThemeId, step.preference, "\(sequence.name), step \(index)")
            }
        }
    }

    // MARK: - Storage

    func testWatermarkSurvivesANewManager() {
        UserDefaults.standard.set("ion-light", forKey: "selectedTheme")
        let watermarks = ManagedDefault.Watermarks(defaults: defaults)
        let first = ThemeManager()
        first.applyThemePolicy(themeId: "ion-classic", locked: false, source: "server-1", watermarks: watermarks)
        first.selectedThemeId = "ion-dark"

        let relaunched = ThemeManager()
        relaunched.applyThemePolicy(themeId: "ion-classic", locked: false, source: "server-1", watermarks: watermarks)
        XCTAssertEqual(relaunched.selectedThemeId, "ion-dark", "an unchanged policy must not overwrite the choice after a relaunch")
    }

    func testWatermarkIsPerSource() {
        UserDefaults.standard.set("ion-light", forKey: "selectedTheme")
        let watermarks = ManagedDefault.Watermarks(defaults: defaults)
        let manager = ThemeManager()
        manager.applyThemePolicy(themeId: "ion-classic", locked: false, source: "server-1", watermarks: watermarks)
        manager.applyThemePolicy(themeId: "ion-dark", locked: false, source: "server-2", watermarks: watermarks)
        XCTAssertEqual(manager.selectedThemeId, "ion-dark", "a second server's default applies once")

        manager.selectedThemeId = "ion-light"
        manager.applyThemePolicy(themeId: "ion-classic", locked: false, source: "server-1", watermarks: watermarks)
        manager.applyThemePolicy(themeId: "ion-dark", locked: false, source: "server-2", watermarks: watermarks)
        XCTAssertEqual(manager.selectedThemeId, "ion-light", "switching between servers must not re-apply either default")
    }
}
