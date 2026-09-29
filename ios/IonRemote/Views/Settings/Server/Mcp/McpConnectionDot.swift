import SwiftUI

/// Done-colored when connected, warning-colored when the last attempt failed, idle otherwise.
struct McpConnectionDot: View {
    @Environment(\.appTheme) private var theme
    let server: McpServerStatus

    var body: some View {
        Circle()
            .fill(server.connected ? theme.statusDone : (server.lastError == nil ? theme.statusIdle : theme.statusWarning))
            .frame(width: 8, height: 8) // design-geometry: status dot, matches the other admin status dots
            .accessibilityLabel(McpServerText.connection(server))
    }
}
