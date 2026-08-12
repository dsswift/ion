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
    // Warm orange. This theme has the widest open band of any: statusRunning is
    // cyan (hue 196), so the entire warm spectrum is free except the shared
    // amber. dE 96.4 from running, dE 22.6 from the amber. 9.47:1.
    let statusActiveWarning = Color(red: 255 / 255, green: 170 / 255, blue: 90 / 255)
    // Desaturated steel blue at hue 203 -- the same family as this theme's
    // textTertiary, two steps darker. 3.01:1 on surfaceElevated.
    let gaugeTrack = Color(red: 56 / 255, green: 105 / 255, blue: 136 / 255)
    let statusStaff = Color(red: 178 / 255, green: 150 / 255, blue: 255 / 255)
    // Category tiles vs the white glyph; min pairwise dE 18.3.
    let categoryTileConnection = Color(red: 47 / 255, green: 95 / 255, blue: 191 / 255)   // 5.98:1
    let categoryTileAppearance = Color(red: 106 / 255, green: 79 / 255, blue: 181 / 255)  // 6.18:1
    let categoryTileModels = Color(red: 168 / 255, green: 85 / 255, blue: 32 / 255)       // 5.27:1
    let categoryTileVoice = Color(red: 30 / 255, green: 122 / 255, blue: 80 / 255)        // 5.31:1
    let categoryTileDiagnostics = Color(red: 79 / 255, green: 80 / 255, blue: 88 / 255)   // 8.01:1
    let statusIdle = Color(red: 0x81 / 255, green: 0x81 / 255, blue: 0x88 / 255)
    // Question dot at hue 256 — deliberately violet, outside the 190-215
    // blue-cyan band that statusRunning (196) and statusPending (210) occupy.
    // A third value inside that band would reproduce the collision the
    // statusWaitingChildren note above refused. dE 30.6 from statusPending,
    // dE 52.2 from statusRunning; 7.39:1 on surfaceElevated.
    let statusQuestion = Color(red: 178 / 255, green: 150 / 255, blue: 255 / 255)
    let worktreeDirty = Color(red: 0xC4 / 255, green: 0x70 / 255, blue: 0x60 / 255)
    let surfaceElevated = Color(red: 8 / 255, green: 24 / 255, blue: 44 / 255)
    // The four surface/border/text tokens below mirror palette-hud.ts
    // (surfaceSecondary, containerBgCollapsed, borderSubtle, textTertiary).
    // jarvis-hud is intentionally absent from the parity fixture — its two
    // platform parts are separate renderings of one theme — so these are
    // mapped by hand rather than pinned.
    let surfaceSecondary = Color(red: 8 / 255, green: 22 / 255, blue: 40 / 255).opacity(0.98)
    let surfaceSunken = Color(red: 4 / 255, green: 12 / 255, blue: 26 / 255).opacity(0.96)
    // One rung past surfaceSecondary (+4.98 L*), holding this theme's channel
    // character (blue > green > red at roughly 1:3:5). Opaque, like
    // surfaceElevated. 11.10:1 against the composited textPrimary.
    let surfacePressed = Color(red: 12 / 255, green: 32 / 255, blue: 56 / 255)
    let borderSubtle = Color(red: 51 / 255, green: 195 / 255, blue: 247 / 255).opacity(0.12)
    // Desaturated cyan, NOT the accent. borderStrong marks focus and selection,
    // and painting it in the full-saturation accent would make every selected
    // row read as though it carried an accent affordance. 7.71:1 on
    // surfaceElevated; borderSubtle is the same hue family at 12% alpha, so this
    // reads as that border system turned up.
    let borderStrong = Color(red: 122 / 255, green: 178 / 255, blue: 205 / 255)
    // 1.12:1 composited over surfaceElevated — the darkest of the four dark
    // themes and nowhere near dimming, so the sheet takes a 1pt borderStrong
    // outline and this stays hit-testing only.
    let overlayScrim = Color(red: 0, green: 0, blue: 0).opacity(0.6)
    let textTertiary = Color(red: 80 / 255, green: 150 / 255, blue: 195 / 255).opacity(0.55)
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
