import SwiftUI

// MARK: - Tool description helper

/// Extracts a short human-readable description from the assembled toolInput JSON,
/// mirroring desktop's getToolDescription in tool-helpers.ts.
func toolDescriptionText(name: String?, input: String?) -> String? {
    guard let name,
          let input,
          !input.isEmpty,
          let data = input.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }

    switch name {
    case "Bash":
        guard var cmd = json["command"] as? String else { return nil }
        // Strip leading "cd <dir> && " prefix, mirroring desktop stripCdPrefix.
        if let range = cmd.range(of: #"^cd [^&]+ && "#, options: .regularExpression) {
            cmd.removeSubrange(range)
        }
        return String(cmd.prefix(60))
    case "Read", "Edit", "Write", "NotebookEdit":
        return json["file_path"] as? String ?? json["path"] as? String
    case "Glob":
        return json["pattern"] as? String
    case "Grep":
        return json["pattern"] as? String
    case "WebSearch":
        return json["query"] as? String ?? json["search_query"] as? String
    case "WebFetch":
        return json["url"] as? String
    case "Agent":
        if let desc = json["description"] as? String { return String(desc.prefix(60)) }
        if let prompt = json["prompt"] as? String { return String(prompt.prefix(60)) }
        return nil
    default:
        return nil
    }
}

// MARK: - EngineToolGroupRow

/// Collapsible row that groups consecutive tool messages in the engine conversation.
struct EngineToolGroupRow: View {
    let tools: [Message]
    @State private var isExpanded = false
    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: compositeIcon)
                        .font(.caption2)
                        .foregroundStyle(compositeColor)
                    Text(summaryText)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(spacing: 2) {
                    ForEach(tools) { tool in
                        HStack(spacing: 6) {
                            toolIcon(for: tool)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(tool.toolName ?? "tool")
                                    .font(.caption2)
                                    .foregroundStyle(theme.textSecondary)
                                if let desc = toolDescriptionText(name: tool.toolName, input: tool.toolInput) {
                                    Text(desc)
                                        .font(.caption2)
                                        .foregroundStyle(theme.textSecondary.opacity(0.6))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .background(theme.surfaceElevated.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var compositeIcon: String {
        if tools.contains(where: { $0.toolStatus == .running }) { return "arrow.triangle.2.circlepath" }
        // No running tools — settled == total.
        let summary = toolGroupFailureSummary(tools)
        if summary.failed == 0 { return "checkmark.circle.fill" }
        if summary.failed == summary.total { return "xmark.circle.fill" }
        return "exclamationmark.triangle.fill"
    }

    private var compositeColor: Color {
        if tools.contains(where: { $0.toolStatus == .running }) { return theme.statusRunning }
        // No running tools — settled == total.
        let summary = toolGroupFailureSummary(tools)
        if summary.failed == 0 { return theme.statusDone }
        if summary.failed == summary.total { return theme.statusError }
        return theme.statusWarning
    }

    private var summaryText: String {
        let names = Set(tools.compactMap(\.toolName))
        // For single-tool groups, append the tool's description to the header
        // (e.g. "Bash: git status"). Multi-tool groups show names only — adding
        // per-tool detail to a collapsed multi-tool header is noise.
        if tools.count == 1, let only = tools.first {
            let name = only.toolName ?? "tool"
            if let desc = toolDescriptionText(name: only.toolName, input: only.toolInput) {
                let base = "\(name): \(desc)"
                let summary = toolGroupFailureSummary(tools)
                guard !summary.running, summary.failed > 0 else { return base }
                return "\(base), failed"
            }
        }
        let base = names.count <= 2 ? names.sorted().joined(separator: ", ") : "\(tools.count) tools"
        let summary = toolGroupFailureSummary(tools)
        // Suppress failure suffix while any tool is still running.
        guard !summary.running, summary.failed > 0 else { return base }
        // No running tools — settled == total.
        if summary.failed == summary.total { return "\(base), all failed" }
        return "\(base), \(summary.failed) failed"
    }

    @ViewBuilder
    private func toolIcon(for tool: Message) -> some View {
        switch tool.toolStatus {
        case .running:
            ProgressView().scaleEffect(0.6)
        case .completed:
            Image(systemName: "checkmark.circle.fill").font(.caption2).foregroundStyle(theme.statusDone)
        case .error:
            Image(systemName: "xmark.circle.fill").font(.caption2).foregroundStyle(theme.statusError)
        case nil:
            Image(systemName: "wrench").font(.caption2).foregroundStyle(theme.textSecondary)
        }
    }
}
