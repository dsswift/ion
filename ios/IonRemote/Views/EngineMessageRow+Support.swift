import SwiftUI

// MARK: - EngineMessageRow support types
//
// Extracted from `EngineMessageRow.swift` to keep that file under the 600-line
// cap. Contains four utility types that support message row rendering but are
// not part of the core view hierarchy:
//
//   - AttachmentSegments / parseAttachmentSegments — splits `[Attached image: PATH]`
//     markers out of a user-message body.
//   - InlineAttachmentImage — renders a remote image inline, fetching on miss.
//   - BlinkingModifier — animates a streaming cursor.
//   - Color(hex:) — hex-based Color initialiser used by bubble chrome.
//   - MarkdownBlockCache — caches parsed MarkdownBlock arrays per content string.
//   - ContainerWidthKey — PreferenceKey for container-width propagation.

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

/// Matches the encoder-rewritten marker produced by attachment-encoder.ts
/// after a successful encode: `[Attachment: NAME (content attached)]`.
/// No path is embedded in this form — the image data rode the wire as a
/// base64 payload to the engine. Strip the marker so it never renders as
/// literal text in the user bubble; structured message.attachments handles
/// display.
private let contentAttachedPattern: NSRegularExpression = {
    return try! NSRegularExpression(pattern: #"\[Attachment: [^\]]+ \(content attached\)\]"#)
}()

func parseAttachmentSegments(_ raw: String) -> AttachmentSegments {
    let ns = raw as NSString
    let range = NSRange(location: 0, length: ns.length)
    let matches = attachedImagePattern.matches(in: raw, range: range)

    // When neither marker form is present, return early without allocation.
    let contentAttachedRange = NSRange(location: 0, length: ns.length)
    let hasContentAttached = !contentAttachedPattern.matches(in: raw, range: contentAttachedRange).isEmpty
    if matches.isEmpty && !hasContentAttached {
        return AttachmentSegments(images: [], text: raw)
    }

    var images: [String] = []
    var cleaned = NSMutableString(string: raw)

    // Pass 1: extract image paths from [Attached image: PATH] markers and
    // remove them from the text.
    for match in matches.reversed() {
        if match.numberOfRanges < 2 { continue }
        let path = ns.substring(with: match.range(at: 1))
        images.insert(path, at: 0)
        cleaned.replaceCharacters(in: match.range, with: "")
    }

    var text = cleaned as String

    // Pass 2: strip [Attachment: NAME (content attached)] markers — the
    // encoder-rewritten form produced by attachment-encoder.ts after the
    // image data was base64-encoded and sent inline to the engine. No path
    // is recoverable from this form; strip it so it never renders as literal
    // text in the user bubble. Structured message.attachments carries display.
    let textRange = NSRange(location: 0, length: (text as NSString).length)
    text = contentAttachedPattern.stringByReplacingMatches(
        in: text, range: textRange, withTemplate: ""
    )

    // Collapse blank lines left behind by marker removal.
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
