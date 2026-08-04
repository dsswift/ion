import SwiftUI

/// Per-page resolved-image store for the paged preview's share/save target.
///
/// ── Why this exists (the blocker this fixes) ────────────────────────────────
/// The original design held a single `pagedImage: UIImage?` gated by
/// `if pageIndex == index`. That drops the resolved image in two deterministic
/// ways: (1) swipe forward then back to a page whose image already resolved —
/// `loadIfNeeded` early-returns once `image != nil`, so it never calls
/// `onResolve` again, and `pagedImage` keeps whatever the LAST page resolved,
/// so Share exports a different image than what's on screen; (2) a cache-miss
/// fetch that lands after the user has swiped away — the index check fails,
/// the resolve is dropped, and because `loadIfNeeded` won't re-run, it is
/// dropped permanently, leaving Share disabled for a page that is visibly
/// rendered. Keying by index instead of gating on "is this the current page
/// right now" fixes both: every page's resolve is recorded unconditionally,
/// and the share target is read back by whichever index is current.
struct PagedPreviewState {
    private var resolved: [Int: UIImage] = [:]

    /// Records a page's resolved image. Called unconditionally by every page,
    /// regardless of whether it is the one currently visible.
    mutating func record(_ image: UIImage, at index: Int) {
        resolved[index] = image
    }

    /// The resolved image for `index`, or nil if that page hasn't resolved yet.
    func current(index: Int) -> UIImage? {
        resolved[index]
    }
}

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
    /// Every page's resolved image, keyed by index — see PagedPreviewState.
    @State private var pageImages = PagedPreviewState()

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

    /// What the share sheet exports: the CURRENT page's resolved image, or the
    /// single image. Reading `pageImages.current(index:)` (rather than a
    /// single stored value) means this always reflects whichever page is
    /// actually on screen, even after swiping past pages that resolved out of
    /// order.
    private var shareImage: UIImage? { isPaged ? pageImages.current(index: index) : image }

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
                        // Record unconditionally, regardless of whether this
                        // page is the one currently visible — see
                        // PagedPreviewState's doc comment for why the old
                        // "only if pageIndex == index" gate silently dropped
                        // resolves.
                        pageImages.record(resolved, at: pageIndex)
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
                // Genuinely-missing path or a transient transport hiccup —
                // either way the page is stuck on the placeholder with no
                // visible console on a paired device, so this is the only
                // place the operator can ever see it.
                DiagnosticLog.log(
                    "paged preview image fetch failed",
                    tag: "view.attachmentimagepreview",
                    level: .warn,
                    fields: ["path": attachment.path, "attachmentId": attachment.id]
                )
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
