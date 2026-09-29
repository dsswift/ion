import SwiftUI

/// Where projected setting rows read their values and send their saves.
///
/// Unset (the default), rows read the connected server's snapshot and save
/// through `SessionViewModel.setServerSetting`, which keeps the phone's own
/// Personal and Device values on the phone. A server's settings pages set it
/// to that server's `ServerAdminSession`, so the rows work for a server the
/// phone is not chatting on.
struct ProjectedSettingsSource {
    let state: @MainActor () -> ServerSettingsState?
    let write: @MainActor (_ key: String, _ value: AnyCodable) -> Void

    /// Reads and saves through one server's admin session. A refused or
    /// failed save is logged; the next snapshot puts the row back.
    @MainActor
    static func server(_ session: ServerAdminSession) -> ProjectedSettingsSource {
        ProjectedSettingsSource(
            state: { session.settings },
            write: { key, value in
                Task {
                    do {
                        try await session.setSetting(key: key, value: value)
                    } catch {
                        DiagnosticLog.log("projected setting save failed", tag: "settings", level: .warn, fields: [
                            "server_id": session.serverId, "key": key, "error": String(describing: error)
                        ])
                    }
                }
            }
        )
    }
}

extension EnvironmentValues {
    @Entry var projectedSettingsSource: ProjectedSettingsSource?
}
