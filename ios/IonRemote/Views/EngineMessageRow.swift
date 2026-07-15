import SwiftUI

// MARK: - EngineMessageRow

/// Renders a single conversation message based on role.
///
/// In engine-view usage (no extra params) it renders a compact, engine-style
/// row. In conversation-view usage the optional params unlock the full rich
/// rendering: timestamps, copy/share/rewind context menus, voice overlays,
/// blinking cursor, and attachment previews.
///
/// Tool-role rendering lives in EngineMessageRow+ToolBubble.swift.
/// Slash-command bubble + parser live in EngineMessageRow+SlashBubble.swift.
/// Utility support types live in EngineMessageRow+Support.swift.
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
    /// Tap handler for a plan-lifecycle divider's slug link. When set and the
    /// message is a "Plan created"/"Plan updated" divider carrying a
    /// planFilePath, the slug renders as a tappable link that calls this with
    /// the plan file path (the conversation view opens the plan preview).
    /// Mirrors the `onRewind` callback pattern.
    var onTapPlan: ((String) -> Void)? = nil

    // Shared state
    @State private var previewImage: UIImage?
    @State private var previewName: String = ""

    // Conversation-view-only state
    @State var isToolExpanded = false
    @State private var showRewindConfirm = false
    @State private var showCopyButton = false
    @State private var showCopiedCheck = false
    @State private var containerWidth: CGFloat = UIScreen.main.bounds.width

    /// True when operating in full conversation-view mode.
    var isConversationMode: Bool {
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
            case .thinking:
                // Extended-thinking reasoning block (issue #158). Collapsed
                // by default; ThinkingRowView owns all three render states.
                ThinkingRowView(message: message)
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
                    let slash = message.slashSegments(fallbackText: segments.text)
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
                    let slash = message.slashSegments(fallbackText: segments.text)
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
    // Tool-role rendering (toolMessage, conversationToolBubble,
    // engineToolBubble, toolAccentColor, status icons) lives in
    // EngineMessageRow+ToolBubble.swift. That extension is referenced
    // here by `toolMessage` in the body switch above.

    // MARK: - Harness (engine-only)

    private var harnessMessage: some View {
        Group {
            if let level = message.interceptLevel {
                interceptBanner(level: level)
            } else {
                defaultHarnessMessage
            }
        }
    }

    /// Intercept banner — amber/warning style for engine_intercept events.
    /// Visual weight scales with severity:
    ///   "redirect" — filled amber background, bold border (run was aborted by desktop)
    ///   "banner"   — border-only, lighter background (informational, no run change)
    private func interceptBanner(level: String) -> some View {
        let isRedirect = level == "redirect"
        return HStack(alignment: .top, spacing: 6) {
            Text("⚠️")
                .font(.caption2)
                .padding(.top, 1)
            Text(LocalizedStringKey(message.content))
                .font(.caption)
                .foregroundStyle(isRedirect ? Color(red: 0.96, green: 0.62, blue: 0.04) : .secondary)
                .multilineTextAlignment(.leading)
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(isRedirect
                    ? Color(red: 0.96, green: 0.62, blue: 0.04).opacity(0.08)
                    : Color(.secondarySystemFill))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    Color(red: 0.96, green: 0.62, blue: 0.04).opacity(isRedirect ? 0.55 : 0.3),
                    lineWidth: 1
                )
        )
        .padding(.vertical, 2)
    }

    private var defaultHarnessMessage: some View {
        HStack(spacing: 6) {
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
            PlanDividerLabel(message: message, onTapPlan: onTapPlan)
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
                // Lifecycle divider (session-start, plan-created/updated,
                // implementing) — render with horizontal rules. The plan
                // created/updated dividers render their slug as a tappable
                // link when a planFilePath + onTapPlan handler are present;
                // PlanDividerLabel owns that decision and degrades to plain
                // text for every other divider.
                HStack(spacing: 8) {
                    VStack { Divider() }
                    PlanDividerLabel(message: message, onTapPlan: onTapPlan)
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
