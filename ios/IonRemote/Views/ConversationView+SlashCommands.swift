import SwiftUI

// MARK: - ConversationView slash-command autocomplete

/// Slash-command autocomplete: filesystem-discovered + `/clear` builtin +
/// extension-registered commands, plus the filter-text matcher and the
/// discovery trigger. Split from ConversationView.swift at the 600-line size
/// cap, mirroring the ConversationView+Presentation extraction.
extension ConversationView {
    /// Merged slash commands for autocomplete: filesystem-discovered + /clear builtin + extension-registered.
    var slashCommands: [DiscoveredSlashCommand] {
        var cmds = viewModel.discoveredCommands[workingDirectory] ?? []

        // Inject the /clear builtin (matches desktop's SLASH_COMMANDS constant).
        let clearCmd = DiscoveredSlashCommand(
            name: "clear", description: "Clear conversation history",
            scope: "builtin", source: "builtin", origin: nil
        )
        if !cmds.contains(where: { $0.name == "clear" }) {
            cmds.insert(clearCmd, at: 0)
        }

        // Merge extension-registered commands from engine_command_registry.
        if let extCmds = viewModel.extensionCommands[compoundKey] {
            for ec in extCmds where !cmds.contains(where: { $0.name == ec.name }) {
                cmds.append(DiscoveredSlashCommand(
                    name: ec.name,
                    description: ec.description ?? ec.name,
                    scope: "extension",
                    source: "extension",
                    origin: nil
                ))
            }
        }
        return cmds
    }

    func updateSlashFilter(_ text: String) {
        let pattern = #"^\/[a-zA-Z0-9_:\-]*$"#
        if text.range(of: pattern, options: .regularExpression) != nil {
            slashFilter = text
        } else {
            slashFilter = nil
        }
    }

    func fetchCommandsIfNeeded() {
        let dir = workingDirectory
        guard !dir.isEmpty, viewModel.discoveredCommands[dir] == nil else { return }
        viewModel.discoverCommands(directory: dir)
    }
}
