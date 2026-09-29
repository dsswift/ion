import SwiftUI

/// Green when connected, orange when the last attempt failed, grey otherwise.
struct McpConnectionDot: View {
    let server: McpServerStatus

    var body: some View {
        Circle()
            .fill(server.connected ? Color.green : (server.lastError == nil ? Color.secondary : Color.orange))
            .frame(width: 8, height: 8) // design-geometry: status dot, matches the other admin status dots
            .accessibilityLabel(McpServerText.connection(server))
    }
}
