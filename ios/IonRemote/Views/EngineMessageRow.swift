// @file-size-exception: unified rendering component absorbing MessageBubble and ToolGroupView; slash-bubble decomposed to EngineMessageRow+SlashBubble.swift; further decomposition deferred to Workstream C
import SwiftUI

// MARK: - EngineMessageRow

/// Renders a single conversation message based on role.
///
/// In engine-view usage (no extra params) it renders a compact, engine-style
/// row. In conversation-view usage the optional params unlock the full rich
/// rendering: timestamps, copy/share/rewind context menus, voice overlays,
/// blinking cursor, and attachment previews.
struct EngineMessageRow: View {
    @Environment(\.appTheme) var theme
    let message: Message

    // Conversation-view enrichment params (nil = engine-view compact mode)
    var copyableContent: String? = nil
    var onRewind: ((String) -> Void)? = nil
    var onFork: ((String) -> Void)? = nil
    var isSpeaking: Bool = false
    var isRunning: Bool = false
    var onSkipSpeaking: (() -> Void)? = nil
    var onStopAllSpeaking: (() -> Void)? = nil
    var hasPendingSpeech: Bool = false

    // Shared state
    @State private var previewImage: UIImage?
    @State private var previewName: String = ""

    // Conversation-view-only state
    @State private var isToolExpanded = false
    @State private var showRewindConfirm = false
    @State private var showCopyButton = false
    @State private var showCopiedCheck = false
    @State private var containerWidth: CGFloat = UIScreen.main.bounds.width

    /// True when operating in full conversation-view mode.
    private var isConversationMode: Bool {
        copyableContent != nil || onRewind != nil || onFork != nil || isSpeaking || isRunning || onSkipSpeaking != nil
    }

    var body: some View {
        Group {
            switch message.role {
            case .user:
                userMessage
            case .assistant:
                assistantMessage
            case .harness:
                harnessMessage
            case .tool:
                toolMessage
            case .system:
                systemMessage
            }
        }
        .sheet(isPresented: Binding(
            get: { previewImage != nil },
            set: { if !$0 { previewImage = nil; previewName = "" } }
        )) {
            if let img = previewImage {
                AttachmentImagePreview(image: img, name: previewName)
            }
        }
        .background(
            isConversationMode
                ? GeometryReader { geo in
                    Color.clear.preference(key: ContainerWidthKey.self, value: geo.size.width)
                }
                : nil
        )
        .onPreferenceChange(ContainerWidthKey.self) { containerWidth = $0 }
    }

    // MARK: - Timestamp helper

    private var relativeTimestamp: String {
        let date = Date(timeIntervalSince1970: (message.timestamp ?? 0) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Attachment views (conversation mode)

    @ViewBuilder
    private func attachmentViews(_ attachments: [MessageAttachment]) -> some View {
        VStack(alignment: .trailing, spacing: 4) {
            ForEach(attachments) { att in
                let img = AttachmentImageCache.shared.image(forKey: att.id)
                    ?? AttachmentImageCache.shared.image(forKey: att.path)
                if att.type == .image, let img {
                    Image(uiImage: img)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: 200)
                        .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                        .onTapGesture {
                            previewName = att.name
                            previewImage = img
                        }
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: att.type == .image ? "photo" : "doc")
                            .font(.caption2)
                        Text(att.name)
                            .font(.caption2)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.secondarySystemFill))
                    .clipShape(Capsule())
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - User

    private var userMessage: some View {
        Group {
            if isConversationMode {
                conversationUserBubble
            } else {
                engineUserBubble
            }
        }
    }

    /// Full conversation-view user bubble: source badge, attachments, bash
    /// highlight, timestamp, context menu with rewind/fork.
    private var conversationUserBubble: some View {
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

                if let attachments = message.attachments, !attachments.isEmpty {
                    attachmentViews(attachments)
                }

                let segments = parseAttachmentSegments(message.content)
                let attachmentPaths = Set((message.attachments ?? []).filter { $0.type == .image }.map { $0.path })
                let extraImagePaths = segments.images.filter { !attachmentPaths.contains($0) }
                ForEach(Array(extraImagePaths.enumerated()), id: \.offset) { _, path in
                    InlineAttachmentImage(path: path) { img in
                        previewName = (path as NSString).lastPathComponent
                        previewImage = img
                    }
                }

                if !segments.text.isEmpty {
                    let cap = UIScreen.main.bounds.width * 0.8
                    let isBash = message.content.hasPrefix("! ")
                    let slash = parseSlashCommand(segments.text)
                    ViewThatFits(in: .horizontal) {
                        Group {
                            if let slash {
                                userBubbleContentWithSlash(command: slash.command, args: slash.args, isBash: isBash)
                            } else {
                                userBubbleContent(text: segments.text, isBash: isBash)
                            }
                        }
                        .fixedSize(horizontal: true, vertical: true)
                        Group {
                            if let slash {
                                userBubbleContentWithSlash(command: slash.command, args: slash.args, isBash: isBash)
                            } else {
                                userBubbleContent(text: segments.text, isBash: isBash)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: cap, alignment: .trailing)
                }

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

    /// Engine-view compact user bubble: marker-derived inline images + text.
    private var engineUserBubble: some View {
        HStack {
            Spacer(minLength: 24)
            VStack(alignment: .trailing, spacing: 4) {
                let segments = parseAttachmentSegments(message.content)
                ForEach(Array(segments.images.enumerated()), id: \.offset) { _, path in
                    InlineAttachmentImage(path: path) { img in
                        previewName = (path as NSString).lastPathComponent
                        previewImage = img
                    }
                }

                if !segments.text.isEmpty {
                    let cap = UIScreen.main.bounds.width * 0.8
                    let slash = parseSlashCommand(segments.text)
                    ViewThatFits(in: .horizontal) {
                        Group {
                            if let slash {
                                userBubbleContentWithSlash(command: slash.command, args: slash.args, isBash: false)
                            } else {
                                userBubbleContent(text: segments.text, isBash: false)
                            }
                        }
                        .fixedSize(horizontal: true, vertical: true)
                        Group {
                            if let slash {
                                userBubbleContentWithSlash(command: slash.command, args: slash.args, isBash: false)
                            } else {
                                userBubbleContent(text: segments.text, isBash: false)
                            }
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: cap, alignment: .trailing)
                }
            }
            .padding(.trailing, 12)
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func userBubbleContent(text: String, isBash: Bool) -> some View {
        Text(text)
            .textSelection(.enabled)
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

    /// Slash-command bubble: see EngineMessageRow+SlashBubble.swift for
    /// the `userBubbleContentWithSlash` implementation and the
    /// `parseSlashCommand` / `SlashCommandSegments` parser. The split
    /// keeps this file under the size cap; the call sites above
    /// (`conversationUserBubble`, `engineUserBubble`) invoke the
    /// extension method by name.

    // MARK: - Assistant

    private var assistantMessage: some View {
        Group {
            if isConversationMode {
                conversationAssistantBubble
            } else {
                engineAssistantBubble
            }
        }
    }

    /// Full conversation-view assistant message: plain inline text (no bubble),
    /// matching engine-view rendering. Overlays add blinking cursor, voice
    /// controls, copy button, timestamp, and context menu without any material
    /// background or rounded-corner wrapper.
    private var conversationAssistantBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            ZStack(alignment: .bottomTrailing) {
                ZStack(alignment: .bottomLeading) {
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

                    // Voice playback controls
                    if isSpeaking {
                        HStack(spacing: 6) {
                            Button { onSkipSpeaking?() } label: {
                                HStack(spacing: 4) {
                                    Image(systemName: "speaker.wave.2.fill")
                                        .font(.caption2)
                                        .symbolEffect(.variableColor.iterative)
                                    Image(systemName: hasPendingSpeech ? "forward.fill" : "stop.fill")
                                        .font(.caption2)
                                }
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(.ultraThinMaterial)
                                .clipShape(Capsule())
                            }

                            if hasPendingSpeech {
                                Button { onStopAllSpeaking?() } label: {
                                    HStack(spacing: 4) {
                                        Image(systemName: "stop.fill")
                                            .font(.caption2)
                                        Text("Stop All")
                                            .font(.caption2)
                                    }
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Capsule())
                                }
                            }
                        }
                        .transition(.opacity.combined(with: .scale))
                        .padding(4)
                    }
                }

                // Copy button overlay
                if showCopyButton && !isSpeaking {
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
            .frame(maxWidth: .infinity, alignment: .leading)
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

    /// Engine-view compact assistant bubble: plain markdown, no chrome.
    private var engineAssistantBubble: some View {
        HStack {
            MarkdownContentView(
                blocks: MarkdownBlockCache.shared.blocks(for: message.content)
            )
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            Spacer(minLength: 0)
        }
    }

    // MARK: - Tool

    private var toolMessage: some View {
        Group {
            if isConversationMode {
                conversationToolBubble
            } else {
                engineToolBubble
            }
        }
    }

    private var toolAccentColor: Color {
        switch message.toolStatus {
        case .running:  return .orange
        case .completed: return .green
        case .error:    return .red
        case nil:       return .gray
        }
    }

    /// Full conversation-view tool bubble: expandable input/output detail.
    private var conversationToolBubble: some View {
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
                        conversationToolStatusIcon

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

    private var conversationToolStatusIcon: some View {
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

    /// Engine-view compact tool bubble: icon + name only, no expand.
    private var engineToolBubble: some View {
        HStack(spacing: 6) {
            engineToolStatusIcon
            Text(message.toolName ?? "tool")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    @ViewBuilder
    private var engineToolStatusIcon: some View {
        switch message.toolStatus {
        case .running:
            ProgressView()
                .scaleEffect(0.6)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
        case nil:
            Image(systemName: "wrench")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Harness (engine-only)

    private var harnessMessage: some View {
        HStack(spacing: 6) {
            if let collapsed = message.bootstrapCollapsedCount, collapsed > 0 {
                Text("×\(collapsed + 1)")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color(.tertiarySystemFill))
                    .clipShape(Capsule())
            }
            Image(systemName: "gearshape.fill")
                .font(.caption2)
                .foregroundStyle(.orange.opacity(0.7))
            Text(message.content)
                .font(.caption)
                .foregroundStyle(.secondary)
                .italic()
            Spacer()
        }
        .padding(.vertical, 2)
    }

    // MARK: - System

    private var systemMessage: some View {
        Group {
            if isConversationMode {
                conversationSystemBubble
            } else {
                engineSystemBubble
            }
        }
    }

    /// Conversation-view system bubble: divider-flanked centered text.
    private var conversationSystemBubble: some View {
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

    /// Engine-view system bubble: divider-flanked for lifecycle markers (`──`
    /// prefix), plain centered text for errors/notifications/death messages.
    private var engineSystemBubble: some View {
        Group {
            if message.content.hasPrefix("──") {
                // Lifecycle divider (session-start, plan-created, implementing)
                // — render with horizontal rules matching conversationSystemBubble.
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
            } else {
                HStack {
                    Spacer()
                    Text(message.content)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Spacer()
                }
            }
        }
    }
}

// MARK: - Attachment marker parsing

/// Result of splitting a user-message body on `[Attached image: PATH]`
/// markers. `images` lists each path in source order; `text` is the body
/// with markers removed and incidental blank lines collapsed.
struct AttachmentSegments {
    var images: [String]
    var text: String
}

private let attachedImagePattern: NSRegularExpression = {
    // Path matches anything except a closing bracket so the regex stops at
    // the marker boundary rather than greedily eating the whole line.
    return try! NSRegularExpression(pattern: #"\[Attached image: ([^\]]+)\]"#)
}()

func parseAttachmentSegments(_ raw: String) -> AttachmentSegments {
    let ns = raw as NSString
    let range = NSRange(location: 0, length: ns.length)
    let matches = attachedImagePattern.matches(in: raw, range: range)
    if matches.isEmpty {
        return AttachmentSegments(images: [], text: raw)
    }
    var images: [String] = []
    var cleaned = NSMutableString(string: raw)
    for match in matches.reversed() {
        if match.numberOfRanges < 2 { continue }
        let path = ns.substring(with: match.range(at: 1))
        images.insert(path, at: 0)
        cleaned.replaceCharacters(in: match.range, with: "")
    }
    var text = cleaned as String
    // Collapse runs of blank lines that would otherwise be left behind by
    // marker removal (e.g. "[marker]\n\nactual text" → "actual text").
    while text.contains("\n\n\n") { text = text.replacingOccurrences(of: "\n\n\n", with: "\n\n") }
    text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return AttachmentSegments(images: images, text: text)
}

// MARK: - InlineAttachmentImage

/// Renders the image at `path` inline in a message bubble. Looks up bytes
/// in the local cache first; on a miss, asks the desktop for them via
/// `RemoteImageFetcher`. Renders a small placeholder while the fetch is
/// in flight or after a permanent failure (e.g. file gone on the desktop).
struct InlineAttachmentImage: View {
    let path: String
    let onTap: (UIImage) -> Void

    @Environment(SessionViewModel.self) private var viewModel
    @State private var image: UIImage?
    @State private var failed: Bool = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 220)
                    .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                    .onTapGesture { onTap(image) }
            } else {
                placeholder
            }
        }
        .onAppear { loadIfNeeded() }
        .onChange(of: path) { _, _ in
            image = nil
            failed = false
            loadIfNeeded()
        }
    }

    private var placeholder: some View {
        HStack(spacing: 4) {
            Image(systemName: failed ? "photo.badge.exclamationmark" : "photo")
                .font(.caption2)
            Text((path as NSString).lastPathComponent)
                .font(.caption2)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(.secondarySystemFill))
        .clipShape(Capsule())
        .foregroundStyle(.secondary)
    }

    private func loadIfNeeded() {
        if image != nil || failed { return }
        if let local = AttachmentImageCache.shared.image(forKey: path) {
            image = local
            return
        }
        RemoteImageFetcher.shared.request(path: path, viewModel: viewModel) { fetched in
            if let fetched {
                image = fetched
            } else {
                failed = true
            }
        }
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

// MARK: - Container Width Preference

struct ContainerWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = UIScreen.main.bounds.width
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
