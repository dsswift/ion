import SwiftUI

/// Presents the screen an `ion://` link opened: its confirmation, the file it
/// named, or the settings page it named. Applied once, at the app root.
struct DeepLinkPresenter: ViewModifier {
    @Environment(SessionViewModel.self) private var viewModel

    func body(content: Content) -> some View {
        content.sheet(item: presentation) { item in
            switch item {
            case .confirm(let request):
                DeepLinkConfirmSheet(request: request) { approved in
                    viewModel.answerDeepLink(request, approved: approved)
                }
            case .file(let path):
                NavigationStack {
                    FileEditorView(filePath: path, fileName: (path as NSString).lastPathComponent)
                        .toolbar { doneButton }
                }
                .environment(viewModel)
            case .settings(let pageId):
                NavigationStack {
                    DeepLinkSettingsPageView(pageId: pageId)
                        .toolbar { doneButton }
                }
                .environment(viewModel)
            }
        }
    }

    private var doneButton: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button("Done") { viewModel.deepLinkPresentation = nil }
        }
    }

    /// A confirmation dismissed any other way than its buttons is a decline,
    /// so the server is not left waiting for an answer.
    private var presentation: Binding<DeepLinkPresentation?> {
        Binding(
            get: { viewModel.deepLinkPresentation },
            set: { newValue in
                if newValue == nil, case .confirm(let request) = viewModel.deepLinkPresentation {
                    viewModel.answerDeepLink(request, approved: false)
                    return
                }
                viewModel.deepLinkPresentation = newValue
            }
        )
    }
}
