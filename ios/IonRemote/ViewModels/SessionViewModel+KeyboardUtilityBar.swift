import Foundation

// MARK: - Keyboard Utility Bar Toggles
//
// Extracted from SessionViewModel.swift per ios/AGENTS.md: the parent
// file is allowlisted with "don't extend; extract". These two computed
// properties were added by commit `acee1738` for the keyboard utility
// bar feature (paste / select all / tab / new line / undo / redo /
// dismiss). They are pure UserDefaults-backed computed properties with
// no internal SessionViewModel state — moving them to an extension
// keeps the parent file under cap and matches the existing
// SessionViewModel+*.swift extension pattern.
//
// Defaults: both bars are on by default so the feature is discoverable;
// the toggles in Settings → Appearance let users opt out per-surface.
// The independence (separate keys for CLI and Engine) preserves the
// original design — a user who finds the bar useful in one context but
// noisy in the other can disable just that surface.

extension SessionViewModel {
    /// Whether the keyboard utility bar (paste / select all / tab / undo /
    /// redo / dismiss) is shown above the CLI/conversation input bar
    /// (`InputBar`). iOS-local, on by default. Independent of the engine
    /// toggle so a user who finds the bar useful in one context but noisy
    /// in the other can disable just that surface.
    var showKeyboardUtilityBarInCLI: Bool {
        get { UserDefaults.standard.object(forKey: "showKeyboardUtilityBarInCLI") == nil
              ? true
              : UserDefaults.standard.bool(forKey: "showKeyboardUtilityBarInCLI") }
        set { UserDefaults.standard.set(newValue, forKey: "showKeyboardUtilityBarInCLI") }
    }

    /// Whether the keyboard utility bar is shown above the engine view's
    /// input bar (`EngineView.engineInputBar`). iOS-local, on by default.
    var showKeyboardUtilityBarInEngine: Bool {
        get { UserDefaults.standard.object(forKey: "showKeyboardUtilityBarInEngine") == nil
              ? true
              : UserDefaults.standard.bool(forKey: "showKeyboardUtilityBarInEngine") }
        set { UserDefaults.standard.set(newValue, forKey: "showKeyboardUtilityBarInEngine") }
    }
}
