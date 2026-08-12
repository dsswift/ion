import SwiftUI

// MARK: - IonTheme

/// Centralized design tokens — spacing, radii, animations, typography.
///
/// Color tokens do NOT live here. Every view reads colors from the
/// `appTheme` environment value (see `AppTheme.swift`), and the tab-status
/// dot cascade reads the theme-independent constants on
/// `TabStatusRollup`. The retired system-adaptive "Ion Default" color
/// block that used to sit in this enum had no remaining references and was
/// removed rather than left to drift out of step with the real palettes.
enum IonTheme {

    // MARK: Spacing
    //
    // SUPERSEDED by `IonSpace`. These six size-named constants are the same
    // values as the `IonSpace` roles, but named for how big they are rather
    // than what they are for, which is why call sites skipped them. They stay
    // declared only because live call sites still reference them; surface
    // conversion retires them. New code uses `IonSpace.rowInset` and friends.

    static let xs: CGFloat = 4
    static let sm: CGFloat = 8
    static let md: CGFloat = 12
    static let lg: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32

    // MARK: Radii
    //
    // SUPERSEDED by `IonRadius`, which collapses this four-step scale to three
    // (`control` 8, `container` 12, `sheet` 20) and drops 16pt. Kept declared
    // for live call sites only; new code uses `IonRadius`.

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

    /// The one place the JetBrains Mono face is named. Both overloads below
    /// resolve it; nothing else in the app should reference the font name.
    private static let codeFontName = "JetBrainsMonoNLNerdFontMono-Regular"

    /// Returns JetBrains Mono at the given size, falling back to system monospaced.
    ///
    /// This overload pins a point size and does NOT participate in Dynamic
    /// Type. It remains for the existing call sites that predate the type
    /// scale. New code takes the `relativeTo:` overload below, or the `mono`
    /// role on `IonType`, which is what the style guide requires of shipping
    /// text.
    static func codeFont(size: CGFloat = 14) -> Font {
        .custom(codeFontName, size: size)
    }

    /// Returns JetBrains Mono at the given size, scaling with the named text
    /// style. This is the Dynamic Type path, and it is what `IonType.mono`
    /// calls — the role reuses this single load rather than registering the
    /// face a second time.
    static func codeFont(size: CGFloat, relativeTo style: Font.TextStyle) -> Font {
        .custom(codeFontName, size: size, relativeTo: style)
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

/// Flat themed container. Surface and border carry separation; material,
/// highlights, and shadows do not belong to instrument containers.
struct CardStyle: ViewModifier {
    @Environment(\.appTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background(theme.surfaceElevated)
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.sheet))
            .overlay(RoundedRectangle(cornerRadius: IonRadius.sheet).stroke(theme.borderSubtle, lineWidth: 1))
    }
}

extension View {
    func cardStyle() -> some View {
        modifier(CardStyle())
    }
}
