import Foundation

// MARK: - Harness badge helpers
//
// The harness badge is a small text chip showing an abbreviated profile name,
// so the user can see at a glance which harness is running — useful when
// multiple engine-tab profiles are open side by side.
//
// Mirrors `abbreviateProfileName` in desktop's TabStripShared.ts (commit #256).
// The abbreviation rules are intentionally identical so the badge reads the
// same wherever it is rendered.
//
// Render sites: the DESKTOP tab strip (TabStripDropdownTabRow.tsx,
// TabStripGroupPill.tsx). The iOS tab row rendered it until the restraint pass,
// which reduced the row to a title plus one subtitle line; this helper stays
// because the abbreviation rules are shared contract with the desktop and are
// pinned by EngineHarnessBadgeTests.
//
// Visibility gate: DATA presence, not a tab-type flag. A badge renders iff a
// profile name resolves, which is driven by the tab having an `engineProfileId`.
// #256 moved the gate off the `tab.hasEngineExtension` boolean — the two are
// equivalent today (the desktop sets `hasEngineExtension` iff
// `engineProfileId != nil`), but keying off the data keeps the badge free of a
// tab-type code fork: a plain conversation carries no profile id and so shows no
// badge, purely because it lacks the data, not because of a branch on tab type.

/// Abbreviate a profile name to at most 8 characters for the harness badge.
///
/// Rules (applied in order, matching desktop TabStripShared.ts):
///  1. Nil/empty name → "EXT"
///  2. Strip leading/trailing whitespace.
///  3. Stripped name ≤ 8 chars → return as-is (e.g. "COS"->"COS", "Orion"->"Orion", "ion-dev"->"ion-dev").
///  4. Multiple words → take first letter of each word, uppercase, cap at 8
///     (e.g. "Ion Dev"->"ID", "My Long Name X"->"MLN").
///  5. Single long word → first 8 chars uppercased (e.g. "Cosmos"->"COSMOS").
///
/// This function is `static` and pure so it can be tested without a view model.
func abbreviateProfileName(_ name: String?) -> String {
    guard let name, !name.isEmpty else { return "EXT" }
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return "EXT" }
    // Rule 3: short names pass through unchanged (preserves case, e.g. "Orion")
    if trimmed.count <= 8 { return trimmed }
    // Rule 4: multi-word initials
    let words = trimmed.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
    if words.count > 1 {
        let initials = words.compactMap { $0.first.map { String($0).uppercased() } }.joined()
        return String(initials.prefix(8))
    }
    // Rule 5: single long word, first 8 chars uppercased
    return String(trimmed.prefix(8)).uppercased()
}
