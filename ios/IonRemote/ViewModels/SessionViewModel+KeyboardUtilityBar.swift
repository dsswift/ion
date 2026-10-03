import Foundation

// MARK: - Keyboard Utility Bar Toggle
//
// Extracted from SessionViewModel.swift per ios/AGENTS.md: the parent
// file is allowlisted with "don't extend; extract". A pure
// UserDefaults-backed computed property with no internal SessionViewModel
// state, so it lives in an extension like the other SessionViewModel+*.swift
// files.
//
// One toggle, one surface. There used to be two keys, one for the CLI input
// bar and one for the engine view, from when those were two views. Since the
// #256 merge every non-terminal conversation renders through one
// ConversationView with one composer, so the second key had no consumer and
// the two Settings rows controlled the same strip.

extension SessionViewModel {
    /// Whether the keyboard utility bar (paste / select all / tab / new line /
    /// undo / redo / dismiss) is shown above the composer while the keyboard
    /// is up. iOS-local, on by default so the feature is discoverable.
    ///
    /// Persisted under the key the engine-view toggle used, so a phone that
    /// had switched the bar off keeps it off across this consolidation. The
    /// retired CLI key is read once as a fallback for the same reason.
    var showKeyboardUtilityBar: Bool {
        get {
            let defaults = UserDefaults.standard
            if defaults.object(forKey: Self.keyboardUtilityBarKey) != nil {
                return defaults.bool(forKey: Self.keyboardUtilityBarKey)
            }
            if defaults.object(forKey: Self.legacyCLIKeyboardUtilityBarKey) != nil {
                return defaults.bool(forKey: Self.legacyCLIKeyboardUtilityBarKey)
            }
            return true
        }
        set { UserDefaults.standard.set(newValue, forKey: Self.keyboardUtilityBarKey) }
    }

    static let keyboardUtilityBarKey = "showKeyboardUtilityBarInEngine"
    static let legacyCLIKeyboardUtilityBarKey = "showKeyboardUtilityBarInCLI"
}
