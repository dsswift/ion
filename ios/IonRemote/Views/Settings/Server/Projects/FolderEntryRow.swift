import SwiftUI

/// One folder under the browsed path.
struct FolderEntryRow: View {
    let entry: EnvironmentFsBrowse.Entry

    var body: some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: entry.isGitRepo ? "arrow.triangle.branch" : "folder")
                .foregroundStyle(entry.isGitRepo ? Color.accentColor : .secondary)
                .frame(width: 22)
            Text(entry.name).lineLimit(1).truncationMode(.middle)
            Spacer()
            if entry.isGitRepo {
                Text("git")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, IonSpace.compactInset)
                    .padding(.vertical, 2) // design-geometry: chip interior, matches the other admin chips
                    .background(Color.accentColor.opacity(0.15), in: Capsule())
                    .foregroundStyle(Color.accentColor)
            }
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
    }
}
