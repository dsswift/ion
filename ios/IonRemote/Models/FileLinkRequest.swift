import Foundation

/// What the operator asked for on a file link.
enum FileLinkRequest: String {
    /// A tap: preview what the phone can show, download anything else.
    case open
    case preview
    case download
}
