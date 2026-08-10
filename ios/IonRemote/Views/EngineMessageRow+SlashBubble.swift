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

extension Message {
    /// Resolve the slash-command pill segments for this message, preferring the
    /// engine-provided provenance (`slashCommand`/`slashArgs`) over re-parsing
    /// the display text. The engine persists the raw invocation as the display
    /// content AND the typed provenance fields; preferring the fields means the
    /// pill is correct even if the display text were ever reformatted. Falls back
    /// to parsing `fallbackText` for extension commands / optimistic bubbles that
    /// arrive before metadata. Returns nil when the message is not a slash
    /// invocation.
    func slashSegments(fallbackText: String) -> SlashCommandSegments? {
        if let cmd = slashCommand, !cmd.isEmpty {
            return SlashCommandSegments(command: cmd, args: slashArgs ?? "")
        }
        return parseSlashCommand(fallbackText)
    }

    /// Format model provenance badge text from the engine-resolved alias and
    /// effective model name. Returns e.g. "Standard · GPT-5.6 Terra" when both
    /// are present, just one when only one is set, or nil when neither exists.
    var slashModelDisplay: String? {
        let alias = slashModelAlias.map { value in
            guard let first = value.first else { return value }
            return first.uppercased() + value.dropFirst()
        }
        let bareModel = slashModelEffective?.split(separator: "/").last.map(String.init)
        let model = bareModel.flatMap(formatSlashModelLabel)
        switch (alias, model) {
        case let (alias?, model?):
            return "\(alias) · \(model)"
        case let (alias?, nil):
            return alias
        case let (nil, model?):
            return model
        case (nil, nil):
            return nil
        }
    }
}

private let gptSlashModelPattern: NSRegularExpression = {
    return try! NSRegularExpression(pattern: #"^gpt-(\d+)[.-](\d+)-([a-z][a-z0-9-]*)$"#)
}()

private func formatSlashModelLabel(_ model: String) -> String {
    let normalized = model.replacingOccurrences(
        of: #"\[[^\]]+\]"#,
        with: "",
        options: .regularExpression
    ).trimmingCharacters(in: .whitespacesAndNewlines)
    let nsModel = normalized as NSString
    let range = NSRange(location: 0, length: nsModel.length)
    if let match = gptSlashModelPattern.firstMatch(in: normalized, range: range), match.numberOfRanges == 4 {
        let major = nsModel.substring(with: match.range(at: 1))
        let minor = nsModel.substring(with: match.range(at: 2))
        let variant = nsModel.substring(with: match.range(at: 3))
        return "GPT \(major).\(minor) \(variant.prefix(1).uppercased())\(variant.dropFirst())"
    }

    let compact = normalized
        .replacingOccurrences(of: "claude-", with: "")
        .replacingOccurrences(of: #"-\d{8}$"#, with: "", options: .regularExpression)
    let familyVersion = compact.range(
        of: #"^([a-z]+)-(\d+)-(\d+)$"#,
        options: .regularExpression
    )
    if let familyVersion {
        let captures = compact[familyVersion].split(separator: "-")
        guard captures.count == 3 else { return normalized }
        let family = captures[0].prefix(1).uppercased() + captures[0].dropFirst().lowercased()
        return "\(family) \(captures[1]).\(captures[2])"
    }
    let familyMajor = compact.range(of: #"^([a-z]+)-(\d+)$"#, options: .regularExpression)
    if let familyMajor {
        let captures = compact[familyMajor].split(separator: "-")
        guard captures.count == 2 else { return normalized }
        let family = captures[0].prefix(1).uppercased() + captures[0].dropFirst().lowercased()
        return "\(family) \(captures[1])"
    }
    return normalized
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

            // Model provenance uses same compact capsule language as message
            // attachments, but remains non-interactive run metadata.
            if let modelDisplay = message.slashModelDisplay {
                HStack(spacing: 3) {
                    Image(systemName: "brain")
                        .font(.caption2)
                    Text(modelDisplay)
                        .font(.caption2.weight(.medium))
                        .lineLimit(1)
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Color(.secondarySystemFill))
                .clipShape(Capsule())
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("slash-model-pill")
            }

            // Args use same verbatim-markdown renderer as plain user bubbles,
            // preserving multiline invocations instead of reflowing them.
            if !args.isEmpty {
                MarkdownContentView(
                    blocks: MarkdownFormatter.parse(args, verbatim: true),
                    blockSpacing: 0,
                    blankLineHeight: 20
                )
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
