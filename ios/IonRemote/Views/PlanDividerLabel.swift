import SwiftUI

/// Renders the centered label for a lifecycle divider system message (the
/// `──`-prefixed rows: session-start, plan-created, plan-updated,
/// implementing, steer-applied, cleared).
///
/// For a plan-lifecycle divider that carries a `planFilePath` AND has an
/// `onTapPlan` handler, the slug portion (the text after ` · `) is
/// rendered as a tappable link that calls `onTapPlan(planFilePath)` — the
/// conversation view opens the plan preview from there. Every other divider
/// (including a plan divider with no path/handler) renders as plain tertiary
/// text, identical to the prior inline rendering.
///
/// Extracted into its own file because EngineMessageRow.swift is already over
/// the 600-line cap (file-size-exception); the divider-link logic lives here
/// to avoid extending that file further. Mirrors the desktop SystemMessage.tsx
/// slug-split-and-link behavior.
struct PlanDividerLabel: View {
    let message: Message
    var onTapPlan: ((String) -> Void)? = nil

    /// True when this divider is a plan created/updated marker that should
    /// render a clickable slug: it carries a planFilePath, a tap handler is
    /// wired, and the content is a recognized plan-lifecycle divider with a
    /// ` · <slug>` segment to make tappable.
    private var linkablePlan: (path: String, prefix: String, slug: String, suffix: String)? {
        guard let path = message.planFilePath, !path.isEmpty,
              onTapPlan != nil else { return nil }
        let content = message.content
        guard content.hasPrefix("── Plan created") ||
                content.hasPrefix("── Plan updated") ||
                content.hasPrefix("── Implementing plan") else { return nil }
        // Split on the ` · ` separator: prefix · slug<suffix>. The slug runs
        // from after the separator to the trailing ` ──`. Mirrors the desktop
        // split in SystemMessage.tsx.
        guard let sepRange = content.range(of: " · ") else { return nil }
        let prefix = String(content[content.startIndex..<sepRange.lowerBound])
        let rest = String(content[sepRange.upperBound...])
        let trailer = " ──"
        if rest.hasSuffix(trailer) {
            let slug = String(rest.dropLast(trailer.count))
            return (path, prefix + " · ", slug, trailer)
        }
        return (path, prefix + " · ", rest, "")
    }

    #if DEBUG
    /// Test seam: the resolved plan path when this divider is a linkable plan
    /// divider, else nil. Lets unit tests pin the link-eligibility decision
    /// without rendering the view.
    var testLinkPath: String? { linkablePlan?.path }
    /// Test seam: the slug that would be rendered as the tappable link, else nil.
    var testLinkSlug: String? { linkablePlan?.slug }
    #endif

    var body: some View {
        if let link = linkablePlan {
            // prefix + tappable slug + suffix, all caption2/tertiary to match
            // the plain divider; the slug is underlined to signal it is a link.
            (
                Text(link.prefix)
                    .foregroundStyle(.tertiary)
                + Text(link.slug)
                    .foregroundStyle(.tint)
                    .underline()
                + Text(link.suffix)
                    .foregroundStyle(.tertiary)
            )
            .font(.caption2)
            .multilineTextAlignment(.center)
            .lineLimit(2)
            .layoutPriority(1)
            .contentShape(Rectangle())
            .onTapGesture {
                Haptic.light()
                onTapPlan?(link.path)
            }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("Open plan \(link.slug)")
        } else {
            Text(message.content)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .layoutPriority(1)
        }
    }
}
