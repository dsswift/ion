import Foundation

/// What the conversation should present for a file link.
enum FileLinkOutcome: Equatable {
    /// Show `path` (resolved on the server) in Ion's own file viewer.
    case showText(path: String)
    /// Show this local copy in Quick Look.
    case quickLook(URL)
    /// Offer this local copy to the Files app.
    case export(URL)
    /// Nothing to show; any failure was already reported with a toast.
    case none
}
