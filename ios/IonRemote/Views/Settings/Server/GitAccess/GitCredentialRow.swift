import SwiftUI

/// One git credential: its host, kind, and where it came from.
struct GitCredentialRow: View {
    let identity: GitIdentitySummary
    let serverLabel: String

    var body: some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: identity.kind == .ssh ? "key.fill" : "key.horizontal.fill")
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(identity.hostLabel)
                Text("\(GitIdentityLabels.kind(identity.kind)) · \(GitIdentityLabels.source(identity, serverLabel: serverLabel))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
