import SwiftUI

// MARK: - StatusDrawerBreakdown
//
// Context-breakdown building blocks for StatusDrawerView's Context Breakdown
// section (plan minty-grinning-cocoa §§ C3–C5, C8). Extracted from
// StatusDrawerView.swift to keep each file under the 600-line cap while
// preserving the redesign's grouping, proportion-graph, and cache-annotation
// parity with desktop StatusDrawer.tsx.

// MARK: - BreakdownKind (fixed ordering, labels, colors)

/// Fixed kind ordering + display metadata for the context breakdown, mirroring
/// desktop StatusDrawer.tsx (KIND_ORDER / KIND_LABEL / KIND_COLOR).
enum BreakdownKind {
    /// Fixed display order for kind buckets.
    static let order: [String] = ["system_prompt", "tools", "conversation", "file", "unaccounted"]

    /// Normalize an engine kind value to a fixed bucket key.
    static func key(_ kind: String) -> String {
        switch kind {
        case "system_prompt", "system-prompt": return "system_prompt"
        case "tools", "tool":                   return "tools"
        case "conversation", "message":         return "conversation"
        case "file":                            return "file"
        default:                                return "unaccounted"
        }
    }

    static func label(_ key: String) -> String {
        switch key {
        case "system_prompt": return "System Prompt"
        case "tools":         return "Tools"
        case "conversation":  return "Conversation"
        case "file":          return "Files"
        default:              return "Unaccounted"
        }
    }

    static func color(_ key: String) -> Color {
        switch key {
        case "system_prompt": return Color(breakdownHex: 0x7c6af7)
        case "tools":         return Color(breakdownHex: 0x3b82f6)
        case "conversation":  return Color(breakdownHex: 0x22c55e)
        case "file":          return Color(breakdownHex: 0xf59e0b)
        default:              return Color(breakdownHex: 0x6b7280)
        }
    }
}

// MARK: - BreakdownGrouping (pure grouping + graph-segment logic)

/// Pure grouping / ordering logic for the context breakdown, extracted so it can
/// be unit-tested without a SwiftUI view. Mirrors desktop groupCategories.
enum BreakdownGrouping {
    struct Group {
        let kind: String
        let categories: [ContextBreakdownCategory]
        var total: Int { categories.reduce(0) { $0 + $1.tokens } }
    }

    struct Segment {
        let kind: String
        let tokens: Int
        let pct: Double
    }

    /// Group categories by kind (fixed order), sorting descending by tokens
    /// within each bucket. Only present buckets are returned.
    static func group(_ categories: [ContextBreakdownCategory]) -> [Group] {
        var buckets: [String: [ContextBreakdownCategory]] = [:]
        for cat in categories {
            buckets[BreakdownKind.key(cat.kind), default: []].append(cat)
        }
        var result: [Group] = []
        for kind in BreakdownKind.order {
            guard let items = buckets[kind] else { continue }
            let sorted = items.sorted { $0.tokens > $1.tokens }
            result.append(Group(kind: kind, categories: sorted))
        }
        return result
    }

    /// Compute proportion-graph segments (bucket total / contextWindow) in fixed
    /// kind order. Only buckets with pct > 0 are included.
    static func graphSegments(groups: [Group], contextWindow: Int) -> [Segment] {
        guard contextWindow > 0 else { return [] }
        return groups.compactMap { group in
            let pct = Double(group.total) / Double(contextWindow) * 100
            guard pct > 0 else { return nil }
            return Segment(kind: group.kind, tokens: group.total, pct: pct)
        }
    }
}

// MARK: - ProportionGraphView (segmented bar + legend)

struct ProportionGraphView: View {
    let segments: [BreakdownGrouping.Segment]
    let contextWindow: Int
    @Environment(\.appTheme) private var theme

    private var usedPct: Double { segments.reduce(0) { $0 + $1.pct } }
    private var freePct: Double { max(0, 100 - usedPct) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Segmented bar.
            GeometryReader { geo in
                HStack(spacing: 0) {
                    ForEach(segments, id: \.kind) { seg in
                        BreakdownKind.color(seg.kind)
                            .frame(width: geo.size.width * seg.pct / 100)
                    }
                    if freePct > 0 {
                        theme.textSecondary.opacity(0.15)
                            .frame(width: geo.size.width * freePct / 100)
                    }
                }
            }
            .frame(height: 8)
            .clipShape(RoundedRectangle(cornerRadius: 4))

            // Legend dots.
            FlowLegend(segments: segments, showFree: freePct > 0.5)
        }
    }
}

/// Wrapping legend row for the proportion graph.
private struct FlowLegend: View {
    let segments: [BreakdownGrouping.Segment]
    let showFree: Bool
    @Environment(\.appTheme) private var theme

    var body: some View {
        // A simple wrapping HStack via a lazy grid keeps layout robust.
        let columns = [GridItem(.adaptive(minimum: 70), spacing: 8, alignment: .leading)]
        LazyVGrid(columns: columns, alignment: .leading, spacing: 2) {
            ForEach(segments, id: \.kind) { seg in
                HStack(spacing: 3) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(BreakdownKind.color(seg.kind))
                        .frame(width: 6, height: 6)
                    Text(BreakdownKind.label(seg.kind))
                        .font(.system(size: 9))
                        .foregroundStyle(theme.textSecondary)
                }
            }
            if showFree {
                HStack(spacing: 3) {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(theme.textSecondary.opacity(0.2))
                        .frame(width: 6, height: 6)
                    Text("Free")
                        .font(.system(size: 9))
                        .foregroundStyle(theme.textSecondary.opacity(0.7))
                }
            }
        }
    }
}

// MARK: - BreakdownCategoryRow

struct BreakdownCategoryRow: View {
    let cat: ContextBreakdownCategory
    let contextWindow: Int
    var indent: Bool = false
    @Environment(\.appTheme) private var theme

    private var pct: Int {
        contextWindow > 0 ? Int(round(Double(cat.tokens) / Double(contextWindow) * 100)) : 0
    }

    /// Display label: for file rows show the last two path components.
    private var label: String {
        if let path = cat.path, !path.isEmpty {
            let parts = path.split(separator: "/")
            return parts.suffix(2).joined(separator: "/")
        }
        return cat.name
    }

    var body: some View {
        HStack(spacing: 4) {
            if indent {
                Text("↳")
                    .font(.system(size: 9))
                    .foregroundStyle(theme.textSecondary.opacity(0.5))
            }
            Text(label)
                .font(.caption)
                .foregroundStyle(theme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text(cat.tokens.formatted())
                .font(.caption.monospacedDigit())
                .foregroundStyle(theme.textPrimary)
            Text("\(pct)%")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(theme.textSecondary)
                .frame(minWidth: 28, alignment: .trailing)
            TierBadge(tier: cat.tier)
        }
        .padding(.leading, indent ? 12 : 0)
    }
}

// MARK: - TierBadge

private struct TierBadge: View {
    let tier: String
    @Environment(\.appTheme) private var theme

    private var label: String {
        switch tier {
        case "exact": return "exact"
        case "local": return "bpe"
        default: return "~"
        }
    }

    private var badgeColor: Color {
        switch tier {
        case "exact": return theme.accent.opacity(0.85)
        case "local": return theme.textSecondary.opacity(0.6)
        default: return theme.textSecondary.opacity(0.4)
        }
    }

    var body: some View {
        Text(label)
            .font(.system(size: 9, weight: .semibold, design: .monospaced))
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(badgeColor)
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }
}


// MARK: - StatusDrawerView Context Breakdown region
//
// The drawer's own scrollable Context Breakdown region, assembled from the
// building blocks above. Lives here rather than in StatusDrawerView.swift so
// that file stays under the 600-line Swift cap.
//
// The comments on the total row are load-bearing: they record WHICH token
// quantity each row renders, which is the distinction the occupancy fix exists
// to preserve. See ConversationStatusBar.resolveContextTokens.

extension StatusDrawerView {

    // MARK: - Section: Context Breakdown (own scroll region)

    func breakdownRegion(_ bd: ContextBreakdownPayload, window: Int) -> some View {
        let groups = BreakdownGrouping.group(bd.categories)
        let segments = BreakdownGrouping.graphSegments(groups: groups, contextWindow: window)
        return VStack(alignment: .leading, spacing: 0) {
            // Header + proportion graph fixed above the scroll.
            VStack(alignment: .leading, spacing: 8) {
                sectionHeader("Context Breakdown")
                ProportionGraphView(segments: segments, contextWindow: window)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            // Scrollable rows.
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(groups, id: \.kind) { group in
                        breakdownGroup(group, window: window)
                    }

                    // Unaccounted row (pre-total).
                    if let unaccounted = bd.unaccounted, unaccounted != 0 {
                        Divider().background(theme.textSecondary.opacity(0.15)).padding(.top, 2)
                        HStack {
                            Text("unaccounted")
                                .font(.caption)
                                .foregroundStyle(theme.textSecondary.opacity(0.6))
                            Spacer()
                            Text(unaccounted.formatted())
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(theme.textSecondary.opacity(0.6))
                        }
                    }

                    // Total row (bold). The itemized sum only — no percentage.
                    // This total is the per-category attribution figure, not
                    // occupancy: it over-reports against the context window
                    // because it counts content the provider did not bill for
                    // this turn. Rendering it as a percentage of the window
                    // invites exactly the totalTokens-as-occupancy misreading
                    // that the headline figure above was fixed to avoid. The
                    // `unaccounted` row directly above carries its drift from
                    // the provider's reported total.
                    Divider().background(theme.textSecondary.opacity(0.15)).padding(.top, 2)
                    HStack {
                        Text("total")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(theme.textSecondary)
                        Spacer()
                        Text(bd.totalTokens.formatted())
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(theme.textPrimary)
                    }

                    // Cache annotation (non-additive — annotation on the total).
                    let cacheRead = bd.cacheReadTokens ?? 0
                    let cacheWritten = bd.cacheCreationTokens ?? 0
                    if cacheRead > 0 || cacheWritten > 0 {
                        cacheAnnotation(read: cacheRead, written: cacheWritten)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .frame(minHeight: 0)
        }
    }

    private func breakdownGroup(_ group: BreakdownGrouping.Group, window: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // Bucket header: color dot + kind label + bucket total.
            HStack(spacing: 4) {
                Circle()
                    .fill(BreakdownKind.color(group.kind))
                    .frame(width: 6, height: 6)
                Text(BreakdownKind.label(group.kind).uppercased())
                    .font(.system(size: 9, weight: .semibold))
                    .tracking(0.8)
                    .foregroundStyle(theme.textSecondary)
                Text(group.total.formatted())
                    .font(.system(size: 9).monospacedDigit())
                    .foregroundStyle(theme.textSecondary.opacity(0.7))
                Spacer()
            }
            .padding(.top, 4)

            // Category rows (indented sub-rows when >1 in the bucket).
            ForEach(Array(group.categories.enumerated()), id: \.offset) { _, cat in
                BreakdownCategoryRow(
                    cat: cat,
                    contextWindow: window,
                    indent: group.categories.count > 1
                )
            }
        }
    }

    private func cacheAnnotation(read: Int, written: Int) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("of which, cached")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.accent)
            if read > 0 {
                HStack {
                    Text("served (read)")
                        .font(.system(size: 9))
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Text(read.formatted())
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundStyle(theme.textSecondary)
                }
            }
            if written > 0 {
                HStack {
                    Text("written")
                        .font(.system(size: 9))
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Text(written.formatted())
                        .font(.system(size: 9).monospacedDigit())
                        .foregroundStyle(theme.textSecondary)
                }
            }
        }
        .padding(6)
        .background(theme.accent.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .padding(.top, 4)
    }
}

// MARK: - Color(breakdownHex:)

private extension Color {
    /// Construct an opaque Color from a 0xRRGGBB integer literal. Named
    /// distinctly from the app-wide `Color(hex:)` to avoid overload ambiguity.
    init(breakdownHex hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}
