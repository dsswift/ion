import SwiftUI
import UIKit

// MARK: - IonType
//
// The eleven named type roles. Every piece of text in a shipping view resolves
// to one of them; no view picks a face, size, or weight on its own.
//
// Why roles rather than raw fonts. The app has hundreds of `.font(` call sites
// with no shared anchor, and not one of them participates in Dynamic Type.
// Both problems have the same cause: a call site that names a font has no
// decision to make, so every site makes its own. A call site that names a
// *role* has to say what the text is for, and the answer is checkable. This is
// the same failure the size-named spacing constants hit (see `IonSpace.swift`),
// fixed the same way.
//
// Dynamic Type is not optional here. Every role carries a text-style anchor and
// scales from its stated size at the default content size:
//
//   * SF Pro Text roles go through `UIFontMetrics(forTextStyle:).scaledFont(for:)`.
//     `Font.system(size:weight:)` alone does NOT scale — it pins a point size —
//     and `Font.system(_ style:)` scales but forfeits the exact size the role
//     specifies. `UIFontMetrics` is the one path that keeps both: the exact
//     base size AND the anchor it grows against.
//   * The mono role goes through `Font.custom(_:size:relativeTo:)`, which is
//     the equivalent path for a registered custom face.
//
// Every role below is a computed `var`, not a `let`. `scaledFont(for:)`
// resolves against the content size *at the moment it is called*, so a stored
// constant would freeze whatever size was in effect when the type first
// loaded and would never grow when the user changes the setting. A computed
// property re-resolves on each access, and SwiftUI re-renders on a content-size
// change, so the two together give live scaling. The mono role is computed for
// the same uniformity even though `Font.custom(relativeTo:)` would be safe as
// a stored value.
//
// Two faces only:
//   * SF Pro Text for UI and prose. `UIFont.systemFont` is SF Pro Text at
//     these sizes.
//   * JetBrains Mono for code, paths, branch names, session IDs, durations,
//     and byte counts, reached through `IonTheme.codeFont`, which is the one
//     place the face is named. The `mono` role calls it rather than loading
//     the font a second time.
//
// Line height is carried per role rather than baked into the font, because
// SwiftUI has no line-height property on `Font`. Apply a role with the
// `ionType(_:)` modifier below, which sets the font and the matching line
// spacing together; a bare `.font(IonType.body)` silently drops half the role.

enum IonType {

    // MARK: Titles

    /// 28pt Bold, 34pt line height, scales with `.largeTitle`.
    /// Document title only. Not a section header, not a row title.
    static var screenTitleLarge: Font { scaled(28, .bold, .largeTitle) }

    /// 17pt Semibold, 22pt line height, scales with `.headline`.
    /// Inline navigation title.
    static var screenTitleInline: Font { scaled(17, .semibold, .headline) }

    // MARK: Rows

    /// 17pt Regular, 22pt line height, scales with `.body`.
    /// Tab and primary list title.
    static var rowTitle: Font { scaled(17, .regular, .body) }

    /// 17pt Medium, 22pt line height, scales with `.body`.
    /// Row title for a state that wants the eye: blocked, plan-ready,
    /// question, or error. Deliberately NOT used for a running row — running
    /// is carried by the status shape, and weighting the title too would give
    /// one state two signals while blocked states have one.
    static var rowTitleAttention: Font { scaled(17, .medium, .body) }

    // MARK: Prose

    /// 16pt Regular, 23pt line height, scales with `.body`.
    /// Assistant prose and permission explanation. The one role whose line
    /// height clears its size by a reading margin rather than an instrument
    /// margin: long output is an explicit density exemption.
    static var body: Font { scaled(16, .regular, .body) }

    /// 16pt Semibold, 23pt line height, scales with `.body`.
    /// Short emphasis inside prose. Not a heading.
    static var bodyStrong: Font { scaled(16, .semibold, .body) }

    // MARK: Secondary

    /// 13pt Medium, 18pt line height, scales with `.footnote`.
    /// Sentence-case section header. Never uppercase.
    static var sectionLabel: Font { scaled(13, .medium, .footnote) }

    /// 13pt Regular, 18pt line height, scales with `.footnote`.
    /// Tab-row meaning line and secondary label.
    static var meaning: Font { scaled(13, .regular, .footnote) }

    /// 12pt Regular, 16pt line height, scales with `.caption`.
    /// Timestamp and elapsed state.
    static var metadata: Font { scaled(12, .regular, .caption1) }

    /// 13pt JetBrains Mono Regular, 18pt line height, scales with `.footnote`.
    /// Tool argument, path, branch, ID. Reuses the single font load in
    /// `IonTheme.codeFont`; the face is not registered twice.
    static var mono: Font { IonTheme.codeFont(size: 13, relativeTo: .footnote) }

    /// 11pt Medium, 14pt line height, scales with `.caption2`.
    /// Count and compact chip label.
    static var microLabel: Font { scaled(11, .medium, .caption2) }

    /// 10pt stateful compact-chip label, scaled with `.caption2`.
    /// Active selection chooses the supplied semantic emphasis while inactive
    /// labels stay regular. This is a modifier, not a type role: its weight
    /// carries control state rather than text hierarchy.
    static func compactSelectionLabel(
        isSelected: Bool,
        selectedWeight: UIFont.Weight
    ) -> Font {
        scaled(10, compactSelectionWeight(
            isSelected: isSelected,
            selectedWeight: selectedWeight
        ), .caption2)
    }

    static func compactSelectionWeight(
        isSelected: Bool,
        selectedWeight: UIFont.Weight
    ) -> UIFont.Weight {
        isSelected ? selectedWeight : .regular
    }

    // MARK: - Role value

    /// The eleven roles as a value, so a role can be selected dynamically and
    /// so `ionType(_:)` can look up a role's font and line height together.
    /// The static properties above remain the ordinary way to use one.
    enum Role: String, CaseIterable {
        case screenTitleLarge
        case screenTitleInline
        case rowTitle
        case rowTitleAttention
        case body
        case bodyStrong
        case sectionLabel
        case meaning
        case metadata
        case mono
        case microLabel
    }

    /// The font for a role.
    static func font(_ role: Role) -> Font {
        switch role {
        case .screenTitleLarge:  return screenTitleLarge
        case .screenTitleInline: return screenTitleInline
        case .rowTitle:          return rowTitle
        case .rowTitleAttention: return rowTitleAttention
        case .body:              return body
        case .bodyStrong:        return bodyStrong
        case .sectionLabel:      return sectionLabel
        case .meaning:           return meaning
        case .metadata:          return metadata
        case .mono:              return mono
        case .microLabel:        return microLabel
        }
    }

    /// The point size a role specifies at the default content size.
    static func size(_ role: Role) -> CGFloat {
        switch role {
        case .screenTitleLarge:  return 28
        case .screenTitleInline: return 17
        case .rowTitle:          return 17
        case .rowTitleAttention: return 17
        case .body:              return 16
        case .bodyStrong:        return 16
        case .sectionLabel:      return 13
        case .meaning:           return 13
        case .metadata:          return 12
        case .mono:              return 13
        case .microLabel:        return 11
        }
    }

    /// The total line height a role specifies at the default content size.
    /// SwiftUI's `lineSpacing` is the gap *between* lines rather than a total,
    /// so `ionType(_:)` subtracts the point size before applying it. The spec
    /// value is kept whole here so this table reads against the style guide
    /// directly.
    static func lineHeight(_ role: Role) -> CGFloat {
        switch role {
        case .screenTitleLarge:  return 34
        case .screenTitleInline: return 22
        case .rowTitle:          return 22
        case .rowTitleAttention: return 22
        case .body:              return 23
        case .bodyStrong:        return 23
        case .sectionLabel:      return 18
        case .meaning:           return 18
        case .metadata:          return 16
        case .mono:              return 18
        case .microLabel:        return 14
        }
    }

    /// The text style a role scales against. Exposed so a caller that needs the
    /// anchor itself (a `UIKit` bridge, a `ScaledMetric`) reads it from the role
    /// table instead of restating it.
    static func textStyle(_ role: Role) -> UIFont.TextStyle {
        switch role {
        case .screenTitleLarge:  return .largeTitle
        case .screenTitleInline: return .headline
        case .rowTitle:          return .body
        case .rowTitleAttention: return .body
        case .body:              return .body
        case .bodyStrong:        return .body
        case .sectionLabel:      return .footnote
        case .meaning:           return .footnote
        case .metadata:          return .caption1
        case .mono:              return .footnote
        case .microLabel:        return .caption2
        }
    }

    // MARK: - Scaling

    /// Builds an SF Pro Text font at an exact point size that still scales with
    /// the named text style. See the file header for why neither
    /// `Font.system(size:weight:)` nor `Font.system(_ style:)` can do this on
    /// its own.
    private static func scaled(
        _ size: CGFloat,
        _ weight: UIFont.Weight,
        _ style: UIFont.TextStyle
    ) -> Font {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        return Font(UIFontMetrics(forTextStyle: style).scaledFont(for: base))
    }
}

// MARK: - View modifier

extension View {

    /// Applies a type role's font and its specified line height together.
    ///
    /// Line height is the half of a type role a bare `.font()` drops, which is
    /// why this modifier exists rather than leaving each caller to remember a
    /// matching `.lineSpacing`. SwiftUI's `lineSpacing` is the gap between
    /// lines, so what gets applied is the role's total line height minus its
    /// point size; a role whose line height does not clear its size gets no
    /// extra spacing.
    ///
    /// The spacing is a fixed point value while the font scales. That is the
    /// right tradeoff at these magnitudes: the font growing faster than the
    /// leading closes the gap gradually, rather than preserving a fixed ratio
    /// of empty space at accessibility sizes, where vertical room is what runs
    /// out first.
    func ionType(_ role: IonType.Role) -> some View {
        let spacing = max(0, IonType.lineHeight(role) - IonType.size(role))
        return self
            .font(IonType.font(role))
            .lineSpacing(spacing)
    }

    /// Applies compact label typography whose selected state changes weight.
    /// This is for dense instrument controls, not ordinary label hierarchy.
    func ionCompactSelectionLabel(
        isSelected: Bool,
        selectedWeight: UIFont.Weight
    ) -> some View {
        self.font(IonType.compactSelectionLabel(
            isSelected: isSelected,
            selectedWeight: selectedWeight
        ))
    }
}
