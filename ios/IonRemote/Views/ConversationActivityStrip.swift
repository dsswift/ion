import SwiftUI

/// One quiet line above the composer saying what the conversation is doing
/// right now: the engine's working message while a turn runs, or the
/// background work an idle orchestrator is still waiting on. Renders nothing
/// when nothing is happening, so an idle conversation has no status chrome at
/// all between the transcript and the composer.
///
/// The decision of WHETHER something is happening, and in which colour, is
/// `ConversationStatusBar.resolveRunActivity`; this view only draws it.
struct ConversationActivityStrip: View {
    @Environment(\.appTheme) private var theme
    let activity: ConversationStatusBar.RunActivity
    /// The engine's own progress line ("Reading files…"). Shown in place of
    /// the generic "running" label while the orchestrator runs; empty otherwise.
    let workingMessage: String
    /// The harness or extension driving this conversation, when the status
    /// fields name one.
    let extensionName: String?

    var body: some View {
        if activity.show {
            HStack(spacing: IonSpace.compactInset) {
                Circle()
                    .fill(color)
                    .frame(width: IonSpace.Metric.compactStatusDiameter, height: IonSpace.Metric.compactStatusDiameter)
                Text(label)
                    .font(IonType.metadata)
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let extensionName, !extensionName.isEmpty {
                    Text(extensionName)
                        .font(IonType.metadata)
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, IonSpace.rowInset)
            .padding(.bottom, IonSpace.compactInset)
            .accessibilityElement(children: .combine)
        }
    }

    /// The working message wins while the orchestrator runs: it is more
    /// specific than "running". Waiting states keep the resolver's label,
    /// which carries the agent or shell count.
    static func label(activity: ConversationStatusBar.RunActivity, workingMessage: String) -> String {
        if activity.isRunning, !workingMessage.isEmpty { return workingMessage }
        return activity.label
    }

    private var label: String { Self.label(activity: activity, workingMessage: workingMessage) }

    private var color: Color {
        if activity.isRunning { return theme.statusRunning }
        if activity.isWaitingShells { return theme.statusBash }
        return theme.statusWaitingChildren
    }
}
