import SwiftUI

/// One MCP server in the list: name with its connection dot, transport,
/// whether it is authorized, and how many tools it offers.
struct McpServerRow: View {
    let server: McpServerStatus

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            HStack(spacing: IonSpace.compactGap) {
                McpConnectionDot(server: server)
                Text(server.name).font(.body)
                Spacer(minLength: IonSpace.compactGap)
                if let transport = server.transport, !transport.isEmpty {
                    Text(transport).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            HStack(spacing: IonSpace.compactGap) {
                Text(server.authenticated ? "Authorized" : "Not authorized")
                    .foregroundStyle(server.authenticated ? .green : .secondary)
                if let tools = McpServerText.toolCount(server) {
                    Text("·").foregroundStyle(.tertiary)
                    Text(tools).foregroundStyle(.secondary)
                }
            }
            .font(.caption)
        }
        .accessibilityElement(children: .combine)
    }
}
