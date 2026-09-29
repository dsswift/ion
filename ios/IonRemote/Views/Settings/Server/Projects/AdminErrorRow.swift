import SwiftUI

/// A failure an admin screen shows the person, in the server's own words.
struct AdminErrorRow: View {
    let message: String

    var body: some View {
        Label {
            Text(message).font(.callout)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
    }
}
