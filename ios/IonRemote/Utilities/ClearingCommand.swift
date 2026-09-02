import Foundation

/// Pre-send gate for a slash command that clears the conversation.
///
/// A command declaring `clears-conversation` frontmatter wipes the
/// conversation's model-visible history before its body runs. That is the point
/// of the flag — a review must judge work against a durable spec rather than
/// against the discussion that produced it, and a squash must read the
/// repository rather than a transcript. But it is also destructive from the
/// operator's seat: they typed a command and their conversation disappears.
///
/// The engine performs the clear unconditionally and never asks, because the
/// engine does not block for user input. So the confirmation belongs on the
/// client, before the prompt is ever sent.
///
/// This is the Swift mirror of
/// `desktop/src/renderer/components/InputBarClearingCommand.ts`. Both clients
/// must make the same decision for the same input, which is what
/// `ClearingCommandTests` pins.
enum ClearingCommand {

    /// What the operator is about to lose, plus the text to re-send on confirm.
    struct Pending: Equatable {
        /// Bare command name without the leading slash.
        let command: String
        /// Full text to re-submit once the operator confirms.
        let pendingInput: String
    }

    /// Extract the bare command name from raw input, or nil when the text is not
    /// a lone slash invocation.
    ///
    /// Only a command at the very start of the input counts. A "/" inside prose,
    /// a file path, or a longer message is not an invocation, and treating it as
    /// one would pop a destructive-action dialog over ordinary typing.
    static func parseCommandName(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else { return nil }

        let body = trimmed.dropFirst()
        guard let first = body.first, first.isLetter else { return nil }

        // Name charset matches the engine's slash parser: letters, digits,
        // underscore, colon, hyphen. The name ends at whitespace.
        var name = ""
        for ch in body {
            if ch.isWhitespace { break }
            guard ch.isLetter || ch.isNumber || ch == "_" || ch == ":" || ch == "-" else {
                return nil
            }
            name.append(ch)
        }
        return name.isEmpty ? nil : name
    }

    /// Decide whether this submission needs a clear-confirmation.
    ///
    /// Returns nil to let the send proceed untouched — the common case, and
    /// deliberately the default for every uncertainty:
    ///
    /// - not a slash invocation
    /// - a command the discovery feed does not know (an extension command, or a
    ///   feed that has not loaded yet)
    /// - a command that does not declare the flag
    /// - a conversation with no history to lose
    ///
    /// Failing open matters here. A missed confirmation costs the operator a
    /// clear they arguably asked for by typing the command; a spurious dialog on
    /// every ordinary message would train them to dismiss it without reading,
    /// which destroys the warning's value for the case that counts.
    static func resolve(
        input: String,
        hasHistory: Bool,
        commands: [DiscoveredSlashCommand]
    ) -> Pending? {
        guard hasHistory else { return nil }
        guard let name = parseCommandName(input) else { return nil }
        guard let match = commands.first(where: { $0.name == name }),
              match.clearsConversation == true else { return nil }
        return Pending(command: name, pendingInput: input)
    }

    /// Operator-facing dialog copy for a pending clearing command.
    static func message(for command: String) -> String {
        """
        /\(command) starts a fresh context boundary. It clears this conversation's history first, then runs with no prior context.

        The transcript stays readable, but the models will not see it again.
        """
    }
}
