import SwiftUI

// MARK: - MessageBubble

struct MessageBubble: View {
    let message: Message
    var isRunning: Bool = false
    var onRewind: ((String) -> Void)?
    var onFork: ((String) -> Void)?
    var copyableContent: String?

    @State private var isToolExpanded = false
    @State private var showRewindConfirm = false

    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            assistantBubble
        case .tool:
            toolBubble
        case .system:
            systemBubble
        }
    }

    // MARK: - User

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 24)
            VStack(alignment: .trailing, spacing: 4) {
                if let source = message.source, source == .remote {
                    HStack(spacing: 4) {
                        Image(systemName: "iphone")
                            .font(.caption2)
                        Text("from iOS")
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }
                MarkdownContentView(
                    blocks: MarkdownBlockCache.shared.blocks(for: message.content)
                )
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(hex: 0x4ECDC4).opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    message.content.hasPrefix("! ")
                        ? RoundedRectangle(cornerRadius: 12)
                            .stroke(Color(hex: 0xF472B6, opacity: 0.5), lineWidth: 2)
                        : nil
                )
            }
            .padding(.trailing, 12)
            .padding(.vertical, 2)
        }
        .contextMenu {
            Button { UIPasteboard.general.string = message.content } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: message.content) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            if onRewind != nil || onFork != nil {
                Divider()
            }
            if onRewind != nil {
                Button { showRewindConfirm = true } label: {
                    Label("Rewind to Here", systemImage: "arrow.counterclockwise")
                }
            }
            if let onFork {
                Button { onFork(message.id) } label: {
                    Label("Fork from Here", systemImage: "arrow.triangle.branch")
                }
            }
        }
        .confirmationDialog(
            "Rewind Conversation",
            isPresented: $showRewindConfirm,
            titleVisibility: .visible
        ) {
            Button("Rewind", role: .destructive) {
                onRewind?(message.id)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will reset the conversation to before this message. This cannot be undone.")
        }
    }

    // MARK: - Assistant

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !message.content.isEmpty {
                MarkdownContentView(
                    blocks: MarkdownBlockCache.shared.blocks(for: message.content)
                )
                .textSelection(.enabled)
            }

            // Blinking cursor for streaming
            if isRunning && message.isAssistant {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.primary)
                    .frame(width: 8, height: 16)
                    .opacity(0.6)
                    .modifier(BlinkingModifier())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
        .contextMenu {
            Button {
                UIPasteboard.general.string = copyableContent ?? message.content
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: copyableContent ?? message.content) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        } preview: {
            Text(message.content.prefix(200) + (message.content.count > 200 ? "…" : ""))
                .font(.body)
                .padding()
                .frame(maxWidth: 300, alignment: .leading)
        }
    }

    // MARK: - Tool

    private var toolBubble: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isToolExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    toolStatusIcon

                    Text(message.toolName ?? "Tool")
                        .font(.subheadline.monospaced())
                        .foregroundStyle(.primary)

                    Spacer()

                    Image(systemName: isToolExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            if isToolExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if let input = message.toolInput, !input.isEmpty {
                        Text("Input:")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        Text(input)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(10)
                    }
                    if !message.content.isEmpty {
                        Text(message.toolStatus == .error ? "Error:" : "Result:")
                            .font(.caption.bold())
                            .foregroundStyle(message.toolStatus == .error ? .red : .secondary)
                        Text(message.content)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(20)
                            .foregroundStyle(message.toolStatus == .error ? .red : .primary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
    }

    private var toolStatusIcon: some View {
        Group {
            switch message.toolStatus {
            case .running:
                ProgressView()
                    .controlSize(.mini)
            case .completed:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            case .error:
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .font(.subheadline)
            case nil:
                Image(systemName: "gearshape")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            }
        }
    }

    // MARK: - System

    private var systemBubble: some View {
        HStack {
            Spacer()
            Text(message.content)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

// MARK: - BlinkingModifier

struct BlinkingModifier: ViewModifier {
    @State private var isVisible = true

    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                    isVisible = false
                }
            }
    }
}

// MARK: - Color hex init

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: - MarkdownBlockCache

/// Caches parsed `[MarkdownBlock]` arrays so full block-level markdown is only
/// parsed once per unique content string, not on every SwiftUI re-render.
@MainActor
final class MarkdownBlockCache {
    static let shared = MarkdownBlockCache()

    private let cache = NSCache<NSString, CacheEntry>()

    private class CacheEntry {
        let value: [MarkdownBlock]
        init(_ value: [MarkdownBlock]) { self.value = value }
    }

    init() {
        cache.countLimit = 200
    }

    func blocks(for content: String) -> [MarkdownBlock] {
        let key = content as NSString
        if let entry = cache.object(forKey: key) {
            return entry.value
        }
        let result = MarkdownFormatter.parse(content)
        cache.setObject(CacheEntry(result), forKey: key)
        return result
    }
}
