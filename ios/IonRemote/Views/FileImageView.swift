import SwiftUI

/// Image viewer pushed onto the NavigationStack from FileExplorerView.
/// Fetches the image on appear and shows it zoomable, or says why it cannot.
struct FileImageView: View {
    @Environment(SessionViewModel.self) private var viewModel

    let filePath: String
    let fileName: String

    @State private var image: UIImage?
    @State private var failure: String?

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Photo-viewer backdrop. Black is functional here, not decorative: a
            // neutral, uncast surround is what lets the image's own colors be judged.
            .background(Color.black) // theme-color-ok: neutral photo-viewer backdrop
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let image {
                    ToolbarItem(placement: .topBarTrailing) {
                        ShareLink(
                            item: Image(uiImage: image),
                            preview: SharePreview(fileName, image: Image(uiImage: image))
                        )
                    }
                }
            }
            .task { load() }
    }

    @ViewBuilder
    private var content: some View {
        if let image {
            ZoomableImageView(image: image)
        } else if let failure {
            VStack(spacing: 12) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.largeTitle)
                Text(failure)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                Button("Retry") { load() }
                    .buttonStyle(.bordered)
            }
            .foregroundStyle(.secondary)
            .padding()
        } else {
            ProgressView("Loading image…")
        }
    }

    private func load() {
        guard image == nil else { return }
        failure = nil
        RemoteImageFetcher.shared.request(path: filePath, viewModel: viewModel) { fetched in
            if let fetched {
                image = fetched
                return
            }
            let reason = RemoteImageFetcher.shared.failureReason(for: filePath) ?? "Could not load image"
            DiagnosticLog.log(
                "explorer image fetch failed",
                tag: "view.fileimage",
                level: .warn,
                fields: ["path": filePath, "reason": reason]
            )
            failure = reason
        }
    }
}
