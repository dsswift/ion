import SwiftUI

/// Two overlapping status dots: the subject in focus over the aggregate of
/// everything else.
///
/// SwiftUI counterpart of the desktop `StatusDotStack`
/// (renderer/components/TabStripStatusDot.tsx). The foreground dot carries a
/// ring in the row's surface color so it reads distinctly from the background
/// dot it partially covers, and the negative overlap keeps the pair's footprint
/// close to a single dot.
///
/// Used by the agent row, where the foreground describes the most recent
/// dispatch and the background aggregates the earlier ones — so a finished
/// recent dispatch cannot hide an older one still waiting on a live agent.
struct AgentStatusDotStack: View {
    let foreground: AgentDot
    let background: AgentDot
    /// Surface behind the row, used as the foreground dot's separator ring.
    let ringColor: Color
    var size: CGFloat = 8

    var body: some View {
        HStack(spacing: -(size / 2)) {
            dot(background)
                .zIndex(1)
            dot(foreground)
                .overlay(Circle().strokeBorder(ringColor, lineWidth: 1.5))
                .zIndex(2)
        }
        .fixedSize()
    }

    private func dot(_ layer: AgentDot) -> some View {
        AgentStatusDot(dot: layer, size: size)
    }
}
