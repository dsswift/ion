import Foundation

/// SF Symbol counterparts of the Phosphor icon names Studio lets a Quick Tool
/// or a Composer Action carry. The names are the union of `ICON_MAP` in
/// `desktop/src/renderer/components/QuickToolsTray.tsx` and `ACTION_ICONS` in
/// `desktop/src/renderer/components/composer/useComposerActions.tsx`.
enum PhosphorSymbol {
    static let systemNames: [String: String] = [
        "Lightning": "bolt",
        "GitBranch": "arrow.triangle.branch",
        "GitMerge": "arrow.triangle.merge",
        "GitCommit": "smallcircle.filled.circle",
        "GitPullRequest": "arrow.triangle.pull",
        "Terminal": "terminal",
        "Play": "play",
        // SF Symbols has no rocket; the paper plane carries the same reading.
        "Rocket": "paperplane",
        "ArrowsClockwise": "arrow.clockwise",
        "Package": "shippingbox",
        "Hammer": "hammer",
        // SF Symbols has no broom; sparkles reads as "clean up".
        "Broom": "sparkles",
        "Upload": "square.and.arrow.up",
        "Download": "square.and.arrow.down",
        "Database": "cylinder",
        "Globe": "globe",
        "Code": "chevron.left.forwardslash.chevron.right",
        "Gear": "gearshape",
        "CheckCircle": "checkmark.circle",
        "Trash": "trash",
        "Newspaper": "newspaper",
        "ChartBar": "chart.bar",
        "HandWaving": "hand.wave",
        "MagnifyingGlass": "magnifyingglass",
        "ListChecks": "checklist",
        "Brain": "brain",
        "PuzzlePiece": "puzzlepiece.extension",
    ]

    /// The SF Symbol for `phosphorName`, or `fallback` for a name Studio
    /// would not recognize either.
    static func systemName(for phosphorName: String, fallback: String) -> String {
        systemNames[phosphorName] ?? fallback
    }
}
