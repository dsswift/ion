import Foundation

/// FR-02 presence UI state, held as one value so it can live in an extension
/// of the observable view model (Swift forbids stored properties in
/// extensions; `SessionViewModel` is `@Observable`, not `ObservableObject`,
/// so there is no `@Published` wrapper either -- see `WorktreeUIState` for
/// the same pattern).
struct PresenceUIState {
    /// Every connected principal (studio AND remote devices) and their tab
    /// focus.
    var entries: [PresenceEntry] = []
    /// `tabId -> subject` for every tab currently being driven.
    var driving: [String: String] = [:]
}

extension SessionViewModel {

    var presenceEntries: [PresenceEntry] {
        get { presenceUI.entries }
        set { presenceUI.entries = newValue }
    }

    var presenceDriving: [String: String] {
        get { presenceUI.driving }
        set { presenceUI.driving = newValue }
    }

    /// Full replace on every `desktop_presence` push -- no incremental merge,
    /// matching the server's broadcast-a-full-snapshot semantics.
    func handlePresence(entries: [PresenceEntry], driving: [String: String]) {
        presenceEntries = entries
        presenceDriving = driving
        DiagnosticLog.log("presence updated", tag: "presence",
                          fields: ["entries": String(entries.count), "driving": String(driving.count)])
    }

    /// Every connection currently focused on `tabId`. iOS has no notion of
    /// "this device's own subject" the way the desktop presence store does
    /// (that identity lives server-side, in the paired-device record) --
    /// the tab row filters this list against its own device state
    /// separately where that distinction matters.
    func presenceFocusedOn(_ tabId: String) -> [PresenceEntry] {
        presenceEntries.filter { $0.focusedTabId == tabId }
    }

    /// The subject driving `tabId`, if any.
    func drivingSubject(forTab tabId: String) -> String? {
        presenceDriving[tabId]
    }
}
