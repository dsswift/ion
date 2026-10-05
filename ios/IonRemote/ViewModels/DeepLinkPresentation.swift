import Foundation

/// The screen an `ion://` link asks the phone to show, set by
/// `SessionViewModel+DeepLink` and presented at the app root.
enum DeepLinkPresentation: Identifiable, Equatable {
    /// An action link waiting for an answer.
    case confirm(DeepLinkConfirmRequest)
    /// A file the server resolved; `path` is absolute on that server.
    case file(path: String)
    /// A settings page of the server the phone is connected to.
    case settings(pageId: String)

    var id: String {
        switch self {
        case .confirm(let request): return "confirm:\(request.id)"
        case .file(let path): return "file:\(path)"
        case .settings(let pageId): return "settings:\(pageId)"
        }
    }
}
