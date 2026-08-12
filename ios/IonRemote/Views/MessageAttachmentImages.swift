import SwiftUI

/// Renders a message's attachments inline in a bubble: image attachments as
/// tappable thumbnails (cache hit renders directly; cache miss fetches the
/// bytes from the desktop via `InlineAttachmentImage`), and any non-image
/// attachment as a small document chip.
///
/// Shared by the user, assistant, and tool bubbles in `EngineMessageRow`. It
/// exists so engine-generated images — provider-generated on assistant turns
/// and tool-returned on tool turns — render inline on iOS the same way the
/// desktop shows them (`deriveMessageImages`). Previously only the user bubble
/// rendered structured attachments, so an image-generation turn (empty content,
/// one image attachment) rendered as a blank row.
///
/// Two or more images render through `MessageAttachmentGallery` instead of a
/// vertical stack: a many-image turn used to produce one full-width thumbnail
/// per image and bury the rest of the transcript. The gallery owns its own
/// paged preview sheet, so tapping a tile opens the whole set rather than a
/// single frozen image. One image keeps the original inline treatment and the
/// caller's `onPreview` sheet.
struct MessageAttachmentImages: View {
    let attachments: [MessageAttachment]
    /// Trailing for the right-aligned user bubble; leading for the
    /// left-aligned assistant/tool bubbles.
    var alignment: HorizontalAlignment = .leading
    /// Invoked with the resolved image + display name when a thumbnail is
    /// tapped, so the row can drive its full-screen preview sheet. Used by the
    /// single-image path; the gallery presents its own paged preview.
    let onPreview: (UIImage, String) -> Void

    /// Index into `images` the paged preview is open on, or nil when closed.
    @State private var galleryIndex: Int?

    /// Forwarded into the paged-preview sheet. A sheet presents in a detached
    /// view hierarchy and does NOT inherit @Environment from its presenter, so
    /// every sheet in this app re-injects it explicitly (see
    /// ConversationView+Presentation.swift). The preview's pages read
    /// SessionViewModel to fetch cache-miss bytes from the desktop; without the
    /// re-injection that is a runtime trap, not a compile error.
    @Environment(SessionViewModel.self) private var viewModel

    private var images: [MessageAttachment] { attachments.filter { $0.type == .image } }
    private var others: [MessageAttachment] { attachments.filter { $0.type != .image } }

    var body: some View {
        VStack(alignment: alignment, spacing: 4) {
            if images.count > 1 {
                MessageAttachmentGallery(attachments: images, alignment: alignment) { index in
                    galleryIndex = index
                }
            } else {
                ForEach(images) { att in
                    soloImage(att)
                }
            }
            ForEach(others) { att in
                documentChip(att)
            }
        }
        .sheet(isPresented: Binding(
            get: { galleryIndex != nil },
            set: { if !$0 { galleryIndex = nil } }
        )) {
            if let index = galleryIndex {
                AttachmentImagePreview(attachments: images, startIndex: index)
                    .environment(viewModel)
            }
        }
    }

    @ViewBuilder
    private func soloImage(_ att: MessageAttachment) -> some View {
        let cached = AttachmentImageCache.shared.image(forKey: att.id)
            ?? AttachmentImageCache.shared.image(forKey: att.path)
        if let cached {
            // Cache hit — render inline thumbnail directly.
            Image(uiImage: cached)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(maxWidth: 200)
                .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                .onTapGesture { onPreview(cached, att.name) }
        } else {
            // Cache miss — fetch the bytes from the desktop. Handles the
            // in-flight placeholder and error state internally.
            InlineAttachmentImage(path: att.path) { fetched in
                onPreview(fetched, att.name)
            }
        }
    }

    private func documentChip(_ att: MessageAttachment) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "doc")
                .font(.caption2)
            Text(att.name)
                .font(.caption2)
                .lineLimit(1)
        }
        .padding(.horizontal, IonSpace.compactInset)
        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        .background(Color(.secondarySystemFill))
        .clipShape(Capsule())
        .foregroundStyle(.secondary)
    }
}
