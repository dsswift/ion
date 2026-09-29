import SwiftUI
import UIKit

/// Draws the formatter's `AttributedString` with UIKit attributes, for
/// `LinkableText`.
///
/// The formatter styles runs with SwiftUI fonts, which UIKit cannot read. Each
/// styled run also carries its `inlinePresentationIntent` (bold, italic, code,
/// strikethrough), and this rebuilds the same look from that intent on top of
/// the block's base text style.
enum LinkableTextRenderer {
    /// The UIKit styling a block of message text starts from.
    struct Style: Equatable {
        var textStyle: UIFont.TextStyle = .body
        var bold = false
        var color: UIColor = .label
        var alignment: NSTextAlignment = .natural
    }

    /// True when any run of `text` is a link.
    static func hasLinks(_ text: AttributedString) -> Bool {
        text.runs.contains { $0.link != nil }
    }

    static func render(_ text: AttributedString, style: Style) -> NSAttributedString {
        let base = UIFont.preferredFont(forTextStyle: style.textStyle)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = style.alignment
        let out = NSMutableAttributedString()
        for run in text.runs {
            let intent = run.inlinePresentationIntent ?? []
            var attributes: [NSAttributedString.Key: Any] = [
                .font: font(base: base, intent: intent, bold: style.bold),
                .foregroundColor: run[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self].map { UIColor($0) } ?? style.color,
                .paragraphStyle: paragraph,
            ]
            if let background = run[AttributeScopes.SwiftUIAttributes.BackgroundColorAttribute.self] {
                attributes[.backgroundColor] = UIColor(background)
            }
            if intent.contains(.strikethrough) {
                attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }
            if let link = run.link {
                attributes[.link] = link
            }
            out.append(NSAttributedString(string: String(text[run.range].characters), attributes: attributes))
        }
        return out
    }

    private static func font(base: UIFont, intent: InlinePresentationIntent, bold: Bool) -> UIFont {
        let isBold = bold || intent.contains(.stronglyEmphasized)
        var font = intent.contains(.code)
            ? UIFont.monospacedSystemFont(ofSize: base.pointSize, weight: isBold ? .bold : .regular)
            : base
        var traits = font.fontDescriptor.symbolicTraits
        if isBold { traits.insert(.traitBold) }
        if intent.contains(.emphasized) { traits.insert(.traitItalic) }
        if let descriptor = font.fontDescriptor.withSymbolicTraits(traits) {
            font = UIFont(descriptor: descriptor, size: 0)
        }
        return font
    }
}
