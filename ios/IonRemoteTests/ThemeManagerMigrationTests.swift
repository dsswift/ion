import XCTest
@testable import IonRemote

/// Pins the ThemeManager init-time migrations of retired theme ids:
///   - `ion-default` (removed system-adaptive theme) → `ion-dark`
///   - `jarvis-arc-reactor` (pre-unification iOS Jarvis id) → `jarvis-hud`
/// Both rewrite the persisted UserDefaults value so the migration runs once.
final class ThemeManagerMigrationTests: XCTestCase {
    private var savedValue: String?

    override func setUp() {
        super.setUp()
        savedValue = UserDefaults.standard.string(forKey: "selectedTheme")
    }

    override func tearDown() {
        if let savedValue {
            UserDefaults.standard.set(savedValue, forKey: "selectedTheme")
        } else {
            UserDefaults.standard.removeObject(forKey: "selectedTheme")
        }
        super.tearDown()
    }

    func testIonDefaultMigratesToIonDark() {
        UserDefaults.standard.set("ion-default", forKey: "selectedTheme")
        let manager = ThemeManager()
        XCTAssertEqual(manager.selectedThemeId, "ion-dark")
        XCTAssertEqual(manager.id, "ion-dark")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "selectedTheme"), "ion-dark")
    }

    func testJarvisArcReactorMigratesToJarvisHud() {
        UserDefaults.standard.set("jarvis-arc-reactor", forKey: "selectedTheme")
        let manager = ThemeManager()
        XCTAssertEqual(manager.selectedThemeId, "jarvis-hud")
        XCTAssertEqual(manager.id, "jarvis-hud")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "selectedTheme"), "jarvis-hud")
    }

    func testMissingValueDefaultsToIonDark() {
        UserDefaults.standard.removeObject(forKey: "selectedTheme")
        let manager = ThemeManager()
        XCTAssertEqual(manager.selectedThemeId, "ion-dark")
    }

    func testCurrentIdsPassThroughUnchanged() {
        UserDefaults.standard.set("ion-classic", forKey: "selectedTheme")
        let manager = ThemeManager()
        XCTAssertEqual(manager.selectedThemeId, "ion-classic")
        XCTAssertEqual(UserDefaults.standard.string(forKey: "selectedTheme"), "ion-classic")
    }
}
