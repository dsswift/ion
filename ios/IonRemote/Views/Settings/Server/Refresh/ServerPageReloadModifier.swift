import SwiftUI

/// Registers a section's reload with the server page's pull to refresh while
/// the view it modifies is on screen.
struct ServerPageReloadModifier: ViewModifier {
    let id: String
    let reload: ServerPageRefresh.Reload

    @Environment(\.serverPageRefresh) private var refresh

    func body(content: Content) -> some View {
        content
            .onAppear { refresh?.register(id, reload: reload) }
            .onDisappear { refresh?.unregister(id) }
    }
}

extension View {
    /// Reloads this section's data when the server page is pulled to refresh.
    /// Put it on one row, the one that runs the section's first load: a
    /// modifier on a view of several rows applies to each row.
    func reloadsWithServerPage(_ id: String, reload: @escaping ServerPageRefresh.Reload) -> some View {
        modifier(ServerPageReloadModifier(id: id, reload: reload))
    }
}
