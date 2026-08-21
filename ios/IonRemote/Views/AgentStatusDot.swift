import SwiftUI

/// Canonical status dot for one agent dispatch. Every dot surface uses same
/// pulse and waiting-children glow so status does not change with placement.
struct AgentStatusDot: View {
    let dot: AgentDot
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(dot.color)
            .frame(width: size, height: size)
            .modifier(AgentStatusDotPulse(active: dot.pulses))
            .shadow(
                color: dot.glows ? dot.color.opacity(0.6) : .clear,
                radius: dot.glows ? 3 : 0
            )
    }
}

/// Slow live-status pulse. Matches desktop `.animate-pulse-dot` behavior.
private struct AgentStatusDotPulse: ViewModifier {
    let active: Bool
    @State private var dimmed = false

    func body(content: Content) -> some View {
        if active {
            content
                .opacity(dimmed ? 0.45 : 1.0)
                .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: dimmed)
                .onAppear { dimmed = true }
        } else {
            content
        }
    }
}
