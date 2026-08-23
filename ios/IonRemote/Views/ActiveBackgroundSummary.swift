import SwiftUI

/// Separate live rollup for background Bash tasks owned by one tool group.
/// The authoritative inventory comes from engine status and lifecycle events.
struct ActiveBackgroundSummary: View {
    let tools: [Message]
    let activeTasks: [BackgroundTaskState]
    let tabId: String?
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    @State private var isExpanded = false

    private var tasks: [BackgroundTaskState] {
        let ids = Set(tools.compactMap(\.backgroundTaskId))
        let toolIds = Set(tools.compactMap(\.toolId))
        return activeTasks
            .filter { ids.contains($0.taskId) || ($0.toolId.map(toolIds.contains) ?? false) }
            .sorted { $0.startedAt == $1.startedAt ? $0.taskId < $1.taskId : $0.startedAt < $1.startedAt }
    }

    var body: some View {
        if !tasks.isEmpty {
            VStack(alignment: .leading, spacing: IonSpace.compactInset) {
                Button {
                    withAnimation(.snappy(duration: 0.2)) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        ProgressView()
                            .scaleEffect(0.5)
                            .frame(width: 11, height: 11)
                            .tint(theme.statusBash)
                        Text(tasks.count == 1 ? "1 background task running" : "\(tasks.count) background tasks running")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(theme.statusBash)
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(theme.textSecondary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("active-background-summary")

                if isExpanded {
                    ForEach(tasks) { task in
                        HStack(spacing: IonSpace.compactGap) {
                            ProgressView().controlSize(.mini)
                            Text(task.command)
                                .font(IonType.mono)
                                .foregroundStyle(theme.textSecondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Spacer(minLength: IonSpace.compactGap)
                            if let tabId {
                                Button("Stop", role: .destructive) {
                                    viewModel.stopBackgroundTask(tabId: tabId, taskId: task.taskId)
                                }
                                .font(.caption.weight(.semibold))
                                .disabled(viewModel.stoppingBackgroundTaskIds.contains(task.taskId))
                                .accessibilityIdentifier("stop-background-task-\(task.taskId)")
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, IonSpace.compactGap)
            .padding(.vertical, IonSpace.compactInset)
            .background(theme.surfaceElevated.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
        }
    }
}
