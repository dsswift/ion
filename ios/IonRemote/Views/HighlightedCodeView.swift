import SwiftUI

// MARK: - HighlightedCodeView

/// Syntax-highlighted code body for markdown code blocks. Wraps the shared
/// `CodeHighlighter` output in a horizontal scroller, keeping SwiftUI's
/// monospaced font (Dynamic Type) and text selection. Reads the theme from
/// the environment so a theme switch re-highlights under the new theme id.
struct HighlightedCodeView: View {
    @Environment(\.appTheme) private var theme
    let code: String
    let language: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(CodeHighlighter.shared.highlight(code: code, language: language, theme: theme))
                .ionType(.mono)
                .textSelection(.enabled)
                .padding(.horizontal, IonSpace.contentGap)
                .padding(.vertical, IonSpace.compactInset)
        }
    }
}
