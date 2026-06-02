import SwiftUI

// MARK: - IonTheme

/// Centralized design tokens — single source of truth for the entire app.
///
/// Color tokens here reflect the Ion Default palette and are kept for
/// backward compatibility with views that reference `IonTheme.accent`
/// directly. Theme-aware views should read colors from the `appTheme`
/// environment value instead (see `AppTheme.swift`).
enum IonTheme {

    // MARK: Colors
    // These also available via @Environment(\.appTheme) for theme-aware views.

    static let accent = Color(hex: 0x4ECDC4)
    static let accentSubtle = Color(hex: 0x4ECDC4, opacity: 0.12)
    static let surfaceElevated = Color(.tertiarySystemBackground)
    static let codeBg = Color(.secondarySystemFill).opacity(0.7)
    static let userBubbleTint = Color(hex: 0x4ECDC4).opacity(0.08)

    static let statusRunning = Color(hex: 0xE8854A)
    static let statusDone = Color.green
    static let statusError = Color.red
    static let statusPending = Color.orange

    // MARK: Spacing

    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32

    // MARK: Radii

    enum Radius {
        static let small: CGFloat = 8
        static let medium: CGFloat = 12
        static let large: CGFloat = 16
        static let card: CGFloat = 20
    }

    // MARK: Animations

    static let snappySpring = Animation.spring(.snappy)
    static let gentleSpring = Animation.spring(.bouncy)

    // MARK: Typography

    /// Returns JetBrains Mono at the given size, falling back to system monospaced.
    static func codeFont(size: CGFloat = 14) -> Font {
        .custom("JetBrainsMonoNLNerdFontMono-Regular", size: size)
    }
}

// MARK: - Haptic

/// Centralized haptic feedback — replaces per-file `triggerHaptic()` calls.
enum Haptic {
    static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}

// MARK: - CardStyle ViewModifier

/// Apple-like card: regular material, soft shadow, rounded corners, top-edge highlight.
struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.card))
            .overlay(
                RoundedRectangle(cornerRadius: IonTheme.Radius.card)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
                    .mask(
                        LinearGradient(
                            colors: [.white, .clear],
                            startPoint: .top,
                            endPoint: .center
                        )
                    )
            )
            .shadow(color: .black.opacity(0.2), radius: 12, y: 6)
    }
}

extension View {
    func cardStyle() -> some View {
        modifier(CardStyle())
    }
}
