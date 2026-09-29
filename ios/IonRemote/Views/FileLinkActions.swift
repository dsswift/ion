import SwiftUI

/// What a file link in message text can do, supplied by the conversation that
/// shows it. Each closure takes the path as the message wrote it.
struct FileLinkActions {
    /// A tap: preview what the phone can show, download anything else.
    let open: (String) -> Void
    let preview: (String) -> Void
    let download: (String) -> Void
}

private struct FileLinkActionsKey: EnvironmentKey {
    static let defaultValue: FileLinkActions? = nil
}

extension EnvironmentValues {
    /// Nil outside a conversation: a file link there offers only Copy Path.
    var fileLinkActions: FileLinkActions? {
        get { self[FileLinkActionsKey.self] }
        set { self[FileLinkActionsKey.self] = newValue }
    }
}
