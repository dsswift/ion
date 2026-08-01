import SwiftUI

/// Fullscreen image preview with pinch-to-zoom, share, and save.
///
/// Two modes, one chrome. The single-image mode is the original: a caller that
/// already holds a `UIImage` hands it over and gets the zoomable viewer. The
/// paged mode takes a gallery's attachment list and a starting index, so a
/// fifty-image turn can be swiped through without dismissing and re-presenting
/// the sheet per image — the same reason the desktop viewer gained prev/next.
struct AttachmentImagePreview: View {
    /// Present in single-image mode; nil in paged mode.
    private let image: UIImage?
    /// Present in paged mode; empty in single-image mode.
    private let attachments: [MessageAttachment]
    private let name: String

    @Environment(\.dismiss) private var dismiss
    @State private var showShareSheet = false
    /// Currently displayed page in paged mode.
    @State private var index: Int
    /// Image resolved for the current page, used for share/save.
    @State private var pagedImage: UIImage?

    /// Single-image mode.
    init(image: UIImage, name: String = "") {
        self.image = image
        self.attachments = []
        self.name = name
        _index = State(initialValue: 0)
    }

    /// Paged mode over a gallery's set.
    init(attachments: [MessageAttachment], startIndex: Int) {
        self.image = nil
        self.attachments = attachments
        self.name = ""
        _index = State(initialValue: startIndex)
    }

    private var isPaged: Bool { !attachments.isEmpty }

    /// Title tracks the page in paged mode so the user always knows which
    /// image of the set they are on.
    private var title: String {
        if isPaged {
            let base = attachments.indices.contains(index) ? attachments[index].name : "Preview"
            return attachments.count > 1 ? "\(base) (\(index + 1)/\(attachments.count))" : base
        }
        return name.isEmpty ? "Preview" : name
    }

    /// What the share sheet exports: the current page, or the single image.
    private var shareImage: UIImage? { isPaged ? pagedImage : image }

    var body: some View {
        NavigationStack {
            content
                .background(Color.black)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            Haptic.light()
                            showShareSheet = true
                        } label: {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .disabled(shareImage == nil)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                    }
                }
                .sheet(isPresented: $showShareSheet) {
                    if let shareImage {
                        ShareSheet(items: [shareImage])
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if isPaged {
            TabView(selection: $index) {
                ForEach(Array(attachments.enumerated()), id: \.element.id) { pageIndex, attachment in
                    PagedPreviewImage(attachment: attachment) { resolved in
                        // Only the visible page owns the share target.
                        if pageIndex == index { pagedImage = resolved }
                    }
                    .tag(pageIndex)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: attachments.count > 1 ? .automatic : .never))
        } else if let image {
            ZoomableImageView(image: image)
        }
    }
}

/// One page of the paged preview. Resolves its bytes through the same
/// cache-first path the inline renderer uses, then hands them up so the
/// toolbar can share the image the user is actually looking at.
private struct PagedPreviewImage: View {
    let attachment: MessageAttachment
    let onResolve: (UIImage) -> Void

    @Environment(SessionViewModel.self) private var viewModel
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                ZoomableImageView(image: image)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: failed ? "photo.badge.exclamationmark" : "photo")
                        .font(.largeTitle)
                    Text(attachment.name)
                        .font(.caption)
                        .lineLimit(1)
                }
                .foregroundStyle(.secondary)
            }
        }
        .onAppear { loadIfNeeded() }
    }

    private func loadIfNeeded() {
        if image != nil || failed { return }
        if let cached = AttachmentImageCache.shared.image(forKey: attachment.id)
            ?? AttachmentImageCache.shared.image(forKey: attachment.path) {
            image = cached
            onResolve(cached)
            return
        }
        RemoteImageFetcher.shared.request(path: attachment.path, viewModel: viewModel) { fetched in
            if let fetched {
                image = fetched
                onResolve(fetched)
            } else {
                failed = true
            }
        }
    }
}

/// Pinch-to-zoom, drag-to-pan, double-tap-to-reset image surface. Extracted
/// from `AttachmentImagePreview` so the single-image and paged modes share one
/// gesture implementation instead of two that drift.
struct ZoomableImageView: View {
    let image: UIImage

    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            Image(uiImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .scaleEffect(scale)
                .offset(offset)
                .frame(width: geo.size.width, height: geo.size.height)
                .gesture(
                    MagnifyGesture()
                        .onChanged { value in
                            scale = lastScale * value.magnification
                        }
                        .onEnded { _ in
                            lastScale = max(scale, 1.0)
                            scale = lastScale
                            if scale <= 1.0 {
                                offset = .zero
                                lastOffset = .zero
                            }
                        }
                        .simultaneously(with:
                            DragGesture()
                                .onChanged { value in
                                    // Below 1x the image fits, so a drag must
                                    // stay available for the pager to consume.
                                    guard scale > 1.0 else { return }
                                    offset = CGSize(
                                        width: lastOffset.width + value.translation.width,
                                        height: lastOffset.height + value.translation.height
                                    )
                                }
                                .onEnded { _ in
                                    lastOffset = offset
                                }
                        )
                )
                .onTapGesture(count: 2) {
                    withAnimation(.easeInOut(duration: 0.25)) {
                        scale = 1.0
                        lastScale = 1.0
                        offset = .zero
                        lastOffset = .zero
                    }
                }
        }
    }
}

/// UIKit share sheet wrapped for SwiftUI.
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
