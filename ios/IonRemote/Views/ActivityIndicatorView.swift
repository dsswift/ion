import SwiftUI

/// Bouncing-dots activity indicator with a text label.
/// Mirrors the desktop's ConversationView activity row (three staggered
/// bouncing dots + currentActivity text like "Thinking…" or "Running Bash…").
struct ActivityIndicatorView: View {
    let text: String
    var dotColorOverride: Color? = nil

    private let dotSize: CGFloat = 5 // matches desktop 4×4px dots (bumped to 5 for mobile)
    private let defaultDotColor = Color(hex: 0xE8854A) // matches desktop statusRunning

    private var dotColor: Color { dotColorOverride ?? defaultDotColor }

    var body: some View {
        HStack(spacing: 6) {
            HStack(spacing: 3) {
                BouncingDot(delay: 0.0, size: dotSize, color: dotColor)
                BouncingDot(delay: 0.15, size: dotSize, color: dotColor)
                BouncingDot(delay: 0.30, size: dotSize, color: dotColor)
            }

            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(Color(.tertiarySystemFill)))
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
    }
}

// MARK: - BouncingDot

/// A single dot that gently pops upward and settles back down,
/// matching the desktop's `bounce-dot` CSS keyframes:
///   0%,80%,100% → translateY(0)   40% → translateY(-4px)
///   Total cycle: 1.2s ease-in-out infinite
///
/// SwiftUI doesn't support multi-stop keyframes natively, so we
/// use a TimelineView ticking at ~60fps to compute the Y offset
/// from the same easing curve the CSS animation uses.
private struct BouncingDot: View {
    let delay: Double
    let size: CGFloat
    let color: Color

    var body: some View {
        TimelineView(.animation) { timeline in
            let offset = Self.yOffset(date: timeline.date, delay: delay)
            Circle()
                .fill(color)
                .frame(width: size, height: size)
                .offset(y: offset)
        }
    }

    /// Compute the Y offset for a given moment, replicating the CSS:
    ///   0%–40%: ease from 0 to -4
    ///   40%–80%: ease from -4 to 0
    ///   80%–100%: hold at 0
    private static func yOffset(date: Date, delay: Double) -> CGFloat {
        let cycle = 1.2 // seconds — matches desktop
        let peak: CGFloat = -4.5

        // Seconds since reference, shifted by per-dot stagger
        let t = (date.timeIntervalSinceReferenceDate - delay)
            .truncatingRemainder(dividingBy: cycle)
        let progress = (t < 0 ? t + cycle : t) / cycle // 0…1

        if progress < 0.4 {
            // Rising: 0 → peak over first 40%
            let p = progress / 0.4
            return peak * CGFloat(ease(p))
        } else if progress < 0.8 {
            // Falling: peak → 0 over next 40%
            let p = (progress - 0.4) / 0.4
            return peak * (1 - CGFloat(ease(p)))
        } else {
            // Rest at 0 for the final 20%
            return 0
        }
    }

    /// Simple ease-in-out (sine-based, same feel as CSS ease-in-out).
    private static func ease(_ t: Double) -> Double {
        (1 - cos(t * .pi)) / 2
    }
}
