import SwiftUI

// MARK: - Tool description helper

func toolDescriptionText(name: String?, input: String?) -> String? {
    guard let name, let input, !input.isEmpty,
          let data = input.data(using: .utf8) else {
        return nil
    }
    let json: [String: Any]
    do {
        guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            DiagnosticLog.log("tool input JSON has unexpected shape", tag: "view.tool", level: .warn, fields: ["tool": name])
            return nil
        }
        json = parsed
    } catch {
        DiagnosticLog.log("tool input JSON decode failed", tag: "view.tool", level: .warn, fields: [
            "tool": name,
            "error": String(describing: error)
        ])
        return nil
    }

    switch name {
    case "Bash":
        guard var command = json["command"] as? String else { return nil }
        if let range = command.range(of: #"^cd [^&]+ && "#, options: .regularExpression) {
            command.removeSubrange(range)
        }
        return String(command.prefix(60))
    case "Read", "Edit", "Write", "NotebookEdit":
        return json["file_path"] as? String ?? json["path"] as? String
    case "Glob", "Grep": return json["pattern"] as? String
    case "WebSearch": return json["query"] as? String ?? json["search_query"] as? String
    case "WebFetch": return json["url"] as? String
    case "Agent": return json["description"] as? String ?? json["prompt"] as? String
    default: return nil
    }
}

// MARK: - Tool-call atoms

/// Renders consecutive tool calls as transcript atoms. Settled runs larger than
/// three collapse to one disclosure row, while a running call always remains
/// visible. This keeps execution legible without turning tool activity into a
/// second transcript.
struct EngineToolGroupRow: View {
    let tools: [Message]
    var activeBackgroundTasks: [BackgroundTaskState] = []
    var tabId: String? = nil
    @Environment(\.appTheme) private var theme
    @State private var isExpanded = false

    private var completedTools: [Message] {
        tools.filter { $0.toolStatus != .running }
    }

    private var hasRunningTool: Bool {
        tools.contains { $0.toolStatus == .running }
    }

    private var hasAsyncPending: Bool {
        tools.contains { $0.toolStatus == .asyncPending }
    }

    private var collapses: Bool {
        !hasRunningTool && completedTools.count > 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            if collapses && !isExpanded {
                Button { isExpanded = true } label: {
                    HStack(spacing: IonSpace.hairlineGap) {
                        Image(systemName: "command")
                        Text("\(completedTools.count) tool calls")
                            .foregroundStyle(hasAsyncPending ? theme.statusBash : theme.textTertiary)
                        Image(systemName: "chevron.right")
                        Spacer(minLength: 0)
                    }
                    .font(IonType.microLabel)
                    .foregroundStyle(theme.textTertiary)
                    .padding(.leading, IonSpace.screenInset)
                }
                .buttonStyle(.plain)
            } else {
                ForEach(tools) { tool in
                    ToolCallAtom(message: tool)
                }
            }

            ActiveBackgroundSummary(
                tools: tools,
                activeTasks: activeBackgroundTasks,
                tabId: tabId
            )
        }
    }
}

private struct ToolCallAtom: View {
    @Environment(\.appTheme) private var theme
    let message: Message
    @State private var isBashExpanded = false

    private var isRunning: Bool { message.toolStatus == .running }
    private var isBash: Bool { message.toolName == "Bash" }
    private var argument: String { toolDescriptionText(name: message.toolName, input: message.toolInput) ?? "" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Button {
                    if isBash { isBashExpanded.toggle() }
                } label: {
                    HStack(spacing: IonSpace.hairlineGap) {
                        Image(systemName: message.toolStatus == .asyncPending ? "clock.arrow.circlepath" : "command")
                            .font(IonType.metadata)
                            .foregroundStyle(message.toolStatus == .asyncPending ? theme.statusBash : theme.textTertiary)
                        Text(message.toolName ?? "Tool")
                            .font(IonType.meaning)
                            .foregroundStyle(isRunning ? theme.textPrimary : theme.textSecondary)
                        if !argument.isEmpty {
                            Text(argument)
                                .font(IonType.mono)
                                .foregroundStyle(theme.textTertiary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        if isRunning, let elapsed = elapsed(at: context.date) {
                            Text(elapsed)
                                .font(IonType.metadata)
                                .foregroundStyle(theme.textTertiary)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, IonSpace.screenInset)
                }
                .buttonStyle(.plain)
                .disabled(!isBash)
                .onAppear {
                    if isBash && isRunning { isBashExpanded = true }
                }

                if isBash && isRunning && isBashExpanded {
                    Text(argument)
                        .font(IonType.mono)
                        .foregroundStyle(theme.textTertiary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(IonSpace.contentGap)
                        .background(theme.surfaceSunken)
                        .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
                        .padding(.leading, IonSpace.screenInset)
                }
            }
        }
    }

    private func elapsed(at now: Date) -> String? {
        guard let timestamp = message.timestamp else { return nil }
        let seconds = Int(now.timeIntervalSince1970 - timestamp / 1000)
        guard seconds >= 2 else { return nil }
        return "\(seconds)s"
    }
}
