import Foundation

/// A local copy of a server file the conversation is presenting.
struct FileLinkSheet: Identifiable {
    enum Mode { case quickLook, export }
    let mode: Mode
    let url: URL
    var id: String { "\(mode)-\(url.path)" }
}
