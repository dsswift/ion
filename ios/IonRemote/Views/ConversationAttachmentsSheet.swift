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

    enum AttachmentKind: String {
        case image, file, plan
    }

    /// SF Symbol name for this attachment.
    var iconName: String {
        switch type {
        case .plan:  return "doc.text"
        case .image: return "photo"
        case .file:  return "doc"
        }
    }
}

// MARK: - ConversationAttachmentsSheet

/// Sheet that lists all attachments and plans referenced in a conversation.
/// Scans user messages for `[Attached (image|file|plan): path]` markers,
/// deduplicates by path, and groups into Plans and Files sections.
struct ConversationAttachmentsSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var selectedPlanPath: IdentifiablePath?
    @State private var selectedFilePath: IdentifiablePath?
    @State private var imagePreview: (image: UIImage, name: String)?

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

        // Desktop cache first — has the complete history
        for a in desktopItems {
            guard !seen.contains(a.path) else { continue }
            seen.insert(a.path)
            let kind: ExtractedAttachment.AttachmentKind
            switch a.type {
            case "image": kind = .image
            case "plan":  kind = .plan
            default:      kind = .file
            }
            result.append(ExtractedAttachment(id: a.path, type: kind, name: a.name, path: a.path))
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

    private var files: [ExtractedAttachment] {
        attachments.filter { $0.type != .plan }
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
            .task {
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
        }
        .listStyle(.insetGrouped)
    }

    // MARK: - Row

    private func attachmentRow(_ attachment: ExtractedAttachment) -> some View {
        HStack(spacing: 12) {
            Image(systemName: attachment.iconName)
                .font(.title3)
                .foregroundStyle(attachment.type == .plan ? .green : .secondary)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Text(attachment.path)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.quaternary)
        }
        .contentShape(Rectangle())
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

// MARK: - IdentifiablePath

/// Wrapper to make a file path usable with `.fullScreenCover(item:)`.
private struct IdentifiablePath: Identifiable {
    let path: String
    var id: String { path }
}

// MARK: - Plan Content View

/// Full-screen viewer for a plan attachment.
/// Loads content via `requestFsReadFile` and delegates rendering to `PlanFullScreenView`.
private struct PlanContentView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let path: String

    private var isLoading: Bool {
        viewModel.fileContentLoading.contains(path)
    }

    private var fileResponse: FsFileContentResponse? {
        viewModel.fileContent[path]
    }

    var body: some View {
        Group {
            if let response = fileResponse {
                if let error = response.error {
                    errorView(error)
                } else if let content = response.content {
                    PlanFullScreenView(content: content)
                } else {
                    errorView("No content available")
                }
            } else if isLoading {
                loadingView
            } else {
                loadingView
                    .task {
                        viewModel.requestFsReadFile(filePath: path)
                    }
            }
        }
    }

    private var loadingView: some View {
        NavigationStack {
            ProgressView("Loading plan…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle("Plan")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                            .fontWeight(.semibold)
                    }
                }
        }
    }

    private func errorView(_ message: String) -> some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }
}

// MARK: - File Content View

/// Full-screen viewer for a file attachment.
/// Displays the raw content with line numbers in a monospaced font.
private struct FileContentView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let path: String

    private var fileName: String {
        (path as NSString).lastPathComponent
    }

    private var isLoading: Bool {
        viewModel.fileContentLoading.contains(path)
    }

    private var fileResponse: FsFileContentResponse? {
        viewModel.fileContent[path]
    }

    private var isMarkdown: Bool {
        let ext = (fileName as NSString).pathExtension.lowercased()
        return ext == "md" || ext == "markdown" || ext == "mdx"
    }

    private var isImage: Bool {
        let ext = (fileName as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].contains(ext)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let response = fileResponse {
                    if let error = response.error {
                        errorView(error)
                    } else if let content = response.content {
                        contentView(content)
                    } else {
                        errorView("No content available")
                    }
                } else if isLoading {
                    ProgressView("Loading file…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView("Loading file…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task {
                            viewModel.requestFsReadFile(filePath: path)
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

    // MARK: - Content

    @ViewBuilder
    private func contentView(_ content: String) -> some View {
        if isMarkdown {
            ScrollView {
                MarkdownContentView(blocks: MarkdownFormatter.parse(content))
                    .textSelection(.enabled)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            ScrollView(.horizontal) {
                ScrollView(.vertical) {
                    HStack(alignment: .top, spacing: 0) {
                        // Line number gutter
                        let lines = content.components(separatedBy: "\n")
                        VStack(alignment: .trailing, spacing: 0) {
                            ForEach(1...max(lines.count, 1), id: \.self) { lineNum in
                                Text("\(lineNum)")
                                    .font(.system(.caption, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                    .frame(height: 20)
                            }
                        }
                        .padding(.top, 8)
                        .padding(.horizontal, 4)
                        .frame(width: 40)
                        .background(Color(.secondarySystemBackground))

                        Text(content)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 8)
                    }
                }
            }
        }
    }

    // MARK: - Error

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
