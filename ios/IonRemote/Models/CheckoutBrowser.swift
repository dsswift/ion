import Foundation

/// A request to browse one checkout directory outside any conversation: its
/// files, or its git state.
struct CheckoutBrowser: Identifiable, Equatable {
    enum Surface: String, CaseIterable {
        case files
        case git

        var title: String {
            switch self {
            case .files: return "Files"
            case .git: return "Changes"
            }
        }

        var systemImage: String {
            switch self {
            case .files: return "folder"
            case .git: return "plus.forwardslash.minus"
            }
        }
    }

    let surface: Surface
    let directory: String

    var id: String { "\(surface.rawValue):\(directory)" }

    /// The surfaces a checkout can be browsed through. Files are always
    /// offered; the git pane only where the server offers a part of it.
    static func surfaces(offered: DeveloperSurfaces) -> [Surface] {
        offered.gitPaneOffered ? [.files, .git] : [.files]
    }
}
