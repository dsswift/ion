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
    @State private var showCopyButton = false
    @State private var showCopiedCheck = false

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

    // MARK: - Timestamp helper

    private var relativeTimestamp: String {
        let date = Date(timeIntervalSince1970: message.timestamp / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
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
                HStack(spacing: 0) {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(IonTheme.accent)
                        .frame(width: 2.5)
                    MarkdownContentView(
                        blocks: MarkdownBlockCache.shared.blocks(for: message.content)
                    )
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .background(
                    ZStack {
                        Color(.tertiarySystemBackground)
                        IonTheme.userBubbleTint
                    }
                )
                .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.large))
                .overlay(
                    message.content.hasPrefix("! ")
                        ? RoundedRectangle(cornerRadius: IonTheme.Radius.large)
                            .stroke(Color(hex: 0xF472B6, opacity: 0.5), lineWidth: 2)
                        : nil
                )

                Text(relativeTimestamp)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
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
            ZStack(alignment: .bottomTrailing) {
                VStack(alignment: .leading, spacing: 4) {
                    if !message.content.isEmpty {
                        MarkdownContentView(
                            blocks: MarkdownBlockCache.shared.blocks(for: message.content)
                        )
                        .textSelection(.enabled)
                    }

                    // Blinking cursor for streaming
                    if isRunning && message.isAssistant {
                        RoundedRectangle(cornerRadius: 0.5)
                            .fill(Color.primary)
                            .frame(width: 2, height: 18)
                            .modifier(BlinkingModifier())
                    }
                }

                // Copy button overlay
                if showCopyButton {
                    Button {
                        UIPasteboard.general.string = copyableContent ?? message.content
                        withAnimation(.easeInOut(duration: 0.2)) {
                            showCopiedCheck = true
                        }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                            withAnimation { showCopiedCheck = false }
                        }
                    } label: {
                        Image(systemName: showCopiedCheck ? "checkmark" : "doc.on.doc")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(6)
                            .background(.ultraThinMaterial)
                            .clipShape(Circle())
                    }
                    .transition(.opacity)
                    .padding(4)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: UIScreen.main.bounds.width * 0.92, alignment: .leading)
            .background(.ultraThinMaterial)
            .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.large))
            .contentShape(Rectangle())
            .onTapGesture {
                guard !showCopyButton else { return }
                withAnimation(.easeInOut(duration: 0.2)) { showCopyButton = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    withAnimation(.easeOut(duration: 0.3)) { showCopyButton = false }
                }
            }

            Text(relativeTimestamp)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.leading, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

    private var toolAccentColor: Color {
        switch message.toolStatus {
        case .running:  return .orange
        case .completed: return .green
        case .error:    return .red
        case nil:       return .gray
        }
    }

    private var toolBubble: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 1)
                .fill(toolAccentColor)
                .frame(width: 2)

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(IonTheme.snappySpring) {
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
        }
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 10))
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
        HStack(spacing: 8) {
            VStack { Divider() }
            Text(message.content)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .layoutPriority(1)
            VStack { Divider() }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 6)
    }
}

// MARK: - BlinkingModifier

struct BlinkingModifier: ViewModifier {
    @State private var pulse = false

    func body(content: Content) -> some View {
        content
            .opacity(pulse ? 0.3 : 1.0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                    pulse = true
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
