import SwiftUI

/// Thin context-occupancy fill strip at the top of a conversation.
///
/// Renders the same number the status-bar ring does — both resolve through
/// `ConversationStatusBar.resolveContextPercent` (tokens over the SELECTED
/// model's window, falling back to the engine's own percent), so the two
/// surfaces cannot disagree.
///
/// The FILL clamps at 100 because a bar cannot render 220% of its own width.
/// The true uncapped figure lives on the ring's accessibility label and in
/// the status drawer — the clamp is a geometry constraint, never a truth
/// constraint.
struct ConversationContextStrip: View {
    let statusFields: StatusFields?
    let modelOverride: String?
    let preferredModel: String
    let availableModels: [RemoteModelEntry]

    /// Resolved occupancy, or nil when there is nothing to show.
    var percent: Double? {
        guard let fields = statusFields else { return nil }
        let window = ConversationStatusBar.windowForModel(
            modelOverride ?? preferredModel,
            availableModels: availableModels,
            engineContextWindow: fields.contextWindow > 0 ? fields.contextWindow : nil,
        )
        return ConversationStatusBar.resolveContextPercent(
            contextPercent: fields.contextPercent,
            contextTokens: fields.contextTokens,
            selectedModelWindow: window,
        )
    }

    /// Threshold color. Delegates to ContextUsageRing, which owns the single
    /// ladder. This previously carried its own copy that returned .green at the
    /// normal level while the status-bar ring directly above returned
    /// .secondary — the same occupancy rendered two different colors.
    static func color(_ percent: Double) -> Color {
        ContextUsageRing.color(for: percent)
    }

    var body: some View {
        if let pct = percent {
            GeometryReader { geo in
                Rectangle()
                    .fill(Self.color(pct))
                    .frame(width: geo.size.width * min(CGFloat(pct) / 100, 1))
            }
            .frame(height: 3)
            .background(Color(.tertiarySystemFill))
        }
    }
}
