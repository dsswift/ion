import SwiftUI

// MARK: - AgentTurnRow

/// Renders an agent turn: an optional thinking block above assistant text,
/// followed by a collapsible activity panel (tools) at the bottom. Used by
/// Transcript when the unified turn view setting is active.
///
/// Layout: thinking (top) → assistant messages (middle) → tool panel (bottom).
struct AgentTurnRow: View {
    let tools: [Message]
    let assistantMessages: [Message]
    let isActive: Bool
    let thinking: Message?
    var activeBackgroundTasks: [BackgroundTaskState] = []
    var tabId: String? = nil
    /// Per-row chart render state, derived once by the transcript. A unified
    /// turn groups its tool rows here rather than in EngineToolGroupRow, so
    /// without this a chart rendered inside a turn had no path to the screen
    /// at all — which is why charts were invisible on iOS while the desktop,
    /// which renders visual output in BOTH group kinds, showed them.
    var chartRenders: [String: ChartTranscript.RowRender] = [:]

    @State private var isExpanded = false
    @Environment(\.appTheme) private var theme

    private var activeProgress: (currentToolDescription: String, usedCount: Int)? {
        activeToolProgress(tools)
    }

    private var activeLabel: String {
        guard let activeProgress else { return "Running tools\u{2026}" }
        let countLabel = "Used \(activeProgress.usedCount) tool\(activeProgress.usedCount == 1 ? "" : "s")"
        return "Running \(activeProgress.currentToolDescription) · \(countLabel)"
    }

    var body: some View {
        // Named space so a chart card can report its offset WITHIN this row.
        // A global frame would be stale the moment the list scrolls; an offset
        // from the row's top edge stays true wherever the row sits.
        VStack(alignment: .leading, spacing: 4) {
            // Thinking block — rendered above assistant text when present.
            if let thinking {
                ThinkingRowView(message: thinking)
            }

            // Assistant text — always visible, not collapsible
            ForEach(assistantMessages) { msg in
                if !msg.content.isEmpty {
                    EngineMessageRow(message: msg)
                }
            }

            // Activity panel — DisclosureGroup, collapsed by default,
            // rendered below assistant text.
            if !tools.isEmpty {
                DisclosureGroup(isExpanded: $isExpanded) {
                    VStack(spacing: 2) {
                        ForEach(tools) { tool in
                            HStack(spacing: 6) {
                                toolIcon(for: tool)
                                Text(toolDescription(
                                    name: tool.toolName ?? "tool",
                                    input: tool.toolInput
                                ))
                                    .font(.caption2)
                                    .foregroundStyle(theme.textSecondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer()
                            }
                            .padding(.horizontal, IonSpace.hairlineGap)
                            .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if isActive {
                            ProgressView()
                                .scaleEffect(0.6)
                        } else {
                            Image(systemName: compositeIcon)
                                .font(.caption2)
                                .foregroundStyle(compositeColor)
                        }
                        Text(isActive
                            ? activeLabel
                            : settledLabel)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(theme.textSecondary)
                    }
                }
                .disclosureGroupStyle(AgentTurnDisclosureStyle(theme: theme))
                .padding(.horizontal, IonSpace.compactGap)
                .padding(.vertical, IonSpace.compactInset)
                .background(theme.surfaceElevated.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
            }

            // Chart cards sit OUTSIDE the disclosure: a chart is a deliverable
            // the operator asked for, not execution detail, so collapsing the
            // turn's tool list must never hide it. Mirrors the desktop, where
            // visual output is rendered outside the tool-row disclosure for
            // the same reason.
            ForEach(chartCards, id: \.id) { entry in
                ChartTranscriptCard(render: entry.render)
            }

            ActiveBackgroundSummary(
                tools: tools,
                activeTasks: activeBackgroundTasks,
                tabId: tabId
            )
        }
        .coordinateSpace(name: ChartAnchorKey.rowSpace)
    }

    /// Chart cards this turn owns, in row order.
    private var chartCards: [(id: String, render: ChartTranscript.RowRender)] {
        tools.compactMap { tool in
            guard let render = chartRenders[tool.id] else { return nil }
            return (id: tool.id, render: render)
        }
    }

    // MARK: - Helpers

    private var compositeIcon: String {
        // isActive (any tool running) renders a spinner in the label; icon not used.
        // Here we produce the settled icon for the non-active branch.
        let summary = toolGroupFailureSummary(tools)
        if summary.failed == 0 { return "checkmark.circle.fill" }
        if summary.failed == summary.total { return "xmark.circle.fill" }
        return "exclamationmark.triangle.fill"
    }

    private var compositeColor: Color {
        let summary = toolGroupFailureSummary(tools)
        if summary.failed == 0 { return theme.statusDone }
        if summary.failed == summary.total { return theme.statusError }
        return theme.statusWarning
    }

    /// Label for the disclosure group header (settled state only — active state
    /// shows "Running tools…" and no icon/suffix).
    private var settledLabel: String {
        let base = "Used \(tools.count) tool\(tools.count == 1 ? "" : "s")"
        let summary = toolGroupFailureSummary(tools)
        guard summary.failed > 0 else { return base }
        if summary.failed == summary.total { return "\(base), all failed" }
        return "\(base), \(summary.failed) failed"
    }

    @ViewBuilder
    private func toolIcon(for tool: Message) -> some View {
        switch tool.toolStatus {
        case .running:
            ProgressView().scaleEffect(0.6)
        case .asyncPending:
            Image(systemName: "clock.arrow.circlepath")
                .font(.caption2)
                .foregroundStyle(theme.statusBash)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(theme.statusDone)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(theme.statusError)
        case nil:
            Image(systemName: "wrench")
                .font(.caption2)
                .foregroundStyle(theme.textSecondary)
        }
    }
}

// MARK: - Custom disclosure style

/// Minimal disclosure style that matches the existing EngineToolGroupRow aesthetic.
private struct AgentTurnDisclosureStyle: DisclosureGroupStyle {
    let theme: ThemeManager

    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) {
                    configuration.isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    configuration.label
                    Spacer()
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
            }
            .buttonStyle(.plain)

            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}
