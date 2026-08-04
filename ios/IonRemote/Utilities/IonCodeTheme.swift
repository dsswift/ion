import SwiftUI
import UIKit

// MARK: - IonCodeTheme

/// Maps highlight.js token classes onto an AppTheme's code-syntax tokens so
/// syntax colors derive from the active Ion theme (built-in or synced pack).
/// Desktop counterpart: `ionShikiTheme.ts` maps TextMate scopes onto the
/// same tokens — the parity fixture pins the token values identical
/// across platforms.
enum IonCodeTheme {
    /// Resolve the color for one hljs class list (a span may carry several,
    /// e.g. `hljs-title function_`). Specific role suffixes win over the
    /// generic `hljs-title`. Returns nil for container/unknown classes —
    /// the run then inherits the surrounding text color.
    static func color(forClasses classes: [String], theme: any AppTheme) -> Color? {
        // Role suffixes first: `hljs-title class_` is a type, not a function.
        if classes.contains("class_") || classes.contains("class_.inherited__") {
            return theme.codeType
        }
        if classes.contains("function_") || classes.contains("function_.invoke__") {
            return theme.codeFunction
        }
        for cls in classes {
            if let mapped = color(forClass: cls, theme: theme) { return mapped }
        }
        return nil
    }

    private static func color(forClass cls: String, theme: any AppTheme) -> Color? {
        switch cls {
        case "hljs-keyword", "hljs-selector-tag", "hljs-built_in",
             "hljs-tag", "hljs-name", "hljs-meta", "hljs-symbol":
            return theme.codeKeyword
        case "hljs-string", "hljs-regexp", "hljs-quote", "hljs-char.escape_":
            return theme.codeString
        case "hljs-number", "hljs-literal":
            return theme.codeNumber
        case "hljs-comment", "hljs-doctag":
            return theme.codeComment
        case "hljs-title", "hljs-function", "hljs-section":
            return theme.codeFunction
        case "hljs-type", "hljs-class":
            return theme.codeType
        case "hljs-variable", "hljs-attr", "hljs-property", "hljs-attribute",
             "hljs-params", "hljs-template-variable", "hljs-selector-attr",
             "hljs-selector-class", "hljs-selector-id":
            return theme.codeVariable
        case "hljs-operator", "hljs-punctuation":
            return theme.codeOperator
        default:
            return nil
        }
    }

    /// SwiftUI Color → `#RRGGBB` (alpha dropped). Used by tests to compare
    /// run colors against theme tokens.
    static func hex(_ color: Color) -> String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return "#FFFFFF"
        }
        func comp(_ value: CGFloat) -> String {
            String(format: "%02X", Int((max(0, min(1, value)) * 255).rounded()))
        }
        return "#\(comp(red))\(comp(green))\(comp(blue))"
    }
}
