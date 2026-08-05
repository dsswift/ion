import SwiftUI

// MARK: - JarvisArcReactorTheme

/// Arc reactor aesthetic. Forces dark mode. Uses animated concentric
/// rings as the background and a scan-line activity indicator.
///
/// This is the iOS part of the cross-platform `jarvis-hud` theme: the
/// desktop part (`palette-hud.ts`) and this one share the theme id but
/// deliberately differ in rendering — one theme, two platform-native
/// looks. The id is unified so enterprise enforcement and the theme
/// registry treat them as a single theme.
struct JarvisArcReactorTheme: AppTheme {
    let id = "jarvis-hud"
    let displayName = "Jarvis HUD"

    let accent = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255)
    let accentSubtle = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255).opacity(0.12)
    var accentGlow: Color { accent.opacity(0.18) }
    var background: Color { Color(red: 4/255, green: 14/255, blue: 28/255) }
    var textPrimary: Color { Color(red: 190/255, green: 235/255, blue: 255/255).opacity(0.92) }
    var textSecondary: Color { Color(red: 190/255, green: 235/255, blue: 255/255).opacity(0.55) }
    let statusRunning = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255).opacity(0.85)
    let statusDone = Color.green
    let statusError = Color(red: 0xC4 / 255, green: 0x70 / 255, blue: 0x60 / 255)
    let statusPending = Color(red: 0x4A / 255, green: 0x9E / 255, blue: 0xF5 / 255)
    // "Awaiting children" — keep amber even in the HUD theme so the
    // foreground (cyan) vs. background (amber) distinction stays
    // legible. A second cyan-tinted dot would collide with statusRunning
    // at a glance, defeating the visual vocabulary the dot establishes
    // on the desktop and the other built-in themes.
    let statusWaitingChildren = Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)
    let statusBash = Color(red: 0xFF / 255, green: 0x2D / 255, blue: 0x95 / 255)
    // "Mixed failure" — same amber as statusWaitingChildren so the
    // amber = advisory vocabulary holds across themes.
    let statusWarning = Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)
    let statusIdle = Color(red: 0x81 / 255, green: 0x81 / 255, blue: 0x88 / 255)
    let worktreeDirty = Color(red: 0xC4 / 255, green: 0x70 / 255, blue: 0x60 / 255)
    let surfaceElevated = Color(red: 8 / 255, green: 24 / 255, blue: 44 / 255)
    let codeBg = Color(red: 4 / 255, green: 14 / 255, blue: 28 / 255).opacity(0.8)
    let userBubbleTint = Color(red: 10 / 255, green: 36 / 255, blue: 60 / 255)
    // Syntax tokens — HUD cyan/amber family, mirroring the desktop
    // palette-hud.ts values. jarvis-hud is intentionally absent from the
    // parity fixture (two-part theme), but the two halves still share one
    // code color vocabulary.
    let codeKeyword = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255)
    let codeString = Color(red: 0x7F / 255, green: 0xD9 / 255, blue: 0x8C / 255)
    let codeNumber = Color(red: 0xF5 / 255, green: 0xB9 / 255, blue: 0x42 / 255)
    let codeComment = Color(red: 0x5C / 255, green: 0x6B / 255, blue: 0x73 / 255)
    let codeFunction = Color(red: 0x8A / 255, green: 0xD8 / 255, blue: 0xF8 / 255)
    let codeType = Color(red: 0x4E / 255, green: 0xC9 / 255, blue: 0xB0 / 255)
    let codeVariable = Color(red: 0xF2 / 255, green: 0xA9 / 255, blue: 0xA2 / 255)
    let codeOperator = Color(red: 0xA8 / 255, green: 0xB8 / 255, blue: 0xC0 / 255)

    let preferredColorScheme: ColorScheme? = .dark

    var backgroundView: AnyView? {
        AnyView(ArcReactorBackground())
    }

    var activityIndicator: ((Bool) -> AnyView)? {
        { isActive in AnyView(ThinkingScanLine(isActive: isActive)) }
    }
}
