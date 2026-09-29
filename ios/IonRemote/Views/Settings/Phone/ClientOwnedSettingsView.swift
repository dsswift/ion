import SwiftUI

/// A page of settings this phone keeps itself (Personal and Device scope),
/// as the connected server's schema describes them: one section per section
/// of the page, then any content of the page's own. The values live on this
/// phone and stay the same on every server.
struct ClientOwnedSettingsView<Extra: View>: View {
    let page: PhoneSettingsPage
    @ViewBuilder var extra: () -> Extra

    var body: some View {
        List {
            extra()
            ClientOwnedSettingsSections(page: page)
        }
        .navigationTitle(page.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

extension ClientOwnedSettingsView where Extra == EmptyView {
    init(page: PhoneSettingsPage) {
        self.init(page: page, extra: { EmptyView() })
    }
}
