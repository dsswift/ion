import Foundation

extension ThemeManager {
    /// The preference the theme policy seeds, as the watermark names it.
    static let themeManagedDefaultPreference = "selectedTheme"

    /// Apply the enterprise theme policy from a settings snapshot.
    ///
    /// Two separate channels. A locked policy goes to the enforced slot, which
    /// overrides rendering and leaves the person's selection untouched. An
    /// unlocked policy is a managed default: it overwrites the selection when
    /// its value differs from the last one applied from this source, and
    /// never touches the enforced slot. A nil `themeId` is no policy.
    ///
    /// - Parameter source: The server the policy came from.
    func applyThemePolicy(
        themeId: String?,
        locked: Bool,
        source: String?,
        watermarks: ManagedDefault.Watermarks = ManagedDefault.Watermarks()
    ) {
        setEnforcedTheme(locked ? themeId : nil)

        let applied = watermarks.applied(preference: Self.themeManagedDefaultPreference, source: source)
        guard let themeId,
              ManagedDefault.decide(policyValue: themeId, locked: locked, applied: applied) == .apply else { return }
        DiagnosticLog.log("managed default theme applied; selection overwritten", tag: "theme.manager", fields: [
            "reason": selectedThemeId,
            "status": themeId
        ])
        selectedThemeId = themeId
        watermarks.record(themeId, preference: Self.themeManagedDefaultPreference, source: source)
    }
}
