import SwiftUI

// MARK: - ThinkingRowView (issue #158)
//
// Renders a single extended-thinking reasoning block as a collapsed-by-default
// row in the engine turn view. Collapsed-default matters more on mobile than
// on desktop: screen space is scarce and reasoning is supplementary, so the
// row stays a compact one-liner until the user taps to expand.
//
// Three render states, all driven off a single `.thinking` Message
// (synthesized by the accumulator in SessionViewModel+ThinkingEvents.swift):
//
//   1. Live (message.thinkingActive == true): an activity indicator pulses
//      next to a "Thinking…" label. Tapping expands to reveal the reasoning
//      text accumulated so far (deltas append in real time).
//   2. Historical with text (inactive, content non-empty): "💭 Thought"
//      header with the elapsed/token summary; expandable to the full text.
//   3. Summary-only (inactive, content empty): no expand affordance —
//      "💭 Thought for {n}s" (+ token estimate) when a duration is known, or
//      "🔒 redacted reasoning" when the block was encrypted. We never promise
//      text we don't have.
//
// Visual treatment is deliberately quiet (secondary foreground, no bubble
// chrome) so reasoning reads as a sidebar to the assistant's actual output,
// not a peer of it.
struct ThinkingRowView: View {
    @Environment(\.appTheme) private var theme
    let message: Message

    @State private var isExpanded = false

    /// True when the row has readable reasoning text to reveal. Redacted
    /// blocks and summary-only blocks (deltas gated off / history without
    /// text) have none, so they render without an expand affordance.
    private var hasText: Bool {
        !message.content.isEmpty && !message.thinkingRedacted
    }

    /// Whether the row can be tapped to expand. Live blocks are always
    /// expandable (text may still be arriving); finished blocks only when
    /// they actually carry text.
    private var isExpandable: Bool {
        message.thinkingActive || hasText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if isExpanded && hasText {
                Text(message.content)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color(.secondarySystemFill).opacity(0.5))
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
        .contentShape(Rectangle())
        .onTapGesture {
            guard isExpandable else { return }
            withAnimation(IonTheme.snappySpring) { isExpanded.toggle() }
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        HStack(spacing: 8) {
            if message.thinkingActive {
                // Live: pulse a small activity indicator beside "Thinking…".
                ProgressView()
                    .controlSize(.mini)
                Text("Thinking…")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            } else {
                Text(summaryLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if isExpandable {
                Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    /// The finished-block header label. Redacted blocks get the lock glyph;
    /// otherwise "💭 Thought" plus whatever summary detail is available.
    private var summaryLabel: String {
        if message.thinkingRedacted {
            return "🔒 redacted reasoning"
        }
        var label = "💭 Thought"
        if let seconds = message.thinkingElapsedSeconds {
            label += " for \(Self.formatSeconds(seconds))"
        }
        if let tokens = message.thinkingTotalTokens, tokens > 0 {
            label += " (~\(tokens) tokens)"
        }
        return label
    }

    /// Format the elapsed duration compactly: whole seconds under a minute
    /// ("14s"), m/s above ("1m 23s"). One decimal under 10s so very short
    /// reasoning bursts don't all read "0s".
    static func formatSeconds(_ seconds: Double) -> String {
        if seconds < 10 {
            return String(format: "%.1fs", seconds)
        }
        if seconds < 60 {
            return "\(Int(seconds.rounded()))s"
        }
        let total = Int(seconds.rounded())
        return "\(total / 60)m \(total % 60)s"
    }
}
