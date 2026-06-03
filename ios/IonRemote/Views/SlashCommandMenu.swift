import SwiftUI

/// Popup menu showing filtered slash commands above the input bar.
struct SlashCommandMenu: View {
    let filter: String
    let commands: [DiscoveredSlashCommand]
    let onSelect: (DiscoveredSlashCommand) -> Void

    private static let scopeOrder: [String: Int] = [
        "builtin": 0, "project": 1, "extension": 2, "user": 3,
    ]

    private static let scopeLabels: [String: String] = [
        "project": "Project", "extension": "Extension", "user": "User",
    ]

    private var filteredCommands: [DiscoveredSlashCommand] {
        // Fuzzy-match and sort: score desc → scope order → alphabetical.
        let results: [(cmd: DiscoveredSlashCommand, score: Int)] = commands.compactMap { cmd in
            guard let score = FuzzyMatch.score(query: filter, candidate: "/\(cmd.name)") else {
                return nil
            }
            return (cmd, score)
        }
        return results.sorted { a, b in
            if a.score != b.score { return a.score > b.score }
            let aOrder = Self.scopeOrder[a.cmd.scope] ?? 99
            let bOrder = Self.scopeOrder[b.cmd.scope] ?? 99
            if aOrder != bOrder { return aOrder < bOrder }
            return a.cmd.name.localizedCaseInsensitiveCompare(b.cmd.name) == .orderedAscending
        }.map(\.cmd)
    }

    var body: some View {
        let items = filteredCommands
        if items.isEmpty {
            EmptyView()
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.name) { index, cmd in
                        let prevScope = index > 0 ? items[index - 1].scope : nil
                        let showHeader = cmd.scope != "builtin" && cmd.scope != prevScope

                        if showHeader {
                            sectionHeader(cmd.scope)
                        }

                        commandRow(cmd)
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(maxHeight: 260)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.large))
            .shadow(color: .black.opacity(0.15), radius: 8, y: -2)
            .padding(.horizontal)
        }
    }

    @ViewBuilder
    private func sectionHeader(_ scope: String) -> some View {
        Text(Self.scopeLabels[scope] ?? scope.capitalized)
            .font(.caption2)
            .fontWeight(.medium)
            .textCase(.uppercase)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 2)
    }

    private func commandRow(_ cmd: DiscoveredSlashCommand) -> some View {
        Button {
            onSelect(cmd)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: iconName(for: cmd.scope))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: 20, height: 20)

                VStack(alignment: .leading, spacing: 1) {
                    Text("/\(cmd.name)")
                        .font(.system(.caption, design: .monospaced))
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)

                    if !cmd.description.isEmpty {
                        Text(cmd.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
    }

    private func iconName(for scope: String) -> String {
        switch scope {
        case "builtin": return "terminal.fill"
        case "project": return "folder.fill"
        case "extension": return "puzzlepiece.fill"
        case "user": return "person.fill"
        default: return "questionmark.circle"
        }
    }
}
