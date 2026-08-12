import XCTest
@testable import IonRemote

/// Tests for the `abbreviateProfileName` harness badge helper.
///
/// Rules verified (matching desktop TabStripShared.ts):
///   1. Nil/empty name → "EXT"
///   2. Short name (≤8 chars) → unchanged (case-preserving)
///   3. Multi-word (>8 chars) → initials, uppercased, capped at 8
///   4. Single long word (>8 chars) → first 8 chars uppercased
///   5. Whitespace-only → "EXT"
final class EngineHarnessBadgeTests: XCTestCase {

    // MARK: - Rule 1: nil / empty → "EXT"

    func testNilName_returnsEXT() {
        XCTAssertEqual(abbreviateProfileName(nil), "EXT")
    }

    func testEmptyString_returnsEXT() {
        XCTAssertEqual(abbreviateProfileName(""), "EXT")
    }

    func testWhitespaceOnly_returnsEXT() {
        XCTAssertEqual(abbreviateProfileName("   "), "EXT")
    }

    // MARK: - Rule 2: short names pass through unchanged

    func testThreeCharName_passesThrough() {
        // "COS" → "COS" (already ≤5 chars, no abbreviation)
        XCTAssertEqual(abbreviateProfileName("COS"), "COS")
    }

    func testFiveCharName_passesThrough() {
        // "Orion" → "Orion" (exactly 5 chars, no abbreviation, case preserved)
        XCTAssertEqual(abbreviateProfileName("Orion"), "Orion")
    }

    func testOneCharName_passesThrough() {
        XCTAssertEqual(abbreviateProfileName("A"), "A")
    }

    func testFourCharMixedCase_passesThrough() {
        XCTAssertEqual(abbreviateProfileName("Dev2"), "Dev2")
    }

    func testFiveCharMixedCase_passesThrough() {
        // Exactly 5 — must not be truncated or uppercased
        XCTAssertEqual(abbreviateProfileName("Alpha"), "Alpha")
    }

    // MARK: - Rule 3: multi-word → initials, capped at 5

    func testTwoWordsShort_passesThrough() {
        // "Ion Dev" is 7 chars (≤8) so it passes through unchanged — the
        // multi-word initials path only fires once the trimmed name exceeds 8.
        XCTAssertEqual(abbreviateProfileName("Ion Dev"), "Ion Dev")
    }

    func testThreeWords_producesInitials() {
        // "My Long Name" (12 chars, >8) → "MLN"
        XCTAssertEqual(abbreviateProfileName("My Long Name"), "MLN")
    }

    func testManyWords_initials() {
        // "My Long Name Extra Words" (>8) → "MLNEW" (5 initials)
        XCTAssertEqual(abbreviateProfileName("My Long Name Extra Words"), "MLNEW")
    }

    func testManyWordsOver8_capped() {
        // "Aa Bb Cc Dd Ee Ff Gg Hh Ii" (>8) → 9 initials available, capped at 8
        XCTAssertEqual(abbreviateProfileName("Aa Bb Cc Dd Ee Ff Gg Hh Ii"), "ABCDEFGH")
    }

    func testTwoWordsLowerCase_initialsUppercased() {
        // Long enough (>8) to hit the multi-word path; initials uppercased.
        XCTAssertEqual(abbreviateProfileName("ion developer"), "ID")
    }

    func testMultipleSpacesSeparated_worksCorrectly() {
        // Multiple spaces between words should still split correctly. Use a
        // name >8 chars so the multi-word initials path fires.
        XCTAssertEqual(abbreviateProfileName("Ion  Developer"), "ID")
    }

    func testLeadingTrailingWhitespace_stripped() {
        // Trimmed "Ion Developer" is 13 chars (>8) → multi-word initials.
        XCTAssertEqual(abbreviateProfileName("  Ion Developer  "), "ID")
    }

    // MARK: - Rule 5: single long word → first 8 chars uppercased

    func testEightCharSingleWord_passesThrough() {
        // "Cosmos" is 6 chars (≤8) → unchanged, case preserved.
        XCTAssertEqual(abbreviateProfileName("Cosmos"), "Cosmos")
    }

    func testTenCharSingleWord_firstEightUppercased() {
        // "Enterprise" (10 chars) → "ENTERPRI"
        XCTAssertEqual(abbreviateProfileName("Enterprise"), "ENTERPRI")
    }

    func testMixedCaseLongWord_firstEightUppercased() {
        // "myProfile" (9 chars) → "MYPROFIL"
        XCTAssertEqual(abbreviateProfileName("myProfile"), "MYPROFIL")
    }

    // MARK: - Edge cases

    func testExactly8Chars_passesThrough() {
        // Exactly 8 — pass-through boundary, not abbreviated.
        XCTAssertEqual(abbreviateProfileName("ABCDEFGH"), "ABCDEFGH")
    }

    func testAllUppercaseShort_passesThrough() {
        XCTAssertEqual(abbreviateProfileName("ION"), "ION")
    }

    func testAllUppercaseLong_firstEightUppercased() {
        // "IONDEVELOP" (10 chars) → "IONDEVEL"
        XCTAssertEqual(abbreviateProfileName("IONDEVELOP"), "IONDEVEL")
    }

    func testNumbersInName_passThroughShort() {
        // "Dev 2" is 5 chars (≤8) → passes through unchanged.
        XCTAssertEqual(abbreviateProfileName("Dev 2"), "Dev 2")
    }

    // MARK: - Data-driven gate (#256 follow-up)

    /// The #256 follow-up contract was: resolve the harness label from the
    /// PROFILE-ID DATA, never from the `tab.hasEngineExtension` tab-type flag.
    ///
    /// This used to pin three source strings inside `TabRowView` (the
    /// `harnessBadgeLabel` resolver and its `if harnessBadgeLabel != nil` render
    /// site). The restraint pass removed the badge from the iOS tab row — the
    /// row now carries a title and one subtitle line — so those strings are
    /// gone and pinning them would assert a render site that no longer exists.
    ///
    /// The contract itself is unchanged and still live on the desktop, which
    /// renders the badge via the same `abbreviateProfileName` rules
    /// (`TabStripDropdownTabRow.tsx:89`, `TabStripGroupPill.tsx:69`). What is
    /// portable and worth pinning on iOS is the resolver's BEHAVIOR: an absent
    /// or unresolved profile name yields the "EXT" fallback rather than an
    /// empty label or a crash, which is what let the desktop drop the tab-type
    /// branch. The rule tests above cover the abbreviation itself; this pins
    /// the two fallback paths the data-driven gate depends on.
    func testUnresolvedProfileNameFallsBackToEXT() {
        // A tab carrying a profile id whose profile is not in the list (deleted
        // upstream, or profiles not yet synced) resolves to the sentinel, not
        // to an empty string — the case the tab-type flag used to hide.
        XCTAssertEqual(abbreviateProfileName(nil), "EXT")
        XCTAssertEqual(abbreviateProfileName(""), "EXT")
        XCTAssertEqual(abbreviateProfileName("   "), "EXT")
    }

    /// The iOS tab row must not regrow the badge: it was removed deliberately
    /// in the restraint pass, and re-adding it would put a third register back
    /// into a row that is now title + one subtitle line.
    func testTabRowDoesNotRenderTheHarnessBadge() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/TabRowView.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(
            src.contains("harnessBadge"),
            """
            The harness badge was removed from the iOS tab row in the restraint \
            pass. The desktop still renders it (TabStripDropdownTabRow.tsx, \
            TabStripGroupPill.tsx); iOS shows title + one subtitle line.
            """
        )
    }
}
