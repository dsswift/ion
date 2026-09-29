import SwiftUI

// MARK: - File links
//
// Taps and long-press menu choices on file paths in the transcript land here.
// The view model resolves the path on the server and fetches what is needed;
// this presents the result.
extension ConversationView {

    var fileLinkActions: FileLinkActions {
        FileLinkActions(
            open: { handleFileLink($0, .open) },
            preview: { handleFileLink($0, .preview) },
            download: { handleFileLink($0, .download) }
        )
    }

    func handleFileLink(_ path: String, _ request: FileLinkRequest) {
        Task { @MainActor in
            switch await viewModel.fileLinkOutcome(tabId: tabId, path: path, cwd: workingDirectory, request: request) {
            case .showText(let resolved):
                selectedFilePath = IdentifiablePath(path: resolved)
            case .quickLook(let url):
                fileLinkSheet = FileLinkSheet(mode: .quickLook, url: url)
            case .export(let url):
                fileLinkSheet = FileLinkSheet(mode: .export, url: url)
            case .none:
                break
            }
        }
    }

    @ViewBuilder
    func fileLinkLayers<C: View>(_ content: C) -> some View {
        content
            .environment(\.fileLinkActions, fileLinkActions)
            .sheet(item: $fileLinkSheet) { sheet in
                switch sheet.mode {
                case .quickLook:
                    QuickLookPreview(url: sheet.url).ignoresSafeArea()
                case .export:
                    DocumentExporter(url: sheet.url)
                }
            }
    }
}
