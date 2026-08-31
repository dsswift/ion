import SwiftUI

/// The default series colors for a chart, drawn from the active theme.
///
/// Mirrors `defaultSeriesColors` in
/// `desktop/src/renderer/components/conversation/chart-config.ts`: colors come
/// from the theme rather than a hardcoded list, so a chart matches the
/// conversation around it in every theme. The ORDER is what matters and is
/// held identical across clients — series one is the accent on both, series
/// two is the running tint on both, and so on. A user who renders a chart on
/// the desktop and opens it on the phone sees the same series in the same
/// colors.
///
/// Two of the desktop's eight tokens have no iOS counterpart
/// (`statusComplete`/`statusCompacting` vs iOS `statusDone`/`statusPending`,
/// and iOS has no `statusAsync`). The nearest equivalent token is used in the
/// same slot rather than a hardcoded hex, which keeps the sequence aligned and
/// keeps every color theme-derived.
enum ChartPalette {

    /// Series colors in assignment order. Chosen for adjacent-hue separation:
    /// three series get three clearly different colors with no model input.
    static func series(_ theme: any AppTheme) -> [Color] {
        [
            theme.accent,
            theme.statusRunning,
            theme.statusDone,
            theme.statusQuestion,
            theme.statusBash,
            theme.statusWarning,
            theme.statusPending,
            theme.statusStaff,
        ]
    }
}
