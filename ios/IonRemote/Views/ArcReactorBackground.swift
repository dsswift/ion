import SwiftUI

// MARK: - ArcReactorBackground

/// Animated concentric rings inspired by the Jarvis arc reactor aesthetic.
/// Used as the full-screen background for JarvisArcReactorTheme.
struct ArcReactorBackground: View {
    @Environment(\.appTheme) private var theme
    @State private var outerRotation: Double = 0
    @State private var innerRotation: Double = 0
    @State private var glowPulse: Double = 0.75

    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height) * 0.88
            ZStack {
                // Outermost faint ring
                Circle()
                    .stroke(theme.accent.opacity(0.18), lineWidth: 1)
                    .frame(width: size, height: size)

                // Outer dashed ring — rotates slowly clockwise
                Circle()
                    .trim(from: 0, to: 0.72)
                    .stroke(
                        theme.accent.opacity(0.40),
                        style: StrokeStyle(lineWidth: 1.5, dash: [6, 5])
                    )
                    .frame(width: size * 0.84, height: size * 0.84)
                    .rotationEffect(.degrees(outerRotation))

                // Second solid ring
                Circle()
                    .stroke(theme.accent.opacity(0.22), lineWidth: 1)
                    .frame(width: size * 0.70, height: size * 0.70)

                // 8 radial spoke marks from the second ring
                ForEach(0..<8) { i in
                    Capsule()
                        .fill(theme.accent.opacity(0.30))
                        .frame(width: 1.5, height: size * 0.06)
                        .offset(y: -(size * 0.70 / 2) + (size * 0.03))
                        .rotationEffect(.degrees(Double(i) * 45))
                }

                // Inner dashed ring — counter-rotates
                Circle()
                    .trim(from: 0, to: 0.6)
                    .stroke(
                        theme.accent.opacity(0.60),
                        style: StrokeStyle(lineWidth: 2, dash: [10, 6])
                    )
                    .frame(width: size * 0.52, height: size * 0.52)
                    .rotationEffect(.degrees(innerRotation))

                // 6 triangular spoke marks (shorter, near core)
                ForEach(0..<6) { i in
                    Capsule()
                        .fill(theme.accent.opacity(0.50))
                        .frame(width: 2, height: size * 0.07)
                        .offset(y: -(size * 0.52 / 2) + (size * 0.035))
                        .rotationEffect(.degrees(Double(i) * 60))
                }

                // Core glow (radial gradient)
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                theme.accent.opacity(glowPulse),
                                theme.accent.opacity(0.0),
                            ],
                            center: .center,
                            startRadius: 0,
                            endRadius: size * 0.18
                        )
                    )
                    .frame(width: size * 0.36, height: size * 0.36)

                // Core ring
                Circle()
                    .stroke(theme.accent.opacity(0.80), lineWidth: 2)
                    .frame(width: size * 0.20, height: size * 0.20)

                // Inner core fill
                Circle()
                    .fill(theme.accent.opacity(0.30))
                    .frame(width: size * 0.18, height: size * 0.18)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .onAppear {
            withAnimation(.linear(duration: 28).repeatForever(autoreverses: false)) {
                outerRotation = 360
            }
            withAnimation(.linear(duration: 18).repeatForever(autoreverses: false)) {
                innerRotation = -360
            }
            withAnimation(.easeInOut(duration: 3).repeatForever(autoreverses: true)) {
                glowPulse = 0.40
            }
        }
    }
}

#Preview {
    let tm = ThemeManager()
    tm.selectedThemeId = "jarvis-arc-reactor"
    return ArcReactorBackground()
        .frame(width: 400, height: 400)
        .background(Color(red: 4 / 255, green: 14 / 255, blue: 28 / 255))
        .environment(\.appTheme, tm)
}
