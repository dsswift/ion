import SwiftUI

/// Full-screen diff viewer for a single file's changes.
/// Parses unified diff format and renders with color-coded lines.
struct GitDiffView: View {
    let fileName: String
    let diff: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                ScrollView([.horizontal, .vertical]) {
                    if diffLines.isEmpty {
                        Text("No changes")
                            .foregroundStyle(.secondary)
                            .padding(.top, 40)
                            .frame(width: geo.size.width)
                    } else {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(diffLines.enumerated()), id: \.offset) { _, line in
                                diffLineRow(line)
                            }
                        }
                        .frame(minWidth: geo.size.width, alignment: .leading)
                        .padding(.bottom, 20)
                    }
                }
            }
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
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
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.tertiarySystemFill))
        } else {
            HStack(spacing: 0) {
                // Old line number
                Text(line.oldLine.map { String($0) } ?? "")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .trailing)
                    .padding(.trailing, 4)

                // New line number
                Text(line.newLine.map { String($0) } ?? "")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .trailing)
                    .padding(.trailing, 4)

                // Prefix character
                Text(line.type == .add ? "+" : line.type == .remove ? "-" : " ")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(lineColor(line.type))

                // Content
                Text(line.content)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(lineColor(line.type))
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(lineBackground(line.type))
        }
    }

    private func lineColor(_ type: DiffLineType) -> Color {
        switch type {
        case .add: return .green
        case .remove: return .red
        case .context, .hunk: return .secondary
        }
    }

    private func lineBackground(_ type: DiffLineType) -> Color {
        switch type {
        case .add: return Color.green.opacity(0.1)
        case .remove: return Color.red.opacity(0.1)
        case .context, .hunk: return .clear
        }
    }

    // MARK: - Diff parsing

    private var diffLines: [DiffLine] {
        Self.parseDiff(diff)
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
