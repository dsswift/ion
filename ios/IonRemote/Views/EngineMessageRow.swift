import SwiftUI

// MARK: - EngineMessageRow

/// Renders a single engine conversation message based on role.
struct EngineMessageRow: View {
    let message: EngineMessage
    @State private var previewImage: UIImage?
    @State private var previewName: String = ""

    var body: some View {
        Group {
            switch message.role {
            case "user":
                userMessage
            case "assistant":
                assistantMessage
            case "harness":
                harnessMessage
            case "tool":
                toolMessage
            default:
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
    }

    /// Splits the user message text on `[Attached image: PATH]` markers so
    /// each image renders inline above the cleaned text. Bytes are looked up
    /// in the local `AttachmentImageCache` by path — populated at upload time
    /// and surviving conversation rehydration without a wire-side change to
    /// `EngineMessage`.
    private var userMessage: some View {
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
                    // ViewThatFits picks the first candidate that fits in the
                    // proposed width. The first uses .fixedSize so short text
                    // stays at its intrinsic width (and intrinsic height —
                    // text + padding, not stretched). The second falls back
                    // to filling the cap and wrapping for long text. Both
                    // candidates pin vertical size to ideal so the bubble
                    // never bloats above what the text needs.
                    ViewThatFits(in: .horizontal) {
                        userBubbleContent(text: segments.text)
                            .fixedSize(horizontal: true, vertical: true)
                        userBubbleContent(text: segments.text)
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
    private func userBubbleContent(text: String) -> some View {
        // Layout: Text drives height; the accent stripe rides as an overlay so
        // it inherits the bubble's height instead of pushing it. Putting the
        // accent in the HStack as a sibling Shape (no height constraint) made
        // the HStack request all available vertical space — bubble bloated to
        // the height of the inline image above it.
        Text(text)
            .textSelection(.enabled)
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .padding(.vertical, 8)
            .background(
                ZStack {
                    Color(.tertiarySystemBackground)
                    IonTheme.userBubbleTint
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.large))
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(IonTheme.accent)
                    .frame(width: 2.5)
                    .padding(.vertical, 4)
                    .padding(.leading, 1)
            }
    }

    private var assistantMessage: some View {
        HStack {
            MarkdownContentView(
                blocks: MarkdownBlockCache.shared.blocks(for: message.content)
            )
            .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

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

    private var toolMessage: some View {
        HStack(spacing: 6) {
            toolStatusIcon
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
    private var toolStatusIcon: some View {
        switch message.toolStatus {
        case "running":
            ProgressView()
                .scaleEffect(0.6)
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.green)
        case "error":
            Image(systemName: "xmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
        default:
            Image(systemName: "wrench")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var systemMessage: some View {
        HStack {
            Spacer()
            Text(message.content)
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
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
