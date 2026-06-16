import SwiftUI

// MARK: - Public Helpers

/// Returns the number of unique attachments found in a conversation.
/// Merges the desktop-provided cache (complete history) with message-extracted
/// attachments (for real-time updates). Used by `ConversationStatusBar` for the badge.
func countConversationAttachments(_ messages: [Message], desktopCache: [TabAttachmentEntry]?) -> Int {
    guard let regex = try? NSRegularExpression(
        pattern: #"^\[Attached (image|file|plan): (.+)\]$"#,
        options: []
    ) else { return desktopCache?.count ?? 0 }

    var seen = Set<String>()

    for a in desktopCache ?? [] {
        seen.insert(a.path)
    }

    for message in messages where message.role == .user {
        if let attachments = message.attachments {
            for a in attachments {
                seen.insert(a.path)
            }
        }
        let lines = message.content.components(separatedBy: "\n")
        for line in lines {
            let nsLine = line as NSString
            guard let match = regex.firstMatch(
                in: line, options: [],
                range: NSRange(location: 0, length: nsLine.length)
            ), match.numberOfRanges == 3 else { break }
            let path = nsLine.substring(with: match.range(at: 2))
            seen.insert(path)
        }
    }

    return seen.count
}

// MARK: - Extracted Attachment

/// A deduplicated attachment extracted from conversation message content.
private struct ExtractedAttachment: Identifiable, Hashable {
    let id: String // path serves as unique key
    let type: AttachmentKind
    let name: String
    let path: String
    /// For `.resource` attachments, the real resource kind the producing
    /// extension declared (e.g. "briefing", "report"). Empty for other types.
    var resourceKind: String = ""

    enum AttachmentKind: String {
        case image, file, plan, resource
    }

    /// SF Symbol name for this attachment. Resource attachments are
    /// kind-agnostic: any extension-declared kind renders with a generic
    /// document glyph rather than a per-kind hardcoded icon.
    var iconName: String {
        switch type {
        case .plan:     return "doc.text"
        case .image:    return "photo"
        case .resource: return "doc.richtext"
        case .file:     return "doc"
        }
    }

    /// For resource entries, extract the resource ID from the `resource:<id>` path.
    var resourceId: String? {
        guard type == .resource, path.hasPrefix("resource:") else { return nil }
        return String(path.dropFirst("resource:".count))
    }
}

// MARK: - ConversationAttachmentsSheet

/// Sheet that lists all attachments and plans referenced in a conversation.
/// Scans user messages for `[Attached (image|file|plan): path]` markers,
/// deduplicates by path, and groups into Plans, Files, and Resources sections.
///
/// Resources are conversation-scoped items of ANY extension-declared kind,
/// delivered via the resource broker. The desktop includes them in the
/// `tab_attachments` response with type="resource", kind="<real kind>", and
/// path="resource:<id>". Content is read directly from the local
/// ResourceStore — no additional network request is needed. Nothing here is
/// hardcoded to a specific kind such as "briefing".
struct ConversationAttachmentsSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var selectedPlanPath: IdentifiablePath?
    @State private var selectedFilePath: IdentifiablePath?
    @State private var imagePreview: (image: UIImage, name: String)?
    @State private var selectedResource: ResourceItem?

    // MARK: - Computed

    private var conversationMessages: [Message] {
        viewModel.messages[tabId] ?? []
    }

    private var attachments: [ExtractedAttachment] {
        // Merge desktop-provided full list with message-extracted (real-time).
        let desktopItems = viewModel.tabAttachmentCache[tabId] ?? []
        let fromMessages = extractAttachments(from: conversationMessages)

        var seen = Set<String>()
        var result: [ExtractedAttachment] = []

        // Desktop cache first — has the complete history (including resources)
        for a in desktopItems {
            guard !seen.contains(a.path) else { continue }
            seen.insert(a.path)
            let kind: ExtractedAttachment.AttachmentKind
            switch a.type {
            case "image":    kind = .image
            case "plan":     kind = .plan
            case "resource": kind = .resource
            default:         kind = .file
            }
            result.append(ExtractedAttachment(
                id: a.path, type: kind, name: a.name, path: a.path,
                resourceKind: a.kind ?? "",
            ))
        }

        // Then message-extracted — catches anything sent after the request
        for a in fromMessages {
            guard !seen.contains(a.path) else { continue }
            seen.insert(a.path)
            result.append(a)
        }

        return result
    }

    private var plans: [ExtractedAttachment] {
        attachments.filter { $0.type == .plan }
    }

    private var resources: [ExtractedAttachment] {
        attachments.filter { $0.type == .resource }
    }

    private var files: [ExtractedAttachment] {
        attachments.filter { $0.type == .image || $0.type == .file }
    }

    // MARK: - Body

    var body: some View {
        NavigationStack {
            Group {
                if attachments.isEmpty {
                    emptyState
                } else {
                    attachmentList
                }
            }
            .navigationTitle("Attachments")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
            .fullScreenCover(item: $selectedPlanPath) { item in
                PlanContentView(path: item.path)
                    .environment(viewModel)
            }
            .fullScreenCover(item: $selectedFilePath) { item in
                FileContentView(path: item.path)
                    .environment(viewModel)
            }
            .sheet(isPresented: Binding(
                get: { imagePreview != nil },
                set: { if !$0 { imagePreview = nil } }
            )) {
                if let preview = imagePreview {
                    AttachmentImagePreview(image: preview.image, name: preview.name)
                }
            }
            .sheet(item: $selectedResource) { item in
                ResourceDetailView(item: item, resourceStore: viewModel.resourceStore, viewModel: viewModel)
            }
            .task {
                let preCacheCount = viewModel.tabAttachmentCache[tabId]?.count ?? -1
                DiagnosticLog.log("ATTACH: AttachmentsSheet.task tabId=\(tabId.prefix(8)) cacheBeforeRequest=\(preCacheCount)")
                viewModel.requestLoadAttachments(tabId: tabId)
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "paperclip")
                .font(.largeTitle)
                .foregroundStyle(.tertiary)
            Text("No attachments in this conversation")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Attachment List

    private var attachmentList: some View {
        List {
            if !plans.isEmpty {
                Section {
                    ForEach(plans) { attachment in
                        attachmentRow(attachment)
                            .onTapGesture {
                                Haptic.light()
                                viewModel.requestFsReadFile(filePath: attachment.path)
                                selectedPlanPath = IdentifiablePath(path: attachment.path)
                            }
                    }
                } header: {
                    Label("Plans", systemImage: "doc.text")
                        .foregroundStyle(.green)
                        .font(.caption.weight(.semibold))
                        .textCase(nil)
                }
            }

            if !files.isEmpty {
                Section {
                    ForEach(files) { attachment in
                        attachmentRow(attachment)
                            .onTapGesture {
                                Haptic.light()
                                if attachment.type == .image {
                                    loadImagePreview(attachment)
                                } else {
                                    viewModel.requestFsReadFile(filePath: attachment.path)
                                    selectedFilePath = IdentifiablePath(path: attachment.path)
                                }
                            }
                    }
                } header: {
                    Label("Files", systemImage: "folder")
                        .font(.caption.weight(.semibold))
                        .textCase(nil)
                }
            }

            if !resources.isEmpty {
                Section {
                    ForEach(resources) { attachment in
                        attachmentRow(attachment)
                            .onTapGesture {
                                Haptic.light()
                                openResource(attachment)
                            }
                    }
                } header: {
                    Label("Resources", systemImage: "doc.richtext")
                        .foregroundStyle(.purple)
                        .font(.caption.weight(.semibold))
                        .textCase(nil)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Row

    private func attachmentRow(_ attachment: ExtractedAttachment) -> some View {
        HStack(spacing: 12) {
            Image(systemName: attachment.iconName)
                .font(.title3)
                .foregroundStyle(attachment.type == .plan ? .green : attachment.type == .resource ? .purple : .secondary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if attachment.type != .resource {
                    Text(attachment.path)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.quaternary)
        }
        .contentShape(Rectangle())
    }

    // MARK: - Resource Tap

    /// Opens a resource by looking up its ResourceItem in the local
    /// ResourceStore. The path is `resource:<id>` — extract the ID and find
    /// the item across all kinds. `ResourceDetailView` handles on-demand
    /// content fetch if the snapshot arrived without inline content. Works for
    /// any extension-declared kind; nothing here is briefing-specific.
    private func openResource(_ attachment: ExtractedAttachment) {
        guard let resourceId = attachment.resourceId else { return }

        // Search all kinds in the resource store for this ID.
        for items in viewModel.resourceStore.items.values {
            if let item = items.first(where: { $0.id == resourceId }) {
                selectedResource = item
                return
            }
        }

        DiagnosticLog.log("ATTACHMENTS: resource not found in store id=\(resourceId.prefix(12))")
    }

    // MARK: - Image Preview

    private func loadImagePreview(_ attachment: ExtractedAttachment) {
        // Check the cache first, otherwise fetch via RemoteImageFetcher
        if let cached = AttachmentImageCache.shared.image(forKey: attachment.path) {
            imagePreview = (image: cached, name: attachment.name)
            return
        }
        RemoteImageFetcher.shared.request(
            path: attachment.path,
            viewModel: viewModel
        ) { image in
            if let image {
                imagePreview = (image: image, name: attachment.name)
            }
        }
    }

    // MARK: - Attachment Extraction

    /// Scans user messages for `[Attached (image|file|plan): path]` markers
    /// AND structured `message.attachments` arrays, then returns a deduplicated
    /// list preserving first-occurrence order.
    ///
    /// Structured attachments are available for in-session messages (set at send
    /// time). Content markers survive in JSONL and cover historical/reloaded
    /// conversations. Checking both ensures the panel updates immediately when
    /// a message is sent and still works for older sessions.
    ///
    /// Content markers are only scanned from the leading block of lines at the
    /// start of the message — the send-slice always places them there. We stop
    /// at the first non-marker line to avoid false positives from example text
    /// in plan documents or user prose that matches the marker format.
    private func extractAttachments(from messages: [Message]) -> [ExtractedAttachment] {
        guard let regex = try? NSRegularExpression(
            pattern: #"^\[Attached (image|file|plan): (.+)\]$"#,
            options: []
        ) else { return [] }

        var seen = Set<String>()
        var result: [ExtractedAttachment] = []

        func add(_ attachment: ExtractedAttachment) {
            guard !seen.contains(attachment.path) else { return }
            seen.insert(attachment.path)
            result.append(attachment)
        }

        for message in messages where message.role == .user {
            // 1. Structured attachments (available for in-session messages)
            if let attachments = message.attachments {
                for a in attachments {
                    let kind: ExtractedAttachment.AttachmentKind
                    switch a.type {
                    case .image: kind = .image
                    case .plan:  kind = .plan
                    case .file:  kind = .file
                    }
                    add(ExtractedAttachment(
                        id: a.path,
                        type: kind,
                        name: a.name,
                        path: a.path
                    ))
                }
            }

            // 2. Content markers — only scan leading lines
            let lines = message.content.components(separatedBy: "\n")
            for line in lines {
                let nsLine = line as NSString
                let match = regex.firstMatch(
                    in: line,
                    options: [],
                    range: NSRange(location: 0, length: nsLine.length)
                )
                guard let match, match.numberOfRanges == 3 else { break }

                let typeString = nsLine.substring(with: match.range(at: 1))
                let path = nsLine.substring(with: match.range(at: 2))

                let kind: ExtractedAttachment.AttachmentKind
                switch typeString {
                case "image": kind = .image
                case "plan":  kind = .plan
                default:      kind = .file
                }

                let name = (path as NSString).lastPathComponent

                add(ExtractedAttachment(
                    id: path,
                    type: kind,
                    name: name,
                    path: path
                ))
            }
        }

        return result
    }
}
