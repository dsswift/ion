import SwiftUI

/// A single agent bar row matching the desktop OvalOffice layout.
/// Shows a colored label, status indicator, and last work preview.
struct AgentBarRow: View {
    let agent: AgentStateUpdate
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                // Colored type label
                Text(agent.displayName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(agentColor.opacity(0.85))
                    .clipShape(Capsule())

                // Status + elapsed
                HStack(spacing: 4) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 6, height: 6)
                    Text(agent.status)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let elapsed = agent.elapsed {
                        Text("\(Int(elapsed))s")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer()

                // Last work preview (truncated)
                if let lastWork = agent.lastWork, !lastWork.isEmpty, !isExpanded {
                    Text(lastWork)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 160, alignment: .trailing)
                }
            }

            // Expanded full output
            if isExpanded, let fullOutput = agent.fullOutput, !fullOutput.isEmpty {
                Text(fullOutput)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                    .padding(.leading, 4)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(.systemGray6).opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { isExpanded.toggle() }
    }

    private var agentColor: Color {
        if let hex = agent.color {
            return Color(hex: hex)
        }
        switch agent.type {
        case "chief": return .orange
        case "specialist": return .blue
        case "staff": return .purple
        case "consultant": return .green
        default: return .gray
        }
    }

    private var statusColor: Color {
        switch agent.status {
        case "running": return .orange
        case "done": return .green
        case "error": return .red
        default: return .gray
        }
    }
}

// MARK: - Color hex initializer

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        let r = Double((rgb >> 16) & 0xFF) / 255
        let g = Double((rgb >> 8) & 0xFF) / 255
        let b = Double(rgb & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}
