import SwiftUI

/// Circular context-usage meter. The iOS counterpart of the desktop's
/// `ContextRadial` (StatusBarContextRadial.tsx) — same clamp semantics and the
/// same thresholds, so the two clients cannot disagree about what a given
/// occupancy means. The pixel size is tuned per platform: the desktop uses 16
/// against 11-12px Phosphor glyphs, while this sits beside SF Symbols at
/// .caption2, which are not CSS pixels.
///
/// The caller owns the tap target and the accessibility label; this renders
/// geometry only.
struct ContextUsageRing: View {
    /// True occupancy percentage. UNBOUNDED — may exceed 100.
    let percent: Double
    let color: Color
    var size: CGFloat = 18
    @Environment(\.appTheme) private var theme

    var body: some View {
        ZStack {
            Circle()
                .stroke(theme.gaugeTrack, lineWidth: Self.lineWidth)
            Circle()
                .trim(from: 0, to: Self.trimFraction(percent))
                .stroke(color, style: StrokeStyle(lineWidth: Self.lineWidth, lineCap: .round))
                // -90° so 0% starts at 12 o'clock and fills clockwise.
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.4), value: percent)
        }
        .frame(width: size, height: size)
    }

    static let lineWidth: CGFloat = 2.5

    /// Arc length for a given percentage, as a 0...1 fraction of the circle.
    ///
    /// The percentage is clamped HERE and only here: a ring physically cannot
    /// draw 220% of itself, so an over-budget conversation renders as a full
    /// ring in the danger color. The true uncapped figure rides the
    /// accessibility label and the status drawer — the clamp is a geometry
    /// constraint, never a truth constraint.
    static func trimFraction(_ percent: Double) -> Double {
        return min(max(percent / 100.0, 0), 1)
    }

    /// Threshold key for a given percentage. Returned as a semantic key
    /// rather than a Color so this stays testable without a view hierarchy.
    /// Mirrors the desktop's `radialLevel`.
    ///
    /// This is the ONE threshold ladder on the iOS side. Every surface that
    /// colors an occupancy figure — the status-bar ring, the context strip —
    /// goes through `level(_:)` and `color(for:)` below. They previously each
    /// carried their own copy of the 80/60 ladder and had already drifted on
    /// the normal-state color, so the strip and the ring directly above it
    /// showed different colors at the same occupancy.
    enum Level {
        case normal, warning, danger
    }

    static func level(_ percent: Double) -> Level {
        if percent >= 80 { return .danger }
        if percent >= 60 { return .warning }
        return .normal
    }

    /// Level → Color, resolved once so no consumer re-derives it.
    static func color(for percent: Double) -> Color {
        switch level(percent) {
        case .danger: return .red
        case .warning: return .orange
        case .normal: return .secondary
        }
    }
}
