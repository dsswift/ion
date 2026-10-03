import SwiftUI

/// The inbox list's one geometry: where each row sits, how tall each kind of
/// row is, and the card each project is drawn on.
///
/// A project is a card: a rounded, raised surface inset from the screen edge,
/// with its header, its groups, and its conversations inside. The card is what
/// says where one project ends and the next begins, so nothing inside it needs
/// a rule or a deep indent to belong. Rows directly under the project header
/// start at the header's own leading edge; only a conversation inside a group
/// steps in, by enough to sit under its group's icon.
///
/// The list draws one row at a time, so the card is assembled from row
/// backdrops: the header rounds the top corners, the rows between are plain
/// surface, and a short footer row rounds the bottom and leaves the gap
/// before the next card.
enum InboxLayout {

    /// Screen edge to card edge.
    static let cardMargin: CGFloat = IonSpace.contentGap

    /// Card edge to its content.
    static let cardPadding: CGFloat = IonSpace.contentGap

    /// The card's corner radius. The footer row is this tall, so the bottom
    /// corners have room to turn.
    static let cardRadius: CGFloat = IonRadius.container

    /// Gap between one card and the next.
    static let cardGap: CGFloat = IonSpace.compactGap

    /// Width reserved for a disclosure chevron. Reserved on every header so
    /// titles align whether or not the glyph is drawn.
    static let chevronColumn: CGFloat = IonSpace.contentGap

    /// Width reserved for a header's leading icon.
    static let iconColumn: CGFloat = IonSpace.sectionGap

    /// How far a conversation inside a group steps in: past the group
    /// header's chevron, to start under its icon.
    static let childIndent: CGFloat = chevronColumn + IonSpace.compactInset

    /// What a row is, which decides its height and its backdrop.
    enum Kind {
        /// A project header with rows beneath it: the top of a card.
        case cardHeader
        /// A project header with nothing beneath it: the whole card.
        case cardHeaderAlone
        /// A bench, worktree, or source-repository header inside a card.
        case groupHeader
        /// A conversation, or anything else that is the list's content.
        case content
        /// The bottom edge of a card and the gap after it.
        case cardFooter
        /// The gap after a card that is only its header.
        case cardGap
    }

    /// Minimum height per kind. Group headers are shorter than the 44pt touch
    /// minimum on purpose: they span the card's width, so the target is large
    /// in the other axis, and a 44pt row per label spends the screen on labels.
    static func minHeight(_ kind: Kind) -> CGFloat {
        switch kind {
        case .cardHeader, .cardHeaderAlone: return 44
        case .groupHeader: return 32
        case .content: return 44
        case .cardFooter: return cardRadius + cardGap
        case .cardGap: return cardGap
        }
    }

    /// Levels: 0 is a project header or a row outside any card, 1 is anything
    /// directly inside a card, 2 is a conversation inside a group.
    static func insets(level: Int) -> EdgeInsets {
        let edge = cardMargin + cardPadding
        return EdgeInsets(
            top: 0,
            leading: edge + (level >= 2 ? childIndent : 0),
            bottom: 0,
            trailing: edge
        )
    }

    /// Whether a row at this level and kind is drawn on a card. Level 0
    /// content (the settled shelf, an empty-state line) sits on the list's
    /// own background.
    static func isOnCard(level: Int, kind: Kind) -> Bool {
        switch kind {
        case .cardHeader, .cardHeaderAlone, .cardFooter: return true
        case .cardGap: return false
        case .groupHeader, .content: return level > 0
        }
    }
}

extension View {
    /// Place a row in the inbox at `level`. Separators are hidden: the cards
    /// and the headers carry the structure.
    func inboxRow(level: Int, kind: InboxLayout.Kind = .content, highlighted: Bool = false) -> some View {
        modifier(InboxRowPlacement(level: level, kind: kind, highlighted: highlighted))
    }
}

private struct InboxRowPlacement: ViewModifier {
    let level: Int
    let kind: InboxLayout.Kind
    let highlighted: Bool

    func body(content: Content) -> some View {
        content
            .frame(minHeight: InboxLayout.minHeight(kind))
            .listRowInsets(InboxLayout.insets(level: level))
            .listRowSeparator(.hidden)
            .listRowBackground(InboxRowBackdrop(level: level, kind: kind, highlighted: highlighted))
    }
}

/// What sits behind one inbox row: its slice of the project card.
struct InboxRowBackdrop: View {
    @Environment(\.appTheme) private var theme
    let level: Int
    let kind: InboxLayout.Kind
    let highlighted: Bool

    var body: some View {
        if InboxLayout.isOnCard(level: level, kind: kind) {
            cardSlice
                .padding(.horizontal, InboxLayout.cardMargin)
        } else {
            highlight
        }
    }

    @ViewBuilder
    private var cardSlice: some View {
        switch kind {
        case .cardHeader:
            UnevenRoundedRectangle(topLeadingRadius: InboxLayout.cardRadius, topTrailingRadius: InboxLayout.cardRadius)
                .fill(theme.surfaceElevated)
        case .cardHeaderAlone:
            RoundedRectangle(cornerRadius: InboxLayout.cardRadius)
                .fill(theme.surfaceElevated)
        case .cardFooter:
            UnevenRoundedRectangle(bottomLeadingRadius: InboxLayout.cardRadius, bottomTrailingRadius: InboxLayout.cardRadius)
                .fill(theme.surfaceElevated)
                .padding(.bottom, InboxLayout.cardGap)
        case .cardGap:
            Color.clear
        case .groupHeader, .content:
            Rectangle()
                .fill(theme.surfaceElevated)
                .overlay(highlight)
        }
    }

    private var highlight: some View {
        RoundedRectangle(cornerRadius: IonRadius.container)
            .fill(highlighted ? theme.accentSubtle : Color.clear)
            .padding(.horizontal, IonSpace.hairlineGap)
    }
}
