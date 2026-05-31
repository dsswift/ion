import SwiftUI

// MARK: - JarvisArcReactorTheme

/// Arc reactor aesthetic. Forces dark mode. Uses animated concentric
/// rings as the background and a scan-line activity indicator.
struct JarvisArcReactorTheme: AppTheme {
    let id = "jarvis-arc-reactor"
    let displayName = "Jarvis Arc Reactor"

    let accent = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255)
    let accentSubtle = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255).opacity(0.12)
    let statusRunning = Color(red: 0x33 / 255, green: 0xC3 / 255, blue: 0xF7 / 255).opacity(0.85)
    let statusDone = Color.green
    let statusError = Color(red: 0xC4 / 255, green: 0x70 / 255, blue: 0x60 / 255)
    let statusPending = Color(red: 0x4A / 255, green: 0x9E / 255, blue: 0xF5 / 255)
    let surfaceElevated = Color(red: 8 / 255, green: 24 / 255, blue: 44 / 255)
    let codeBg = Color(red: 4 / 255, green: 14 / 255, blue: 28 / 255).opacity(0.8)
    let userBubbleTint = Color(red: 10 / 255, green: 36 / 255, blue: 60 / 255)

    let preferredColorScheme: ColorScheme? = .dark

    var backgroundView: AnyView? {
        AnyView(ArcReactorBackground())
    }

    var activityIndicator: ((Bool) -> AnyView)? {
        { isActive in AnyView(ThinkingScanLine(isActive: isActive)) }
    }
}
