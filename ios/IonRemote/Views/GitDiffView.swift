import SwiftUI

/// Full-screen diff viewer for a single file's changes.
/// Parses unified diff format and renders with color-coded lines.
struct GitDiffView: View {
    let fileName: String
    let diff: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                ScrollView([.horizontal, .vertical]) {
                    if diffLines.isEmpty {
                        Text("No changes")
                            .foregroundStyle(.secondary)
                            .padding(.top, 40) // design-geometry: 40pt inset beyond screenInset; off the 4pt ratio scale
                            .frame(width: geo.size.width)
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(diffLines.enumerated()), id: \.offset) { _, line in
                                diffLineRow(line)
                            }
                        }
                        .frame(minWidth: geo.size.width, alignment: .leading)
                        .padding(.bottom, 20) // design-geometry: 20pt gap between rowInset and sectionGap; off the 4pt ratio scale
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 1) {
                        Text(fileName)
                            .font(.subheadline.weight(.semibold))
                        if stats.insertions > 0 || stats.deletions > 0 {
                            HStack(spacing: 4) {
                                Text("+\(stats.insertions)")
                                    .foregroundStyle(.green)
                                Text("−\(stats.deletions)")
                                    .foregroundStyle(.red)
                            }
                            .font(.caption2)
                        }
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        UIPasteboard.general.string = diff
                        Haptic.success()
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    // MARK: - Diff line row

    @ViewBuilder
    private func diffLineRow(_ line: DiffLine) -> some View {
        if line.type == .hunk {
            Text(line.content)
                .font(.system(size: 11, design: .monospaced)) // design-type: column-aligned diff grid; row pins line numbers to 36pt and must stay baseline-aligned at a uniform size
                .foregroundStyle(.secondary)
                .padding(.horizontal, IonSpace.compactGap)
                .padding(.vertical, IonSpace.hairlineGap)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemFill))
        } else {
            HStack(spacing: 0) {
                // Old line number
                Text(line.oldLine.map { String($0) } ?? "")
                    .font(.system(size: 10, design: .monospaced)) // design-type: fixed 36pt line-number column in a coupled diff grid
                    .foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .trailing)
                    .padding(.trailing, IonSpace.hairlineGap)

                // New line number
                Text(line.newLine.map { String($0) } ?? "")
                    .font(.system(size: 10, design: .monospaced)) // design-type: fixed 36pt line-number column in a coupled diff grid
                    .foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .trailing)
                    .padding(.trailing, IonSpace.hairlineGap)

                // Prefix character
                Text(line.type == .add ? "+" : line.type == .remove ? "-" : " ")
                    .font(.system(size: 11, design: .monospaced)) // design-type: diff prefix glyph aligned with content row at a uniform size
                    .foregroundStyle(lineColor(line.type))

                // Content
                Text(line.content)
                    .font(.system(size: 11, design: .monospaced)) // design-type: column-aligned diff grid; content row must stay baseline-aligned with the fixed 36pt number columns
                    .foregroundStyle(lineColor(line.type))
                    .textSelection(.enabled)
            }
            .padding(.horizontal, IonSpace.hairlineGap)
            .padding(.vertical, 1) // design-geometry: sub-hairline 1pt inset; below the 4pt rhythm floor
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(lineBackground(line.type))
        }
    }

    private func lineColor(_ type: DiffLineType) -> Color {
        switch type {
        case .add: return theme.statusDone
        case .remove: return theme.statusError
        case .context, .hunk: return .secondary
        }
    }

    private func lineBackground(_ type: DiffLineType) -> Color {
        switch type {
        case .add: return theme.statusDone.opacity(0.1)
        case .remove: return theme.statusError.opacity(0.1)
        case .context, .hunk: return .clear
        }
    }

    // MARK: - Diff parsing

    private var diffLines: [DiffLine] {
        Self.parseDiff(diff)
    }

    private var stats: (insertions: Int, deletions: Int) {
        let lines = diffLines
        let ins = lines.filter { $0.type == .add }.count
        let del = lines.filter { $0.type == .remove }.count
        return (ins, del)
    }

    fileprivate static func parseDiff(_ raw: String) -> [DiffLine] {
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var result: [DiffLine] = []
        var oldLine = 0
        var newLine = 0
        var inHeader = true

        for line in lines {
            if inHeader {
                if line.hasPrefix("diff --git") || line.hasPrefix("index ") ||
                    line.hasPrefix("--- ") || line.hasPrefix("+++ ") ||
                    line.hasPrefix("new file") || line.hasPrefix("deleted file") ||
                    line.hasPrefix("old mode") || line.hasPrefix("new mode") ||
                    line.hasPrefix("similarity") || line.hasPrefix("rename") ||
                    line.hasPrefix("Binary") {
                    continue
                }
                inHeader = false
            }

            if line.hasPrefix("@@") {
                let pattern = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
                if let match = line.firstMatch(of: pattern) {
                    oldLine = Int(match.1)!
                    newLine = Int(match.2)!
                }
                result.append(DiffLine(type: .hunk, content: line, oldLine: nil, newLine: nil))
            } else if line.hasPrefix("+") {
                let content = String(line.dropFirst())
                result.append(DiffLine(type: .add, content: content, oldLine: nil, newLine: newLine))
                newLine += 1
            } else if line.hasPrefix("-") {
                let content = String(line.dropFirst())
                result.append(DiffLine(type: .remove, content: content, oldLine: oldLine, newLine: nil))
                oldLine += 1
            } else {
                let content = line.hasPrefix(" ") ? String(line.dropFirst()) : line
                if line.trimmingCharacters(in: .whitespaces).isEmpty && result.isEmpty { continue }
                result.append(DiffLine(type: .context, content: content, oldLine: oldLine, newLine: newLine))
                oldLine += 1
                newLine += 1
            }
        }

        return result
    }
}

// MARK: - Diff line model

private enum DiffLineType {
    case add, remove, context, hunk
}

private struct DiffLine {
    let type: DiffLineType
    let content: String
    let oldLine: Int?
    let newLine: Int?
}
