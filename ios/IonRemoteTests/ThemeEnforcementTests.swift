import XCTest
@testable import IonRemote

/// Pins iOS-side enterprise theme enforcement:
///   - a locked policy overrides rendering while preserving the user's
///     selection (which resumes when the policy clears),
///   - an unresolvable enforced id falls back to Ion Dark,
///   - enforcement persists across ThemeManager instances (offline relaunch),
///   - the settings-snapshot wire shape carries themePolicy.
final class ThemeEnforcementTests: XCTestCase {
    private var savedSelected: String?
    private var savedEnforced: String?

    override func setUp() {
        super.setUp()
        savedSelected = UserDefaults.standard.string(forKey: "selectedTheme")
        savedEnforced = UserDefaults.standard.string(forKey: "enforcedThemeId")
        UserDefaults.standard.removeObject(forKey: "enforcedThemeId")
    }

    override func tearDown() {
        if let savedSelected {
            UserDefaults.standard.set(savedSelected, forKey: "selectedTheme")
        } else {
            UserDefaults.standard.removeObject(forKey: "selectedTheme")
        }
        if let savedEnforced {
            UserDefaults.standard.set(savedEnforced, forKey: "enforcedThemeId")
        } else {
            UserDefaults.standard.removeObject(forKey: "enforcedThemeId")
        }
        super.tearDown()
    }

    func testEnforcedThemeOverridesSelectionAndClears() {
        UserDefaults.standard.set("ion-light", forKey: "selectedTheme")
        let manager = ThemeManager()
        XCTAssertEqual(manager.id, "ion-light")

        manager.setEnforcedTheme("ion-classic")
        XCTAssertEqual(manager.id, "ion-classic", "enforced theme renders")
        XCTAssertEqual(manager.selectedThemeId, "ion-light", "user selection preserved")

        manager.setEnforcedTheme(nil)
        XCTAssertEqual(manager.id, "ion-light", "selection resumes when the policy lifts")
    }

    func testUnresolvableEnforcedIdFallsBackToIonDark() {
        UserDefaults.standard.set("ion-light", forKey: "selectedTheme")
        let manager = ThemeManager()
        manager.setEnforcedTheme("acme-not-synced-yet")
        XCTAssertEqual(manager.id, "ion-dark")
    }

    func testEnforcementPersistsAcrossInstances() {
        UserDefaults.standard.set("ion-light", forKey: "selectedTheme")
        let first = ThemeManager()
        first.setEnforcedTheme("ion-classic")

        let second = ThemeManager()
        XCTAssertEqual(second.enforcedThemeId, "ion-classic")
        XCTAssertEqual(second.id, "ion-classic")
    }

    func testSettingsSnapshotDecodesThemePolicy() throws {
        let json = """
        {
          "type": "desktop_settings_snapshot",
          "settings": {},
          "schema": [],
          "groups": [],
          "themePolicy": { "themeId": "acme-corp", "locked": true }
        }
        """
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
        guard case .desktopSettingsSnapshot(_, _, _, _, let themePolicy) = event else {
            return XCTFail("expected desktopSettingsSnapshot, got \(event)")
        }
        XCTAssertEqual(themePolicy, RemoteThemePolicy(themeId: "acme-corp", locked: true))
    }

    func testSettingsSnapshotWithoutThemePolicyDecodesNil() throws {
        let json = """
        { "type": "desktop_settings_snapshot", "settings": {}, "schema": [], "groups": [] }
        """
        let event = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
        guard case .desktopSettingsSnapshot(_, _, _, _, let themePolicy) = event else {
            return XCTFail("expected desktopSettingsSnapshot, got \(event)")
        }
        XCTAssertNil(themePolicy)
    }
}
