import SwiftUI

/// The "Allow conversation intercepts" preference, kept in `UserDefaults`
/// under `interceptEnabled` (default on). A change is sent to the connected
/// server at once as a focus report, so it applies without waiting for the
/// next conversation switch.
struct InterceptToggleSection: View {
    @Environment(SessionViewModel.self) private var viewModel

    static let defaultsKey = "interceptEnabled"

    var body: some View {
        Section {
            Toggle(isOn: Binding(
                get: { UserDefaults.standard.object(forKey: Self.defaultsKey) as? Bool ?? true },
                set: { newValue in
                    UserDefaults.standard.set(newValue, forKey: Self.defaultsKey)
                    DiagnosticLog.log("intercept preference changed", tag: "view.settings", fields: ["enabled": String(newValue)])
                    viewModel.sendReportFocus(tabId: viewModel.focusedTabId)
                }
            )) {
                Text("Allow conversation intercepts")
            }
        } header: {
            Text("Alerts")
        } footer: {
            Text("When on, background automations can redirect your active conversation with an urgent alert. Turn off to receive only passive banners.")
        }
    }
}
