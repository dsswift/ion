import SwiftUI

/// A still "loading" row for an admin list, distinct from its empty state.
/// Static on purpose: no spinner repainting while the server answers.
struct AdminLoadingRow: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "hourglass")
            .foregroundStyle(.secondary)
    }
}
