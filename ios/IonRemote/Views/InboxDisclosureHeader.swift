import SwiftUI

/// The label of every collapsible header in the inbox tree: a leading
/// chevron, an icon, the title, an optional count, and whatever the header
/// carries on its trailing edge.
///
/// One shape for the project, bench, source-repository, and settled headers.
/// They used to be four hand-built rows with the chevron on the trailing edge
/// in three of them and the leading edge in the fourth, at three different
/// sizes. The chevron leads here, in a reserved column, so it never shares
/// the trailing edge with status marks or actions.
struct InboxDisclosureHeader<Trailing: View>: View {
    @Environment(\.appTheme) private var theme

    enum Emphasis {
        /// A project: the top of a tree.
        case primary
        /// A band inside a project.
        case secondary
    }

    let title: String
    let systemImage: String
    var count: Int?
    let isExpanded: Bool
    var emphasis: Emphasis = .secondary
    /// False for a header that does not collapse. The chevron's column stays
    /// reserved so the icon and title still line up with the headers that do.
    var showsChevron: Bool = true
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: IonSpace.compactInset) {
            InboxChevron(isExpanded: isExpanded)
                .opacity(showsChevron ? 1 : 0)
            icon
            Text(title)
                .font(emphasis == .primary ? IonType.bodyStrong : IonType.sectionLabel)
                .foregroundStyle(emphasis == .primary ? theme.textPrimary : theme.textSecondary)
                .layoutPriority(1)
                .lineLimit(1)
            if let count, count > 0 {
                Text("\(count)")
                    .font(IonType.microLabel)
                    .foregroundStyle(theme.textTertiary)
            }
            Spacer(minLength: IonSpace.compactGap)
            trailing()
        }
        .contentShape(Rectangle())
    }

    /// A project wears its icon on a small tinted tile, the way a settings
    /// row or an app folder does: it reads as a place. A group inside the
    /// project keeps a plain glyph, so the two never compete.
    @ViewBuilder
    private var icon: some View {
        switch emphasis {
        case .primary:
            Image(systemName: "\(systemImage).fill")
                .font(IonType.metadata)
                .foregroundStyle(theme.accent)
                .frame(width: InboxLayout.iconColumn, height: InboxLayout.iconColumn)
                .background(theme.accentSubtle, in: RoundedRectangle(cornerRadius: IonRadius.control))
        case .secondary:
            Image(systemName: systemImage)
                .font(IonType.metadata)
                .foregroundStyle(theme.textSecondary)
                .frame(width: InboxLayout.iconColumn)
        }
    }
}

extension InboxDisclosureHeader where Trailing == EmptyView {
    init(title: String, systemImage: String, count: Int? = nil, isExpanded: Bool, emphasis: Emphasis = .secondary, showsChevron: Bool = true) {
        self.init(title: title, systemImage: systemImage, count: count, isExpanded: isExpanded, emphasis: emphasis, showsChevron: showsChevron) {
            EmptyView()
        }
    }
}

/// The disclosure chevron, in its reserved column.
struct InboxChevron: View {
    @Environment(\.appTheme) private var theme
    let isExpanded: Bool

    var body: some View {
        Image(systemName: "chevron.right")
            .font(IonType.microLabel)
            .foregroundStyle(theme.textTertiary)
            .rotationEffect(.degrees(isExpanded ? 90 : 0))
            .frame(width: InboxLayout.chevronColumn)
    }
}
