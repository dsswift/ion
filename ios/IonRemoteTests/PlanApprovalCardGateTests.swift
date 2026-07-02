import XCTest
@testable import IonRemote

/// Pins `PlanApprovalCardView.resolveShowClearContext(settings:)` — the pure
/// gate that decides whether the "Implement, clear context" button renders on
/// the Plan Ready card. The button mirrors the desktop: it is revealed only
/// when the `showImplementClearContext` desktop setting is `true`.
///
/// Layout correctness (the button not overlapping the pinned split row) is a
/// SwiftUI layout property verified on the simulator, not here. This test
/// guards the presence gate so a settings-projection regression can't silently
/// hide or force-show the button.
final class PlanApprovalCardGateTests: XCTestCase {

    private func makeSettings(_ pairs: [String: AnyCodable]) -> DesktopSettingsState {
        DesktopSettingsState(settings: pairs, schema: [], groups: [])
    }

    func testSettingOn_showsButton() {
        let settings = makeSettings(["showImplementClearContext": AnyCodable(true)])
        XCTAssertTrue(PlanApprovalCardView.resolveShowClearContext(settings: settings))
    }

    func testSettingOff_hidesButton() {
        let settings = makeSettings(["showImplementClearContext": AnyCodable(false)])
        XCTAssertFalse(PlanApprovalCardView.resolveShowClearContext(settings: settings))
    }

    func testSettingAbsent_hidesButton() {
        // Key not present in settings and no schema default → off.
        let settings = makeSettings([:])
        XCTAssertFalse(PlanApprovalCardView.resolveShowClearContext(settings: settings))
    }

    func testNilSettings_hidesButton() {
        XCTAssertFalse(PlanApprovalCardView.resolveShowClearContext(settings: nil))
    }

    func testNonBooleanValue_hidesButton() {
        // Defensive: a non-boolean value for the key must not enable the button.
        let settings = makeSettings(["showImplementClearContext": AnyCodable("yes")])
        XCTAssertFalse(PlanApprovalCardView.resolveShowClearContext(settings: settings))
    }
}
