import SwiftUI

// MARK: - StatusDrawerView
//
// Sheet presented via the ⓘ toolbar button in ConversationView. Mirrors the
// desktop StatusDrawer.tsx redesign (plan minty-grinning-cocoa §§ C1–C6):
//
//   1. Session — copyable session ID (+ turns / duration when the snapshot
//      carries them). The model picker is intentionally GONE from the drawer;
//      it lives on the status bar (desktop C1 parity).
//   2. Context — usage bar + context tokens / window text + cost + engine state.
//   3. Active Tools — in-progress tool calls with elapsed timer + abort.
//   4. Running Dispatches — flat, live, running-only list across ALL tiers.
//      Tapping a row calls onOpenDispatch so ConversationView can deep-link
//      into AgentDetailFullScreenView with breadcrumb reconstruction.
//   5. Context Breakdown — its OWN scrollable region below the rest:
//        · proportion graph (segmented bar by kind, fixed order, + legend),
//        · rows grouped by kind (fixed order, sorted desc within bucket,
//          sub-rows indented with ↳),
//        · unaccounted row, total row,
//        · non-additive "of which, cached" cache annotation.
//
// Plan: minty-grinning-cocoa §§ C7, C8 (iOS parity with desktop StatusDrawer.tsx).

struct StatusDrawerView: View {
    let tabId: String
    let compoundKey: String
    let fields: StatusFields?
    let agents: [AgentStateUpdate]
    let activeTools: [ActiveToolInfo]
    /// Called with the selected dispatchId so ConversationView can open
    /// AgentDetailFullScreenView for that specific dispatch with breadcrumb reconstruction.
    var onOpenDispatch: ((String) -> Void)? = nil

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    /// Copy-feedback flag for the session-ID copy button. Flips to true for
    /// 1.5s after a successful copy (button icon: doc.on.doc → checkmark).
    @State private var copiedSessionId = false

    // MARK: - Derived state

    /// The tab's single engine instance (source of last-known status when
    /// `fields` is nil at the call site, e.g. idle/reload).
    private var inst: ConversationInstanceInfo? {
        viewModel.engineInstance(tabId: tabId, instanceId: nil)
    }

    /// Flat, running-only dispatches across ALL tiers (mirrors desktop agentStates.filter).
    private var runningDispatches: [(agent: AgentStateUpdate, dispatch: DispatchInfo, depth: Int)] {
        agents.flatMap { agent -> [(AgentStateUpdate, DispatchInfo, Int)] in
            // Only running agents have active dispatches to show.
            guard agent.status == "running" else { return [] }
            // Find the actively-running dispatch (or fall back to last).
            let activeDispatch = agent.dispatches.first(where: { $0.status == "running" })
                ?? agent.dispatches.last
            guard let dispatch = activeDispatch else { return [] }
            return [(agent, dispatch, agent.dispatchDepth)]
        }
    }

    /// Context breakdown from the live engine event (stored on the instance).
    private var contextBreakdown: ContextBreakdownPayload? {
        inst?.contextBreakdown
    }

    /// Session ID surfaced in the Session section. Prefers the tab's
    /// conversationId, falling back to the instance's most-recent historical
    /// conversation id (matches the "Copy Session ID" fallback used elsewhere).
    private var sessionId: String? {
        if let cid = viewModel.tab(for: tabId)?.conversationId, !cid.isEmpty { return cid }
        return inst?.conversationIds?.last
    }

    /// Context% with an idle/reload fallback (C8g): when `fields` is nil at the
    /// call site the drawer still shows the engine's last-known percent from the
    /// stored instance rather than snapping to 0.
    private var contextPercent: Double {
        fields?.contextPercent ?? inst?.statusFields?.contextPercent ?? 0
    }

    /// Engine-reported context window (prefer breakdown, then fields, then instance).
    private var contextWindow: Int? {
        if let w = contextBreakdown?.contextWindow, w > 0 { return w }
        if let w = fields?.contextWindow, w > 0 { return w }
        if let w = inst?.statusFields?.contextWindow, w > 0 { return w }
        return nil
    }

    /// Absolute context tokens derived from percent × window (parity with desktop).
    private var contextTokens: Int? {
        guard contextPercent > 0, let w = contextWindow, w > 0 else { return nil }
        return Int(round(contextPercent / 100.0 * Double(w)))
    }

    /// Run cost (prefer live fields, then instance, then snapshot-projected).
    /// Uses runCostUsd (canonical) with no fallback to totalCostUsd since both
    /// are projected in lockstep from Commit 3 onward.
    private var runCostUsd: Double? {
        fields?.runCostUsd
            ?? inst?.statusFields?.runCostUsd
            ?? viewModel.tab(for: tabId)?.runCostUsd
    }

    /// Conversation cost (this session + all descendant dispatches).
    /// Available when the engine has emitted ConversationCostUsd via the
    /// status fields or the context breakdown payload.
    private var conversationCostUsd: Double? {
        fields?.conversationCostUsd
            ?? inst?.statusFields?.conversationCostUsd
            ?? viewModel.tab(for: tabId)?.conversationCostUsd
            ?? inst?.contextBreakdown?.aggregateCostUsd
    }

    /// Aggregate cost from the context breakdown payload (same value as
    /// conversationCostUsd, kept as a distinct accessor for the breakdown row).
    private var aggregateCostUsd: Double? {
        inst?.contextBreakdown?.aggregateCostUsd
    }

    /// Conversation-lifetime prompt count for the drawer "Turns" row. Prefers
    /// the live status field (stamped from the latest task_complete), then the
    /// snapshot-projected value on the tab (cold-open / historical parity).
    /// Nil collapses the row entirely.
    private var conversationTurns: Int? {
        fields?.conversationTurns
            ?? inst?.statusFields?.conversationTurns
            ?? viewModel.tab(for: tabId)?.conversationTurns
    }

    /// Engine state string (prefer live fields, then instance).
    private var engineState: String? {
        fields?.state ?? inst?.statusFields?.state
    }

    private func contextColor(_ pct: Double) -> Color {
        if pct >= 90 { return .red }
        if pct >= 70 { return .orange }
        return theme.accent
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                // Non-breakdown sections in a plain scroll (fixed at top).
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if sessionId != nil { sessionSection }
                        contextSection
                        if !activeTools.isEmpty { activeToolsSection }
                        if !runningDispatches.isEmpty { runningDispatchesSection }
                    }
                    .padding(16)
                }
                .frame(maxHeight: 340)
                .scrollBounceBehavior(.basedOnSize)

                // Breakdown gets its own scroll region below the rest (C2 parity).
                if let bd = contextBreakdown, !bd.categories.isEmpty, let window = contextWindow {
                    Divider().background(theme.textSecondary.opacity(0.2))
                    breakdownRegion(bd, window: window)
                }
            }
            .background(theme.background)
            .navigationTitle("Status")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(theme.background)
        .task {
            // Fire desktop_request_context_breakdown so the drawer shows
            // fresh data on open — including idle and historical sessions
            // that have not sent a prompt yet. The desktop forwards
            // get_context_breakdown to the engine; the response arrives as
            // desktop_context_breakdown and populates inst.contextBreakdown.
            viewModel.requestContextBreakdown(tabId: tabId)
        }
    }

    // MARK: - Section header (small, uppercase, letter-spaced)

    private func sectionHeader(_ label: String) -> some View {
        Text(label.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(1.2)
            .foregroundStyle(theme.textSecondary)
            .padding(.bottom, 4)
    }

    // MARK: - Section: Session

    @ViewBuilder
    private var sessionSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("Session")
            if let id = sessionId {
                HStack {
                    Text("ID")
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Text(id)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    copyButton(id)
                }
            }
            // Aggregate cost: this session plus all descendant dispatch
            // sessions. Rendered only when the breakdown payload carries it.
            if let cost = aggregateCostUsd {
                HStack {
                    Text("Total cost (incl. dispatches)")
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Text(String(format: "$%.4f", cost))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(theme.textSecondary)
                }
                // Per-model breakdown rows. Sourced from the on-demand
                // context breakdown; sorted by the engine (self rows first,
                // then dispatch rows by cost desc). Split into two labeled
                // groups so the viewing conversation's OWN spend is visually
                // separate from the dispatch spend.
                if let breakdown = contextBreakdown?.modelBreakdown, !breakdown.isEmpty {
                    let selfRows = breakdown.filter { $0.isSelf == true }
                    let dispatchRows = breakdown.filter { $0.isSelf != true }
                    if !selfRows.isEmpty {
                        modelGroupLabel("This conversation")
                        ForEach(selfRows) { mb in modelRow(mb) }
                    }
                    if !dispatchRows.isEmpty {
                        modelGroupLabel("Dispatches")
                        ForEach(dispatchRows) { mb in modelRow(mb) }
                    }
                }
            }
            // Conversation-lifetime turn count. Shown when the snapshot/live
            // fields carry it (real user prompts across the whole conversation,
            // not the per-run round-trip count). Collapses when absent.
            if let turns = conversationTurns {
                HStack {
                    Text("Turns")
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Text("\(turns)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(theme.textSecondary)
                }
            }
        }
    }

    /// Sub-label separating the self ("This conversation") and dispatch model
    /// groups within the per-model cost breakdown.
    private func modelGroupLabel(_ label: String) -> some View {
        Text(label.uppercased())
            .font(.system(size: 8, weight: .semibold))
            .tracking(0.8)
            .foregroundStyle(theme.textSecondary.opacity(0.5))
            .padding(.leading, 12)
            .padding(.top, 2)
    }

    /// One per-model cost row (model name + conversation count + cost).
    private func modelRow(_ mb: ModelBreakdown) -> some View {
        HStack {
            Text("\(mb.model) (\(mb.conversations))")
                .font(.system(size: 10))
                .foregroundStyle(theme.textSecondary.opacity(0.65))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text(String(format: "$%.4f", mb.costUsd))
                .font(.system(size: 10).monospacedDigit())
                .foregroundStyle(theme.textSecondary.opacity(0.65))
        }
        .padding(.leading, 20)
    }

    private func copyButton(_ id: String) -> some View {        Button {
            UIPasteboard.general.string = id
            copiedSessionId = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                copiedSessionId = false
            }
        } label: {
            Image(systemName: copiedSessionId ? "checkmark" : "doc.on.doc")
                .font(.caption)
                .foregroundStyle(copiedSessionId ? theme.accent : theme.textSecondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Copy session ID")
    }

    // MARK: - Section: Context

    @ViewBuilder
    private var contextSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("Context")
            // Usage bar
            ProgressView(value: min(contextPercent / 100.0, 1.0))
                .tint(contextColor(contextPercent))
            // Tokens / window on the left, cost on the right.
            HStack {
                Text(contextUsageText)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(theme.textSecondary)
                Spacer()
                if let cost = runCostUsd {
                    Text(String(format: "$%.4f", cost))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(theme.textSecondary)
                }
            }
            // Engine state (spinner when running).
            if let state = engineState {
                HStack(spacing: 4) {
                    if state == "running" {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(theme.statusRunning)
                    }
                    Text(state)
                        .font(.caption)
                        .foregroundStyle(state == "running" ? theme.statusRunning : theme.textSecondary)
                }
            }
        }
    }

    private var contextUsageText: String {
        let base: String
        if let tokens = contextTokens {
            base = "\(tokens.formatted()) tokens"
        } else {
            base = "\(Int(round(contextPercent)))%"
        }
        if let w = contextWindow {
            return base + " / \(w / 1000)k"
        }
        return base
    }

    // MARK: - Section: Active Tools

    @ViewBuilder
    private var activeToolsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("Active Tools")
            ForEach(activeTools) { tool in
                ActiveToolRow(tabId: tabId, tool: tool)
            }
        }
    }

    // MARK: - Section: Running Dispatches (flat, all tiers)

    @ViewBuilder
    private var runningDispatchesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("Running (\(runningDispatches.count))")
            ForEach(runningDispatches, id: \.dispatch.id) { item in
                Button {
                    onOpenDispatch?(item.dispatch.id)
                } label: {
                    HStack(spacing: 6) {
                        // Tier depth badge
                        if item.depth > 0 {
                            Text("T\(item.depth)")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(theme.textSecondary)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 2)
                                .background(theme.surfaceElevated.opacity(0.7))
                                .clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        Text(item.agent.displayName)
                            .font(.caption)
                            .foregroundStyle(theme.textPrimary)
                            .lineLimit(1)
                        Spacer()
                        if let start = item.dispatch.startTime {
                            ElapsedTimerLabel(startTime: start)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(theme.textSecondary.opacity(0.5))
                    }
                    .padding(.vertical, 4)
                    .padding(.horizontal, 6)
                    .background(theme.surfaceElevated.opacity(0.4))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
                }
                .buttonStyle(.plain)
            }
        }
    }

    // MARK: - Section: Context Breakdown (own scroll region)

    private func breakdownRegion(_ bd: ContextBreakdownPayload, window: Int) -> some View {
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

                    // Total row (bold).
                    Divider().background(theme.textSecondary.opacity(0.15)).padding(.top, 2)
                    let totalPct = window > 0
                        ? Int(round(Double(bd.totalTokens) / Double(window) * 100))
                        : 0
                    HStack {
                        Text("total")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(theme.textSecondary)
                        Spacer()
                        Text(bd.totalTokens.formatted())
                            .font(.caption.monospacedDigit().weight(.semibold))
                            .foregroundStyle(theme.textPrimary)
                        Text("\(totalPct)%")
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(theme.textSecondary)
                            .frame(minWidth: 30, alignment: .trailing)
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

// MARK: - ElapsedTimerLabel

/// Live elapsed display for a running dispatch row. Updates every second
/// while the dispatch is running.
private struct ElapsedTimerLabel: View {
    let startTime: Double  // Unix timestamp in seconds
    @State private var now = Date()

    private var elapsed: Int {
        max(0, Int(Date().timeIntervalSince1970 - startTime))
    }

    private var formatted: String {
        let s = elapsed
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m\(s % 60)s"
    }

    var body: some View {
        Text(formatted)
            .font(.caption2.monospacedDigit())
            .foregroundStyle(.secondary)
            .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { t in
                now = t
            }
    }
}

