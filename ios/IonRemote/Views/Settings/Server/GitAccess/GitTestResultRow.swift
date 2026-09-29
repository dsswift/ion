import SwiftUI

/// What one URL answered to an access test.
struct GitTestResultRow: View {
    let result: EnvironmentGitTest

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: IonSpace.compactGap) {
            Image(systemName: result.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(result.ok ? .green : .red)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.url)
                    .font(.callout.monospaced())
                    .lineLimit(2)
                    .truncationMode(.middle)
                Text(result.ok
                     ? "Reachable · \(result.defaultBranch ?? "HEAD") · \(Int(result.durationMs)) ms"
                     : "Refused: \(result.error ?? "no answer")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}
