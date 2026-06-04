import SwiftUI

// MARK: - Slash command bubble + parser
//
// Extracted from `EngineMessageRow.swift` on the josh branch so that file
// stops growing under its `@file-size-exception` annotation. The slash-
// bubble feature is a self-contained unit:
//
//   * `parseSlashCommand` / `SlashCommandSegments` — a pure-function
//     parser that splits a leading `/command args…` into a command and
//     args pair. Used by the user-bubble render paths in
//     `EngineMessageRow` to decide whether the message is a slash
//     command and should get a pill rendering.
//
//   * `EngineMessageRow.userBubbleContentWithSlash(...)` — the
//     slash-aware variant of `userBubbleContent` that draws the command
//     as a Capsule pill stacked above the args text, reusing the same
//     bubble chrome (background tint, accent stripe, bash outline) as
//     the plain text bubble.
//
// The split is purely organizational. No call sites changed; the
// extension method is a private member of `EngineMessageRow` and is
// invoked exactly as before. The split lowers EngineMessageRow.swift
// below the 800-line threshold and recovers headroom for future
// engine-message-row work without further extending the god file.

// MARK: - Slash command parsing

/// Result of parsing a leading slash command from a user message.
struct SlashCommandSegments {
    var command: String
    var args: String
}

private let slashCommandPattern: NSRegularExpression = {
    return try! NSRegularExpression(pattern: #"^\/([a-zA-Z][a-zA-Z0-9_:-]*)\s*([\s\S]*)$"#)
}()

/// Parses a leading slash command from `text`.
/// Returns `nil` when the text doesn't start with a recognisable `/command`.
/// Requires the command name to begin with a letter so filesystem paths
/// like `/usr/bin/foo` (multiple slash segments) never match.
func parseSlashCommand(_ text: String) -> SlashCommandSegments? {
    let ns = text as NSString
    let range = NSRange(location: 0, length: ns.length)
    guard let match = slashCommandPattern.firstMatch(in: text, range: range),
          match.numberOfRanges >= 3
    else { return nil }
    let cmd = "/\(ns.substring(with: match.range(at: 1)))"
    let args = ns.substring(with: match.range(at: 2))
    return SlashCommandSegments(command: cmd, args: args)
}

// MARK: - EngineMessageRow slash bubble

extension EngineMessageRow {
    /// Slash-command variant of the user bubble: renders a command pill above
    /// optional args text, reusing the same bubble chrome as `userBubbleContent`.
    @ViewBuilder
    func userBubbleContentWithSlash(command: String, args: String, isBash: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            // Command badge pill
            Text(command)
                .font(.caption.monospaced().weight(.semibold))
                .foregroundStyle(theme.accent)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(theme.accent.opacity(0.12))
                .clipShape(Capsule())

            // Args text (omitted when command has no arguments)
            if !args.isEmpty {
                Text(args)
                    .textSelection(.enabled)
            }
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .padding(.vertical, 8)
        .background(
            ZStack {
                Color(.tertiarySystemBackground)
                theme.userBubbleTint
            }
        )
        .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.large))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(theme.accent)
                .frame(width: 2.5)
                .padding(.vertical, 4)
                .padding(.leading, 1)
        }
        .overlay(
            isBash
                ? RoundedRectangle(cornerRadius: IonTheme.Radius.large)
                    .stroke(Color(hex: 0xF472B6, opacity: 0.5), lineWidth: 2)
                : nil
        )
    }
}
