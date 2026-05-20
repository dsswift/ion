import SwiftUI

/// A pending attachment ready to be sent with a prompt.
struct PendingAttachment: Identifiable {
    let id: String
    let type: String   // "image" or "file"
    let name: String
    let path: String
    var isUploading: Bool
    var correlationId: String = ""

    var commandAttachment: CommandAttachment {
        CommandAttachment(type: type, name: name, path: path)
    }
}

/// Horizontal scroll of attachment chips with remove buttons.
/// Tapping an image chip opens a fullscreen preview.
struct AttachmentChipsView: View {
    let attachments: [PendingAttachment]
    let onRemove: (String) -> Void
    @State private var previewImage: UIImage?
    @State private var previewName: String?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachments) { attachment in
                    chipView(attachment)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
        .sheet(isPresented: Binding(
            get: { previewImage != nil },
            set: { if !$0 { previewImage = nil; previewName = nil } }
        )) {
            if let img = previewImage {
                AttachmentImagePreview(image: img, name: previewName ?? "")
            }
        }
    }

    private func chipView(_ attachment: PendingAttachment) -> some View {
        HStack(spacing: 4) {
            if attachment.isUploading {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Image(systemName: attachment.type == "image" ? "photo" : "doc")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text(attachment.name)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)

            Button {
                onRemove(attachment.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Color(.secondarySystemFill))
        .clipShape(Capsule())
        .onTapGesture {
            guard attachment.type == "image", !attachment.isUploading else { return }
            if let img = AttachmentImageCache.shared.image(forKey: attachment.id) {
                previewName = attachment.name
                previewImage = img
            }
        }
    }
}
