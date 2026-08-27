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
    /// Tap handler for `ion-file://` file-path links inside markdown (inline
    /// code spans that FilePathDetector recognizes). When set, tapping a
    /// path chip opens the file preview (the conversation view presents
    /// FileEditorView). Nil at compact/engine call sites — the tap is then
    /// logged and swallowed by MarkdownContentView.
    var onOpenFile: ((String) -> Void)? = nil

    // Shared state
    @State private var previewImage: UIImage?
    @State private var previewName: String = ""

    // Conversation-view-only state
    @State var isToolExpanded = false
    @State private var showRewindConfirm = false
    // Internal (not private) so the assistant-bubble extension in
    // EngineMessageRow+AssistantBubble.swift can drive the tap-to-reveal copy
    // overlay — Swift `private` is file-scoped and would be unreachable there.
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
    //
    // Internal (not private) so the assistant-bubble extension can render the
    // conversation-view timestamp.

    var relativeTimestamp: String {
        let date = Date(timeIntervalSince1970: (message.timestamp ?? 0) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Attachment preview helper

    /// Drives the row's full-screen preview sheet from a tapped thumbnail.
    /// Passed to `MessageAttachmentImages` by the user/assistant/tool bubbles.
    /// Internal (not private) so the tool-bubble extension in
    /// `EngineMessageRow+ToolBubble.swift` can pass it through as well.
    func previewAttachment(_ image: UIImage, _ name: String) {
        previewName = name
        previewImage = image
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

    /// Label for the mid-turn steer affordance, or nil for an ordinary turn.
    /// "Steer queued" while the engine has not drained it yet; "Steer" once
    /// applied (the bubble is then rendered under its divider).
    private var steerLabel: String? {
        if message.steerPending { return "Steer queued" }
        if message.steerApplied { return "Steer" }
        return nil
    }

    /// Full conversation-view user bubble: source badge, attachments, bash
    /// highlight, timestamp, context menu with rewind/fork.
    private var conversationUserBubble: some View {
        HStack {
            Spacer(minLength: 24)
            VStack(alignment: .trailing, spacing: 4) {
                // Mid-turn steer affordance. Distinguishes a steer from a
                // turn-opening prompt, which matters most once the bubble has
                // been relocated to sit under its "Steer applied" divider — it
                // no longer sits where the user typed it. Desktop parity: the
                // steer tag in MessageBubble.tsx.
                if let steerLabel {
                    Text(steerLabel)
                        .font(.caption2)
                        .foregroundStyle(message.steerPending ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tertiary))
                }

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
                    MessageAttachmentImages(attachments: attachments, alignment: .trailing, onPreview: previewAttachment)
                }

                let rawDisplayText = message.injectionKind == "structured_answer"
                    ? structuredAnswerDisplayText(message.content)
                    : message.content
                let segments = parseAttachmentSegments(rawDisplayText)
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

                if let deliveryState = message.deliveryState {
                    deliveryStateLabel(deliveryState)
                }

                Text(relativeTimestamp)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.trailing, IonSpace.contentGap)
            .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        }
        .contextMenu {
            let shareText = message.injectionKind == "structured_answer"
                ? structuredAnswerDisplayText(message.content)
                : message.content
            Button { UIPasteboard.general.string = shareText } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: shareText) {
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
                let rawDisplayText = message.injectionKind == "structured_answer"
                    ? structuredAnswerDisplayText(message.content)
                    : message.content
                let segments = parseAttachmentSegments(rawDisplayText)
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
            .padding(.trailing, IonSpace.contentGap)
            .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        }
    }

    /// User-bubble content builders (collapsible wrapper + bubble core)
    /// live in EngineMessageRow+UserBubble.swift — extracted at the size cap,
    /// mirroring the SlashBubble split below.

    /// Slash-command bubble: see EngineMessageRow+SlashBubble.swift for
    /// the `userBubbleContentWithSlash` implementation and the
    /// `parseSlashCommand` / `SlashCommandSegments` parser. The split
    /// keeps this file under the size cap; the call sites above
    /// (`conversationUserBubble`, `engineUserBubble`) invoke the
    /// extension method by name.

    // MARK: - Assistant
    // Assistant-role rendering (assistantMessage, conversationAssistantBubble,
    // engineAssistantBubble) lives in EngineMessageRow+AssistantBubble.swift.
    // That extension is referenced here by `assistantMessage` in the body
    // switch above. Extracted at the size cap to make room for the
    // conversation-surface rebuild, mirroring the ToolBubble/UserBubble splits.

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
                .padding(.top, 1) // design-geometry: sub-hairline 1pt inset; below the 4pt rhythm floor
            Text(LocalizedStringKey(message.content))
                .font(.caption)
                .foregroundStyle(isRedirect ? Color(red: 0.96, green: 0.62, blue: 0.04) : .secondary)
                .multilineTextAlignment(.leading)
            Spacer()
        }
        .padding(.horizontal, 10) // design-geometry: 10pt gap between compactGap and contentGap; off the 4pt ratio scale
        .padding(.vertical, IonSpace.compactInset)
        .background(
            RoundedRectangle(cornerRadius: IonRadius.control)
                .fill(isRedirect
                    ? Color(red: 0.96, green: 0.62, blue: 0.04).opacity(0.08)
                    : Color(.secondarySystemFill))
        )
        .overlay(
            RoundedRectangle(cornerRadius: IonRadius.control)
                .strokeBorder(
                    Color(red: 0.96, green: 0.62, blue: 0.04).opacity(isRedirect ? 0.55 : 0.3),
                    lineWidth: 1
                )
        )
        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
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
        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
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
        .padding(.horizontal, IonSpace.sectionGap)
        .padding(.vertical, IonSpace.compactInset)
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
                .padding(.horizontal, IonSpace.sectionGap)
                .padding(.vertical, IonSpace.compactInset)
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
