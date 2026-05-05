import SwiftUI

/// Popup menu showing filtered slash commands above the input bar.
struct SlashCommandMenu: View {
    let filter: String
    let commands: [DiscoveredSlashCommand]
    let onSelect: (DiscoveredSlashCommand) -> Void

    private var filteredCommands: [DiscoveredSlashCommand] {
        let query = filter.lowercased()
        let matches = commands.filter { cmd in
            "/\(cmd.name)".lowercased().hasPrefix(query)
        }
        // Sort: project commands first, then user, alphabetical within each group
        return matches.sorted { a, b in
            let scopeOrder = ["project": 0, "user": 1]
            let aOrder = scopeOrder[a.scope] ?? 2
            let bOrder = scopeOrder[b.scope] ?? 2
            if aOrder != bOrder { return aOrder < bOrder }
            return a.name.localizedCaseInsensitiveCompare(b.name) == .orderedAscending
        }
    }

    var body: some View {
        let items = filteredCommands
        if items.isEmpty {
            EmptyView()
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.name) { index, cmd in
                        let showHeader = index == 0 || items[index - 1].scope != cmd.scope

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
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.15), radius: 8, y: -2)
            .padding(.horizontal)
        }
    }

    @ViewBuilder
    private func sectionHeader(_ scope: String) -> some View {
        Text(scope == "project" ? "Project" : "User")
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
                Image(systemName: cmd.scope == "project" ? "folder.fill" : "person.fill")
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
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
