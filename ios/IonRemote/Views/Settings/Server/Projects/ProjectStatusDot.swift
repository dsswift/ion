import SwiftUI

/// The small dot a project or job row leads with.
struct ProjectStatusDot: View {
    let status: ProjectRowStatus

    var body: some View {
        Circle()
            .fill(Self.color(status.dot))
            .frame(width: 8, height: 8)
            .accessibilityLabel(status.dotLabel)
    }

    static func color(_ tone: ProjectRowStatus.Tone) -> Color {
        switch tone {
        case .ok: return .green
        case .warn: return .orange
        case .error: return .red
        case .muted: return .secondary
        }
    }
}
