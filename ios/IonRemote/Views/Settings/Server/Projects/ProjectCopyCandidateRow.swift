import SwiftUI

/// One project another server has, with a checkmark when it will be cloned.
struct ProjectCopyCandidateRow: View {
    let candidate: ProjectCopyCandidate
    let ticked: Bool

    var body: some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(ticked ? Color.accentColor : .secondary)
                .imageScale(.large)
            VStack(alignment: .leading, spacing: 2) {
                Text(candidate.project.displayName)
                Text("from \(candidate.sourceLabel)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(candidate.remote)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(ticked ? .isSelected : [])
    }
}
