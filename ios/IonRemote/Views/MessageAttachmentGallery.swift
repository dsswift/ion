import SwiftUI

/// MessageAttachmentGallery — bounded rendering for a message's image
/// attachments.
///
/// ── Why this exists ─────────────────────────────────────────────────────────
/// Image attachments used to render as a `VStack` of full-width thumbnails, one
/// per image. A turn that read dozens of images — an MCP tool returning fifty
/// app screens is the case that prompted this — became an unscrollable wall in
/// the transcript. The desktop had the identical defect and the identical fix;
/// this is the iOS half of that parity pair.
///
/// A multi-image set renders as a horizontal rail of short tiles: a bounded
/// band regardless of how many images it holds. The set stays fully reachable
/// (swipe the rail, expand to a grid, tap through to the paged preview) without
/// any image dictating the row's height.
///
/// The single-image case keeps the previous full-size inline treatment: one
/// pasted screenshot reads best large, and it costs no vertical space worth
/// reclaiming.
struct MessageAttachmentGallery: View {
    /// Tiles shown in the collapsed rail before the `+N more` slot takes over.
    /// Must match the desktop's GALLERY_RAIL_CAP — both are pinned against the
    /// shared fixture at assets/gallery-parity.json (MessageAttachmentGalleryTests
    /// asserts this side; ImageGallery.test.tsx asserts the desktop side), so the
    /// same many-image conversation folds at the same point on either screen.
    static let railCap = 12
    /// Rail tile edge, points.
    private static let railTile: CGFloat = 96
    /// Expanded-grid tile edge, points.
    private static let gridTile: CGFloat = 96

    let attachments: [MessageAttachment]
    var alignment: HorizontalAlignment = .leading
    /// Invoked with the tapped attachment's index so the row can present the
    /// paged preview positioned on that image.
    let onSelect: (Int) -> Void

    @State private var expanded = false

    /// How many tiles the collapsed rail paints, and how many are folded into
    /// the `+N more` slot.
    ///
    /// Pure and free of SwiftUI so the cap arithmetic is unit-testable without
    /// mounting a view. When the set exceeds the cap the last visible slot is
    /// spent on the overflow tile itself, so the rail shows CAP-1 images plus
    /// the affordance rather than CAP images and a remainder the user has no
    /// way to reach.
    static func layout(count: Int, expanded: Bool) -> (visible: Int, overflow: Int) {
        if expanded || count <= railCap { return (visible: count, overflow: 0) }
        return (visible: railCap - 1, overflow: count - (railCap - 1))
    }

    private var layout: (visible: Int, overflow: Int) {
        Self.layout(count: attachments.count, expanded: expanded)
    }

    var body: some View {
        VStack(alignment: alignment, spacing: 4) {
            header
            if expanded {
                grid
            } else {
                rail
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text("\(attachments.count) images")
                .font(.caption2)
                .foregroundStyle(.secondary)
            if attachments.count > Self.railCap {
                Button(expanded ? "Show less" : "Show all") {
                    Haptic.light()
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                }
                .font(.caption2)
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
            }
        }
    }

    private var rail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 4) {
                ForEach(Array(attachments.prefix(layout.visible).enumerated()), id: \.element.id) { index, attachment in
                    GalleryTile(attachment: attachment, edge: Self.railTile) { onSelect(index) }
                }
                if layout.overflow > 0 {
                    overflowTile
                }
            }
            .scrollTargetLayout()
        }
        .scrollTargetBehavior(.viewAligned)
        .frame(height: Self.railTile)
    }

    private var grid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.gridTile), spacing: 4)], spacing: 4) {
            ForEach(Array(attachments.enumerated()), id: \.element.id) { index, attachment in
                GalleryTile(attachment: attachment, edge: Self.gridTile) { onSelect(index) }
            }
        }
    }

    private var overflowTile: some View {
        Button {
            Haptic.light()
            withAnimation(.easeInOut(duration: 0.2)) { expanded = true }
        } label: {
            Text("+\(layout.overflow)\nmore")
                .font(.caption2.weight(.semibold))
                .multilineTextAlignment(.center)
                .frame(width: Self.railTile, height: Self.railTile)
                .background(Color(.secondarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
    }
}

/// One square tile in the gallery. Resolves bytes through the same cache-first
/// path the inline renderer uses, so a tile that is already cached paints
/// immediately and a miss fetches from the desktop exactly once.
private struct GalleryTile: View {
    let attachment: MessageAttachment
    let edge: CGFloat
    let onTap: () -> Void

    @Environment(SessionViewModel.self) private var viewModel
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Button(action: onTap) {
            Group {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                } else {
                    placeholder
                }
            }
            .frame(width: edge, height: edge)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
        }
        .buttonStyle(.plain)
        .onAppear { loadIfNeeded() }
    }

    private var placeholder: some View {
        ZStack {
            Color(.secondarySystemFill)
            Image(systemName: failed ? "photo.badge.exclamationmark" : "photo")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func loadIfNeeded() {
        if image != nil || failed { return }
        if let cached = AttachmentImageCache.shared.image(forKey: attachment.id)
            ?? AttachmentImageCache.shared.image(forKey: attachment.path) {
            image = cached
            return
        }
        RemoteImageFetcher.shared.request(path: attachment.path, viewModel: viewModel) { fetched in
            if let fetched {
                image = fetched
            } else {
                // Genuinely-missing path (desktop rejected it) or a transient
                // transport hiccup — either way the tile is stuck on the
                // placeholder icon with no visible console on a paired device,
                // so this is the only place the operator can ever see it.
                DiagnosticLog.log(
                    "gallery tile image fetch failed",
                    tag: "view.messageattachmentgallery",
                    level: .warn,
                    fields: ["path": attachment.path, "attachmentId": attachment.id]
                )
                failed = true
            }
        }
    }
}
