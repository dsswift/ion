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
struct MessageAttachmentImages: View {
    let attachments: [MessageAttachment]
    /// Trailing for the right-aligned user bubble; leading for the
    /// left-aligned assistant/tool bubbles.
    var alignment: HorizontalAlignment = .leading
    /// Invoked with the resolved image + display name when a thumbnail is
    /// tapped, so the row can drive its full-screen preview sheet.
    let onPreview: (UIImage, String) -> Void

    var body: some View {
        VStack(alignment: alignment, spacing: 4) {
            ForEach(attachments) { att in
                let cached = AttachmentImageCache.shared.image(forKey: att.id)
                    ?? AttachmentImageCache.shared.image(forKey: att.path)
                if att.type == .image, let cached {
                    // Cache hit — render inline thumbnail directly.
                    Image(uiImage: cached)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: 200)
                        .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                        .onTapGesture { onPreview(cached, att.name) }
                } else if att.type == .image {
                    // Cache miss — fetch the bytes from the desktop. Handles the
                    // in-flight placeholder and error state internally.
                    InlineAttachmentImage(path: att.path) { fetched in
                        onPreview(fetched, att.name)
                    }
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "doc")
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
}
